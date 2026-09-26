import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  buildFilterClause,
  CustomQueryError,
  getCustomEvents,
  mapCustomEvent,
  type StoredContractSchema,
  type StoredSchemaEvent,
} from './customEvents';

const CONTRACT = 'CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ';

const transferEvent: StoredSchemaEvent = {
  name: 'transfer',
  topic: 'transfer',
  fields: [
    { name: 'from', type: 'address', source: 'topic[1]' },
    { name: 'to', type: 'address', source: 'topic[2]' },
    { name: 'amount', type: 'i128', source: 'value.amount' },
  ],
};

const schema: StoredContractSchema = { contractId: CONTRACT, version: 1, events: [transferEvent] };

interface Recorded {
  sql: string;
  params: unknown[];
}

/** A pool that answers the schema lookup, then records the event query. */
function fakePool(rows: unknown[] = []) {
  const calls: Recorded[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM contract_schemas')) {
        return { rows: [{ definition: schema }] };
      }
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

// ── Filter construction ────────────────────────────────────────────────────

test('an equality filter binds the field name as a parameter, never as SQL', () => {
  const params: unknown[] = [];
  const clauses = buildFilterClause(transferEvent, [{ field: 'from', op: 'EQ', value: 'GFROM' }], params);

  // This is the security property of the whole feature: field names come from a
  // third-party schema and must never be concatenated into the statement.
  assert.deepEqual(clauses, ['fields->>$1 = $2']);
  assert.deepEqual(params, ['from', 'GFROM']);
});

test('a numeric filter casts both sides to numeric', () => {
  const params: unknown[] = [];
  const clauses = buildFilterClause(
    transferEvent,
    [{ field: 'amount', op: 'GT', value: '1000' }],
    params
  );

  // `numeric`, not bigint: an i128 exceeds every fixed-width integer type
  // Postgres has, and numeric compares it exactly.
  assert.deepEqual(clauses, ['(fields->>$1)::numeric > $2::numeric']);
  assert.deepEqual(params, ['amount', '1000']);
});

test('numbering stays correct across several filters', () => {
  const params: unknown[] = ['already', 'there'];
  const clauses = buildFilterClause(
    transferEvent,
    [
      { field: 'from', op: 'EQ', value: 'GFROM' },
      { field: 'amount', op: 'GTE', value: '5' },
    ],
    params
  );

  assert.deepEqual(clauses, ['fields->>$3 = $4', '(fields->>$5)::numeric >= $6::numeric']);
  assert.equal(params.length, 6);
});

test('every whitelisted operator maps to its SQL form', () => {
  for (const [op, sql] of [
    ['EQ', '='],
    ['NE', '<>'],
    ['GT', '>'],
    ['GTE', '>='],
    ['LT', '<'],
    ['LTE', '<='],
  ] as const) {
    const params: unknown[] = [];
    const clause = buildFilterClause(transferEvent, [{ field: 'amount', op, value: '1' }], params)[0] ?? '';
    assert.ok(clause.includes(` ${sql} `), `${op} should produce ${sql}, got ${clause}`);
  }
});

test('an unknown field is rejected and the available ones are named', () => {
  assert.throws(
    () => buildFilterClause(transferEvent, [{ field: 'nonexistent', op: 'EQ', value: 'x' }], []),
    (err: unknown) => {
      assert.ok(err instanceof CustomQueryError);
      assert.match(err.message, /Unknown field "nonexistent"/);
      assert.match(err.message, /Available: from, to, amount/);
      return true;
    }
  );
});

test('an operator outside the whitelist cannot reach the statement', () => {
  for (const op of ['LIKE', 'IS', '; DROP TABLE custom_events; --', '']) {
    assert.throws(
      () => buildFilterClause(transferEvent, [{ field: 'from', op, value: 'x' }], []),
      CustomQueryError,
      `operator ${JSON.stringify(op)} should be rejected`
    );
  }
});

test('ordered comparison is refused on a non-numeric field', () => {
  // `>` on an address would silently do a lexicographic comparison, which is
  // never what anyone means.
  assert.throws(
    () => buildFilterClause(transferEvent, [{ field: 'from', op: 'GT', value: 'GFROM' }], []),
    (err: unknown) => {
      assert.ok(err instanceof CustomQueryError);
      assert.match(err.message, /needs a numeric field; "from" is address/);
      return true;
    }
  );
});

test('equality is still allowed on a non-numeric field', () => {
  assert.doesNotThrow(() =>
    buildFilterClause(transferEvent, [{ field: 'from', op: 'EQ', value: 'GFROM' }], [])
  );
});

test('a non-integer value for a numeric field is rejected before it reaches the cast', () => {
  // Otherwise Postgres raises a cast error at query time, which surfaces as a
  // 500 rather than a message naming the offending filter.
  for (const value of ['abc', '1.5', '1e10', '', "1'; DROP TABLE custom_events; --"]) {
    assert.throws(
      () => buildFilterClause(transferEvent, [{ field: 'amount', op: 'GT', value }], []),
      CustomQueryError,
      `value ${JSON.stringify(value)} should be rejected`
    );
  }
});

test('a negative integer is a valid numeric filter', () => {
  const params: unknown[] = [];
  buildFilterClause(transferEvent, [{ field: 'amount', op: 'LT', value: '-5' }], params);
  assert.deepEqual(params, ['amount', '-5']);
});

// ── Query assembly ─────────────────────────────────────────────────────────

test('getCustomEvents scopes to the contract and event', async () => {
  const { pool, calls } = fakePool();

  await getCustomEvents(pool, { network: 'mainnet', contractId: CONTRACT, event: 'transfer', limit: 20 });

  const query = calls[1]!;
  assert.match(query.sql, /FROM custom_events/);
  assert.match(query.sql, /contract_id = \$1/);
  assert.match(query.sql, /event_name = \$2/);
  assert.deepEqual(query.params.slice(0, 2), [CONTRACT, 'transfer']);
  assert.equal(query.params.at(-1), 20, 'limit is the last bound parameter');
});

test('getCustomEvents rejects a contract with no registered schema', async () => {
  const pool = {
    query: async () => ({ rows: [] }),
  } as unknown as Pool;

  await assert.rejects(
    () => getCustomEvents(pool, { network: 'mainnet', contractId: CONTRACT, event: 'transfer', limit: 20 }),
    (err: unknown) => {
      assert.ok(err instanceof CustomQueryError);
      assert.match(err.message, /No custom schema registered/);
      return true;
    }
  );
});

test('getCustomEvents rejects an event the schema does not declare', async () => {
  const { pool } = fakePool();

  await assert.rejects(
    () => getCustomEvents(pool, { network: 'mainnet', contractId: CONTRACT, event: 'mint', limit: 20 }),
    (err: unknown) => {
      assert.ok(err instanceof CustomQueryError);
      assert.match(err.message, /has no event "mint"/);
      assert.match(err.message, /Available: transfer/);
      return true;
    }
  );
});

test('a cursor adds keyset pagination rather than an offset', async () => {
  const { pool, calls } = fakePool();

  await getCustomEvents(pool, { network: 'mainnet', contractId: CONTRACT, event: 'transfer', limit: 5, cursor: 'evt9' });

  assert.match(calls[1]!.sql, /\(ledger, event_id\) </);
  assert.ok(calls[1]!.params.includes('evt9'));
});

test('results are mapped with each value carrying its declared type', () => {
  const mapped = mapCustomEvent(
    {
      event_id: 'evt1',
      contract_id: CONTRACT,
      event_name: 'transfer',
      ledger: '500',
      created_at: new Date('2026-01-01T00:00:00Z'),
      schema_version: 2,
      fields: { from: 'GFROM', to: 'GTO', amount: '1208925819614629174706176' },
    },
    transferEvent
  );

  assert.equal(mapped.ledger, 500, 'bigint columns arrive as strings from pg');
  assert.equal(mapped.createdAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(mapped.fields, [
    { name: 'from', type: 'address', value: 'GFROM' },
    { name: 'to', type: 'address', value: 'GTO' },
    // Kept as text: this value has no exact double representation.
    { name: 'amount', type: 'i128', value: '1208925819614629174706176' },
  ]);
});

test('a field the stored row lacks is surfaced as an explicit null', () => {
  const mapped = mapCustomEvent(
    {
      event_id: 'evt1',
      contract_id: CONTRACT,
      event_name: 'transfer',
      ledger: 500,
      created_at: new Date('2026-01-01T00:00:00Z'),
      schema_version: 1,
      fields: { from: 'GFROM' },
    },
    transferEvent
  );

  // The schema drives the field list, so a client always sees every declared
  // field rather than having to guess whether one was omitted.
  assert.deepEqual(mapped.fields.map(f => f.value), ['GFROM', null, null]);
});
