/**
 * The round trip the feature is actually judged on: register a schema, index a
 * matching event, read it back typed — against a real Postgres.
 *
 * The unit tests cover validation and decoding in isolation. What they cannot
 * show is that a JSONB payload written by the indexer is readable by the
 * numeric predicate the GraphQL layer builds, which is the seam where an i128
 * kept as text either compares exactly or does not.
 *
 * Skipped unless `TEST_DATABASE_URL` is set; CI provides one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { decodeEvents } from './customDecode';
import { parseContractSchema } from './customSchema';
import { deleteContractSchema, insertCustomEvents, loadContractSchemas, upsertContractSchema } from './db';
import type { ContractEvent } from './soroban';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const skip = DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

/**
 * A live-database test that stops making progress should fail with a name
 * attached, not stall the whole run. The job also carries its own
 * `timeout-minutes` as a second line of defence.
 */
const TEST_TIMEOUT_MS = 30_000;

// Deliberately not the default `mainnet`: if any read or write forgot its
// network filter it would land in the other bucket and the assertions below
// would see nothing.
const NETWORK = 'testnet';
const CONTRACT = 'CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ';
const FROM = 'GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TO = 'GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Larger than 2^53, so any path that routes it through a JS number loses it.
const HUGE_AMOUNT = '1208925819614629174706176';

let pool: Pool;

const schemaDoc = {
  contractId: CONTRACT,
  version: 1,
  events: [
    {
      name: 'transfer',
      topic: 'transfer',
      fields: [
        { name: 'from', type: 'address', source: 'topic[1]' },
        { name: 'to', type: 'address', source: 'topic[2]' },
        { name: 'amount', type: 'i128', source: 'value.amount' },
      ],
    },
  ],
};

function event(id: string, amount: bigint): ContractEvent {
  return {
    id,
    type: 'contract',
    contractId: CONTRACT,
    ledger: 900,
    createdAt: '2026-01-01T00:00:00Z',
    pagingToken: `900-${id}`,
    topics: [JSON.stringify('transfer'), JSON.stringify(FROM), JSON.stringify(TO)],
    value: { amount },
  };
}

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query('DELETE FROM custom_events WHERE contract_id = $1 AND network = $2', [
    CONTRACT,
    NETWORK,
  ]);
  await deleteContractSchema(pool, NETWORK, CONTRACT);
});

after(async () => {
  if (skip) return;
  await pool.query('DELETE FROM custom_events WHERE contract_id = $1 AND network = $2', [
    CONTRACT,
    NETWORK,
  ]);
  await deleteContractSchema(pool, NETWORK, CONTRACT);
  await pool.end();
});

test('register → index → read back typed', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const schema = parseContractSchema(schemaDoc);
  await upsertContractSchema(pool, NETWORK, schema);

  // Reloading from the database is part of the round trip: the indexer reads
  // schemas back each cycle rather than holding the one it was handed.
  const loaded = await loadContractSchemas(pool, NETWORK);
  assert.equal(loaded.get(CONTRACT)?.events[0]?.fields.length, 3);

  const { decoded, failures } = decodeEvents(loaded, [
    event('evt_small', 500n),
    event('evt_huge', BigInt(HUGE_AMOUNT)),
  ]);
  assert.equal(failures.length, 0);

  await insertCustomEvents(pool, NETWORK, decoded);

  const { rows } = await pool.query(
    'SELECT event_id, fields FROM custom_events WHERE contract_id = $1 AND network = $2 ORDER BY event_id',
    [CONTRACT, NETWORK]
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fields.amount, HUGE_AMOUNT, 'the i128 survived the round trip exactly');
  assert.equal(rows[0].fields.from, FROM);
});

test('the numeric predicate the query layer builds compares an i128 exactly', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  // The seam that matters: text in JSONB, cast to numeric, compared against a
  // bound parameter. A bigint column would have overflowed here.
  const boundary = (BigInt(HUGE_AMOUNT) - 1n).toString();

  const { rows } = await pool.query(
    `SELECT event_id FROM custom_events
      WHERE contract_id = $1
        AND network = $2
        AND event_name = $3
        AND (fields->>$4)::numeric > $5::numeric`,
    [CONTRACT, NETWORK, 'transfer', 'amount', boundary]
  );

  assert.deepEqual(rows.map(r => r.event_id), ['evt_huge']);
});

test('an exact-match filter finds the right rows', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const { rows } = await pool.query(
    `SELECT event_id FROM custom_events
      WHERE contract_id = $1 AND network = $2 AND event_name = $3 AND fields->>$4 = $5`,
    [CONTRACT, NETWORK, 'transfer', 'from', FROM]
  );

  assert.equal(rows.length, 2);
});

test('re-indexing after a schema revision replaces the decoded row', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  // ON CONFLICT DO UPDATE rather than DO NOTHING: a revised schema has to be
  // able to correct what an earlier version stored, or the old decoding
  // survives forever.
  const revised = parseContractSchema({
    ...schemaDoc,
    version: 2,
    events: [
      {
        name: 'transfer',
        topic: 'transfer',
        fields: [{ name: 'amount', type: 'i128', source: 'value.amount' }],
      },
    ],
  });
  await upsertContractSchema(pool, NETWORK, revised);

  const loaded = await loadContractSchemas(pool, NETWORK);
  const { decoded } = decodeEvents(loaded, [event('evt_small', 777n)]);
  await insertCustomEvents(pool, NETWORK, decoded);

  const { rows } = await pool.query(
    `SELECT schema_version, fields FROM custom_events
      WHERE event_id = $1 AND event_name = $2 AND network = $3`,
    ['evt_small', 'transfer', NETWORK]
  );

  assert.equal(rows.length, 1, 'the revision updated in place rather than adding a row');
  assert.equal(rows[0].schema_version, 2);
  assert.equal(rows[0].fields.amount, '777');
  assert.equal(rows[0].fields.from, undefined, 'a field dropped from the schema is gone');
});

test('a contract without a schema is untouched by any of this', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const other = 'CBYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ';
  const loaded = await loadContractSchemas(pool, NETWORK);

  const { decoded } = decodeEvents(loaded, [{ ...event('evt_other', 1n), contractId: other }]);

  assert.equal(decoded.length, 0);
  const { rows } = await pool.query(
    'SELECT 1 FROM custom_events WHERE contract_id = $1 AND network = $2',
    [other, NETWORK]
  );
  assert.equal(rows.length, 0);
});

test('a schema belongs to the network it was registered for', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  // The same contract id can decode differently on two chains, and the indexer
  // only ever loads the schemas for the network it is indexing.
  const registered = await loadContractSchemas(pool, NETWORK);
  const other = await loadContractSchemas(pool, 'mainnet');

  assert.equal(registered.has(CONTRACT), true);
  assert.equal(other.has(CONTRACT), false);
});
