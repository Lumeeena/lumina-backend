import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { Pool as PgPool } from 'pg';
import {
  getAccountFromDb,
  getEventsByContract,
  getOperations,
  getTransactions,
  mapAccount,
  mapEvent,
  mapLedger,
  mapOperation,
  mapTransaction,
} from './db';

function fakePool(rows: unknown[]): { pool: Pool; queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, queries };
}

test('mapLedger converts BIGINT strings and Date to GraphQL shape', () => {
  const result = mapLedger({
    network: 'mainnet',
    sequence: '52481234',
    closed_at: new Date('2026-05-06T10:22:14Z'),
    transaction_count: 5,
    operation_count: 12,
    base_fee: '100',
    base_reserve: '5000000',
  });
  assert.deepEqual(result, {
    network: 'mainnet',
    sequence: 52481234,
    closedAt: '2026-05-06T10:22:14.000Z',
    transactionCount: 5,
    operationCount: 12,
    baseFee: 100,
    baseReserve: 5000000,
  });
});

test('PostgreSQL TIMESTAMPTZ round-trips an offset instant as UTC', { skip: !process.env['TEST_DATABASE_URL'] }, async () => {
  const pool = new PgPool({ connectionString: process.env['TEST_DATABASE_URL'] });
  const client = await pool.connect();
  try {
    await client.query("SET TIME ZONE 'America/Los_Angeles'");
    const { rows } = await client.query<{ value: Date }>(
      'SELECT $1::timestamptz AS value', ['2026-06-14T09:30:00.123+05:30']
    );
    const value = rows[0]?.value;
    assert.ok(value instanceof Date);
    assert.equal(value.toISOString(), '2026-06-14T04:00:00.123Z');
  } finally { client.release(); await pool.end(); }
});

test('mapTransaction keeps feeCharged as a string (no precision loss)', () => {
  const result = mapTransaction({
    network: 'mainnet',
    hash: 'abc',
    ledger: '100',
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GABC',
    fee_charged: '10000000000',
    operation_count: 1,
    successful: true,
    memo_type: 'none',
    memo: null,
  });
  assert.equal(result.ledger, 100);
  assert.equal(result.feeCharged, '10000000000');
});

