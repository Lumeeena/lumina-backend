import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchema } from 'graphql';
import type { Pool } from 'pg';
import { getAccounts, getEventsByContract, getLedgers, getOperations, getTransactions } from './db';
import { getCustomEvents } from './customEvents';
import { getOperationsByAsset, searchTransactions } from './search';
import {
  cursorCondition,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  keysetFor,
  KEYSETS,
  pageInfo,
  type Keyset,
} from './pagination';

// ── Encoding ─────────────────────────────────────────────────────────────────

test('a cursor round-trips through its encoding', () => {
  const cursor = [900, 'abc'];
  assert.deepEqual(decodeCursor(encodeCursor('transactions', cursor), 'transactions', 2), cursor);
});

test('a cursor is opaque base64url, not a readable tuple', () => {
  const encoded = encodeCursor('transactions', [900, 'abc']);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.ok(!encoded.includes('900'));
  assert.ok(!encoded.includes('transactions'));
});

test('a cursor names the query that issued it', () => {
  // Same arity, different query: without the tag this would compare a ledger and
  // a hash against a ledger and an id and resume somewhere plausible and wrong.
  const cursor = encodeCursor('transactions', [900, 'abc']);
  assert.throws(() => decodeCursor(cursor, 'events', 2), /issued by `transactions`, not by `events`/);
});

// ── Rejection ────────────────────────────────────────────────────────────────

test('a cursor this server did not issue is rejected', () => {
  assert.throws(() => decodeCursor('not-base64-at-all!!', 'ledgers', 1), InvalidCursorError);
  // Decodes to valid JSON, but not the envelope a cursor is.
  assert.throws(() => decodeCursor(Buffer.from('{}').toString('base64url'), 'ledgers', 1), InvalidCursorError);
  assert.throws(() => decodeCursor(Buffer.from('[900]').toString('base64url'), 'ledgers', 1), InvalidCursorError);
  assert.throws(
    () => decodeCursor(Buffer.from('{"q":"ledgers","k":[null]}').toString('base64url'), 'ledgers', 1),
    InvalidCursorError
  );
});

test('a cursor with the wrong number of sort keys is rejected', () => {
  assert.throws(() => decodeCursor(encodeCursor('ledgers', [900, 'abc']), 'ledgers', 1), InvalidCursorError);
  assert.throws(() => decodeCursor(encodeCursor('transactions', [900]), 'transactions', 2), InvalidCursorError);
});

test('an invalid cursor carries a code a client can branch on', () => {
  try {
    decodeCursor('garbage!!', 'ledgers', 1);
    assert.fail('expected a rejection');
  } catch (err) {
    assert.ok(err instanceof InvalidCursorError);
    assert.equal(err.extensions['code'], 'INVALID_CURSOR');
  }
});

// ── Binding ──────────────────────────────────────────────────────────────────

test('a keyset binds its values after the parameters already in the list', () => {
  const params: unknown[] = ['mainnet'];
  const condition = cursorCondition(params, KEYSETS.transactions, encodeCursor('transactions', [900, 'abc']));

  assert.equal(condition, '(ledger, hash) < ($2::bigint, $3::text)');
  assert.deepEqual(params, ['mainnet', 900, 'abc']);
});

test('no cursor means no condition and nothing bound', () => {
  const params: unknown[] = ['mainnet'];
  assert.equal(cursorCondition(params, KEYSETS.transactions, null), null);
  assert.equal(cursorCondition(params, KEYSETS.transactions), null);
  assert.deepEqual(params, ['mainnet']);
});

test('a keyset casts every value to the type of the column it is compared with', () => {
  // Postgres sorts '9' after '10', so a bigint key bound without a cast would
  // resume in the wrong place for every two-digit sequence.
  const params: unknown[] = [];
  assert.equal(
    cursorCondition(params, KEYSETS.ledgers, encodeCursor('ledgers', [9])),
    '(sequence) < ($1::bigint)'
  );
});

test('every keyset declares a type for every column it compares', () => {
  for (const keyset of Object.values(KEYSETS)) {
    assert.equal(keyset.columns.length, keyset.types.length, `${keyset.query}: every column needs a type`);
    // The width the cursor check enforces has to be the width the SQL compares.
    assert.equal(keysetFor(keyset.query).query, keyset.query);
  }
  assert.throws(() => keysetFor('nope'), /No keyset is declared/);
});

// ── PageInfo ─────────────────────────────────────────────────────────────────

test('pageInfo points at the last row of a full page', () => {
  const items = [{ ledger: 2, hash: 'a' }, { ledger: 1, hash: 'b' }];
  const info = pageInfo(KEYSETS.transactions, items, 2, item => [item.ledger, item.hash]);

  assert.deepEqual(info, { hasNextPage: true, cursor: encodeCursor('transactions', [1, 'b']) });
  // The cursor it mints is one its own query accepts — the round trip every
  // pageInfo depends on.
  assert.deepEqual(decodeCursor(info.cursor!, 'transactions', 2), [1, 'b']);
});

test('a short page reports no next page but still hands back a usable cursor', () => {
  // A client that pages anyway gets the empty page that means it is done, which
  // is not an error.
  const info = pageInfo(KEYSETS.transactions, [{ ledger: 5, hash: 'a' }], 2, item => [item.ledger, item.hash]);

  assert.equal(info.hasNextPage, false);
  assert.equal(info.cursor, encodeCursor('transactions', [5, 'a']));
});

test('an empty page is the end of the data, not a cursor to follow', () => {
  const info = pageInfo(KEYSETS.ledgers, [], 20, (item: { sequence: number }) => item.sequence);

  assert.deepEqual(info, { hasNextPage: false, cursor: null });
});

test('a resolver minting the wrong number of sort keys fails loudly', () => {
  assert.throws(
    () => pageInfo(KEYSETS.transactions, [{ hash: 'a' }], 20, item => item.hash),
    /cursor has 1 sort keys but its keyset has 2/
  );
});

// ── One contract, every query ───────────────────────────────────────────────