test('mapOperation collapses asset_type/code/issuer into a single asset string', () => {
  const payment = mapOperation({
    network: 'mainnet',
    id: 'op1',
    type: 'payment',
    transaction_hash: 'tx1',
    ledger: '100',
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GABC',
    details: { from: 'GABC', to: 'GDEF', amount: '100', asset_type: 'native' },
  });
  assert.equal(payment.type, 'PAYMENT');
  assert.equal(payment.asset, 'XLM');
  assert.equal(payment.from, 'GABC');

  const trustline = mapOperation({
    network: 'testnet',
    id: 'op2',
    type: 'change_trust',
    transaction_hash: 'tx2',
    ledger: '100',
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GABC',
    details: { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER' },
  });
  assert.equal(trustline.type, 'CHANGE_TRUST');
  assert.equal(trustline.asset, 'USDC:GISSUER');
});

test('mapAccount converts snake_case balances/flags/thresholds to GraphQL shape', () => {
  const result = mapAccount({
    network: 'mainnet',
    address: 'GABC',
    sequence: '1',
    subentry_count: 2,
    last_modified_ledger: 100,
    num_sponsored: 0,
    num_sponsoring: 0,
    balances: [{ asset_type: 'native', balance: '500' }],
    flags: { auth_required: true },
    thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
  });
  assert.equal(result.address, 'GABC');
  assert.deepEqual(result.balances, [{
    assetType: 'native', assetCode: null, assetIssuer: null, balance: '500', limit: null, buyingLiabilities: null, sellingLiabilities: null,
  }]);
  assert.equal(result.flags.authRequired, true);
  assert.equal(result.flags.authRevocable, false);
  assert.equal(result.thresholds.medThreshold, 2);
});

test('mapEvent JSON-encodes the value column for the String scalar', () => {
  const result = mapEvent({
    network: 'mainnet',
    id: 'evt1',
    type: 'contract',
    contract_id: 'CABC',
    ledger: '100',
    created_at: new Date('2026-01-01T00:00:00Z'),
    paging_token: 'tok1',
    topics: ['swap'],
    value: { amount: '10' },
  });
  assert.equal(result.value, '{"amount":"10"}');
});

test('getTransactions maps rows and passes limit/cursor params', async () => {
  const { pool, queries } = fakePool([
    { hash: 'a', ledger: '1', created_at: new Date(), source_account: 'G', fee_charged: '100', operation_count: 1, successful: true, memo_type: null, memo: null },
  ]);
  const items = await getTransactions(pool, 'mainnet', 20, 'cursor-hash');
  assert.equal(items.length, 1);
  assert.equal(items[0]?.hash, 'a');
  // The network is bound first and repeated in the cursor subquery: the same
  // hash exists on every network, so the keyset has to know which one.
  assert.deepEqual(queries[0]?.params, ['mainnet', 'cursor-hash', 20]);
  assert.match(queries[0]?.sql ?? '', /\(ledger, hash\) </);
  assert.match(queries[0]?.sql ?? '', /ORDER BY ledger DESC, hash DESC/);
});

test('getTransactions uses an ascending tuple keyset when requested', async () => {
  const { pool, queries } = fakePool([]);
  await getTransactions(pool, 'mainnet', 20, 'cursor-hash', { order: 'ASC' });
  assert.match(queries[0]?.sql ?? '', /\(ledger, hash\) >/);
  assert.match(queries[0]?.sql ?? '', /ORDER BY ledger ASC, hash ASC/);
});

test('getTransactions composes filters with its stable keyset cursor', async () => {
  const { pool, queries } = fakePool([]);
  await getTransactions(pool, 'mainnet', 10, 'cursor-hash', {
    order: 'ASC',
    successful: false,
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-31T23:59:59Z',
    sourceAccount: 'GACCOUNT',
  });

  assert.equal(
    queries[0]?.sql,
    'SELECT * FROM transactions WHERE network = $1 AND successful = $2 ' +
      'AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz ' +
      'AND source_account = $5 AND (ledger, hash) > ' +
      '(SELECT ledger, hash FROM transactions WHERE hash = $6 AND network = $1) ' +
      'ORDER BY ledger ASC, hash ASC LIMIT $7'
  );
  assert.deepEqual(queries[0]?.params, [
    'mainnet', false, '2026-01-01T00:00:00Z', '2026-01-31T23:59:59Z', 'GACCOUNT', 'cursor-hash', 10,
  ]);
});

test('getOperations builds WHERE clause only for provided filters', async () => {
  const { pool, queries } = fakePool([]);
  await getOperations(pool, { network: 'mainnet', account: 'GABC', limit: 10 });
  assert.match(queries[0]?.sql ?? '', /WHERE network = \$1 AND source_account = \$2/);
  assert.deepEqual(queries[0]?.params, ['mainnet', 'GABC', 10]);
});

test('getOperations is scoped to one network even with no filters', async () => {
  const { pool, queries } = fakePool([]);
  await getOperations(pool, { network: 'testnet', limit: 10 });
  assert.match(queries[0]?.sql ?? '', /WHERE network = \$1/);
  assert.deepEqual(queries[0]?.params, ['testnet', 10]);
});

test('getAccountFromDb returns null when no row is found', async () => {
  const { pool } = fakePool([]);
  assert.equal(await getAccountFromDb(pool, 'mainnet', 'GABC'), null);
});

test('getEventsByContract filters by contract_id and optional topic', async () => {
  const { pool, queries } = fakePool([]);
  await getEventsByContract(pool, { network: 'mainnet', contractId: 'CABC', topic: 'swap', limit: 5 });
  assert.match(queries[0]?.sql ?? '', /contract_id = \$1/);
  assert.match(queries[0]?.sql ?? '', /network = \$2/);
  assert.match(queries[0]?.sql ?? '', /\$3 = ANY\(topics\)/);
  assert.deepEqual(queries[0]?.params, ['CABC', 'mainnet', 'swap', 5]);
});

// ─── Dynamic SQL shape ───────────────────────────────────────────────────────
//
// These two builders grow a WHERE clause one optional filter at a time, which
// is the shape that makes injection possible if a value is ever written into
// the string instead of bound. The assertions are anchored to the whole
// statement, not to a fragment: a fragment match still passes when something
// extra has been appended after it.

// The cursor row comparisons below reference the network *by position*
// (`network = $1` here, `$2` in getEventsByContract) rather than binding it
// again. That is deliberate — the keyset lookup has to stay inside the same
// network — but it is positional, so reordering the params.push calls would
// silently point it at another filter's value. Asserting the whole statement
// pins those positions; a fragment match would not.

test('getOperations emits exactly the expected statement with every filter set', async () => {
  const { pool, queries } = fakePool([]);
  await getOperations(pool, { network: 'mainnet', account: 'GABC', type: 'Payment', cursor: 'op-9', limit: 10 });

  assert.equal(
    queries[0]?.sql,
    'SELECT * FROM operations WHERE network = $1 AND source_account = $2 AND type = $3 ' +
      'AND (ledger, id) < (SELECT ledger, id FROM operations WHERE id = $4 AND network = $1) ' +
      'ORDER BY ledger DESC, id DESC LIMIT $5'
  );
  // The type filter is lowercased before binding, so it matches what the index
  // and the stored column compare against.
  assert.deepEqual(queries[0]?.params, ['mainnet', 'GABC', 'payment', 'op-9', 10]);
});

test('getOperations never writes a filter value into the statement', async () => {
  const { pool, queries } = fakePool([]);
  const hostile = "GABC'; DROP TABLE operations--";
  await getOperations(pool, { network: 'mainnet', account: hostile, limit: 10 });

  const sql = queries[0]?.sql ?? '';
  assert.ok(!sql.includes(hostile), sql);
  assert.ok(!sql.includes('DROP'), sql);
  assert.ok(!sql.includes("'"), sql);
  assert.ok(queries[0]?.params.includes(hostile), 'the value belongs in the params array');
});

test('getOperations with no filters selects only the network and the limit', async () => {
  const { pool, queries } = fakePool([]);
  await getOperations(pool, { network: 'mainnet', limit: 10 });

  assert.equal(queries[0]?.sql, 'SELECT * FROM operations WHERE network = $1 ORDER BY ledger DESC, id DESC LIMIT $2');
});

test('getOperations uses an ascending tuple keyset when requested', async () => {
  const { pool, queries } = fakePool([]);
  await getOperations(pool, { network: 'mainnet', cursor: 'op-9', limit: 10, order: 'ASC' });
  assert.match(queries[0]?.sql ?? '', /\(ledger, id\) >/);
  assert.match(queries[0]?.sql ?? '', /ORDER BY ledger ASC, id ASC/);
});

test('getEventsByContract emits exactly the expected statement with every filter set', async () => {
  const { pool, queries } = fakePool([]);
  await getEventsByContract(pool, { network: 'mainnet', contractId: 'CABC', topic: 'swap', cursor: 'evt-9', limit: 20 });

  assert.equal(
    queries[0]?.sql,
    'SELECT * FROM contract_events WHERE contract_id = $1 AND network = $2 AND $3 = ANY(topics) ' +
      'AND (ledger, id) < (SELECT ledger, id FROM contract_events WHERE id = $4 AND network = $2) ' +
      'ORDER BY ledger DESC, id DESC LIMIT $5'
  );
  assert.deepEqual(queries[0]?.params, ['CABC', 'mainnet', 'swap', 'evt-9', 20]);
});

test('getEventsByContract uses an ascending tuple keyset when requested', async () => {
  const { pool, queries } = fakePool([]);
  await getEventsByContract(pool, { network: 'mainnet', contractId: 'CABC', cursor: 'evt-9', limit: 20, order: 'ASC' });
  assert.match(queries[0]?.sql ?? '', /\(ledger, id\) >/);
  assert.match(queries[0]?.sql ?? '', /ORDER BY ledger ASC, id ASC/);
});

test('getEventsByContract never writes a filter value into the statement', async () => {
  const { pool, queries } = fakePool([]);
  const hostile = "CABC' OR '1'='1";
  await getEventsByContract(pool, { network: 'mainnet', contractId: hostile, topic: hostile, limit: 20 });

  const sql = queries[0]?.sql ?? '';
  assert.ok(!sql.includes(hostile), sql);
  assert.ok(!sql.includes("'"), sql);
  assert.ok(queries[0]?.params.includes(hostile));
});