/** A pool that answers the schema lookup, then anything else with `rows`. */
function fakePool(rows: unknown[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM contract_schemas')) {
        return {
          rows: [{
            definition: {
              contractId: 'CABC',
              version: 1,
              events: [{ name: 'transfer', topic: 'transfer', fields: [{ name: 'from', type: 'address', source: 'topic[1]' }] }],
            },
          }],
        };
      }
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

const CONTRACT = 'CABC';

/**
 * Every paginated query, each taking a cursor.
 *
 * The tests below run this table end to end, so a query added without a cursor
 * contract fails them rather than quietly behaving like the old conventions.
 */
const paginatedQueries: {
  /** GraphQL field, as it appears in the schema. */
  name: string;
  /** A second path through the same field, named for test output. */
  variant?: string;
  /** The keyset the listing keysets on, which is what its cursors hold. */
  keyset: Keyset;
  run: (pool: Pool, cursor: string) => Promise<unknown[]>;
}[] = [
  { name: 'transactions', keyset: KEYSETS.transactions, run: (pool, cursor) => getTransactions(pool, 'mainnet', 20, cursor) },
  { name: 'operations', keyset: KEYSETS.operations, run: (pool, cursor) => getOperations(pool, { network: 'mainnet', limit: 20, cursor }) },
  {
    name: 'operations', variant: 'asset', keyset: KEYSETS.assetOperations,
    run: (pool, cursor) => getOperationsByAsset(pool, { network: 'mainnet', asset: 'XLM', limit: 20, cursor }),
  },
  { name: 'events', keyset: KEYSETS.events, run: (pool, cursor) => getEventsByContract(pool, { network: 'mainnet', contractId: CONTRACT, limit: 20, cursor }) },
  {
    name: 'customEvents', keyset: KEYSETS.customEvents,
    run: (pool, cursor) => getCustomEvents(pool, { network: 'mainnet', contractId: CONTRACT, event: 'transfer', limit: 20, cursor }),
  },
  {
    name: 'search', keyset: KEYSETS.search,
    run: async (pool, cursor) => (await searchTransactions(pool, { network: 'mainnet', query: 'x', limit: 20, cursor })).items,
  },
  { name: 'ledgers', keyset: KEYSETS.ledgers, run: (pool, cursor) => getLedgers(pool, 'mainnet', 20, cursor) },
  { name: 'accounts', keyset: KEYSETS.accountsActivity, run: (pool, cursor) => getAccounts(pool, { network: 'mainnet', limit: 20, cursor }) },
  {
    name: 'accounts', variant: 'ADDRESS order', keyset: KEYSETS.accountsAddress,
    run: (pool, cursor) => getAccounts(pool, { network: 'mainnet', orderBy: 'ADDRESS', limit: 20, cursor }),
  },
];

/** The tag a listing's cursors carry: the query, not the code path. */
const cursorTag = (entry: { name: string }): string => entry.name;

/** How a listing is named in test output. */
const label = (entry: { name: string; variant?: string }): string =>
  entry.variant ? `${entry.name} (${entry.variant}:)` : entry.name;

/** A cursor each keyset's own sort key could legitimately have produced. */
function cursorFor(keyset: Keyset): string {
  // Numeric keys are numbers, the trailing id is a string — the shape every
  // keyset actually uses, so a decoder that insists on it is exercised here too.
  return encodeCursor(
    keyset.query,
    keyset.columns.map((_, index) => (index === keyset.columns.length - 1 ? 'abc' : index + 1))
  );
}

// One cursor per tag, taken from the first keyset declaring it: for `accounts`
// that is the activity order, which is what the table's default listing uses.
// The ADDRESS-order entry above carries its own arity, checked by the
// cross-query test.
const validCursors = Object.fromEntries(
  Object.values(KEYSETS)
    .filter((keyset, index, all) => all.findIndex(other => other.query === keyset.query) === index)
    .map(keyset => [keyset.query, cursorFor(keyset)])
) as Record<string, string>;

/** The fields in `type Query` that take a `cursor`. */
function paginatedFields(): string[] {
  const type = buildSchema(readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8')).getQueryType()!;
  return Object.values(type.getFields())
    .filter(field => field.args.some(arg => arg.name === 'cursor'))
    .map(field => field.name);
}

test('every paginated query in the schema is covered by this contract', () => {
  // Read from the schema rather than hardcoded, so a query added later without a
  // cursor contract fails here instead of quietly behaving like the old
  // conventions.
  const fields = paginatedFields();
  assert.ok(fields.length > 0, 'the schema should have paginated queries');
  assert.deepEqual(
    fields.filter(name => !paginatedQueries.some(entry => entry.name === name)),
    [],
    'every paginated field needs an entry above'
  );
  // And the other way round: no entry for a field that is not paginated.
  assert.deepEqual(
    [...new Set(paginatedQueries.map(entry => entry.name))].filter(name => !fields.includes(name)),
    []
  );
});

test('every paginated query rejects an invalid cursor the same way', async () => {
  for (const entry of paginatedQueries) {
    const { pool, calls } = fakePool([]);
    await assert.rejects(
      () => entry.run(pool, 'garbage!!'),
      (err: unknown) => {
        assert.ok(err instanceof InvalidCursorError, `${label(entry)} should reject the cursor`);
        assert.equal((err as InvalidCursorError).extensions['code'], 'INVALID_CURSOR', `${label(entry)} should use one code`);
        return true;
      },
      `${label(entry)} should reject a cursor it could not have issued`
    );
    // Rejected before the data query runs, not after a wasted round trip.
    assert.ok(calls.length <= 1, `${label(entry)} should not run its data query`);
  }
});

test('every paginated query rejects a cursor minted by a different query', async () => {
  for (const entry of paginatedQueries) {
    for (const [other, cursor] of Object.entries(validCursors)) {
      if (other === cursorTag(entry)) continue;
      const { pool } = fakePool([]);
      await assert.rejects(
        () => entry.run(pool, cursor),
        InvalidCursorError,
        `${label(entry)} should reject a ${other} cursor`
      );
    }
  }
});

test('a valid cursor past the last row is an empty page, not an error', async () => {
  // The distinction a client depends on: reaching the end is data, a bad cursor
  // is a mistake. Exactly one of the two is an error, on every query.
  for (const entry of paginatedQueries) {
    const { pool } = fakePool([]);
    assert.deepEqual(
      await entry.run(pool, cursorFor(entry.keyset)),
      [],
      `${label(entry)} should answer an empty page past the end`
    );
  }
});
