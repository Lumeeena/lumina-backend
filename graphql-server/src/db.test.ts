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
    sequence: '52481234',
    closed_at: new Date('2026-05-06T10:22:14Z'),
    transaction_count: 5,
    operation_count: 12,
    base_fee: '100',
    base_reserve: '5000000',
  });
  assert.deepEqual(result, {
    sequence: 52481234,
    closedAt: '2026-05-06T10:22:14.000Z',
    transactionCount: 5,
    operationCount: 12,
    baseFee: 100,
    baseReserve: 5000000,
  });
});

test('PostgreSQL TIMESTAMPTZ round-trips an offset instant as UTC', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new PgPool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("SET TIME ZONE 'America/Los_Angeles'");
    const { rows } = await client.query<{ value: Date }>(
      'SELECT $1::timestamptz AS value', ['2026-06-14T09:30:00.123+05:30']
    );
    assert.ok(rows[0].value instanceof Date);
    assert.equal(rows[0].value.toISOString(), '2026-06-14T04:00:00.123Z');
  } finally { client.release(); await pool.end(); }
});

test('mapTransaction keeps feeCharged as a string (no precision loss)', () => {
  const result = mapTransaction({
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
  const items = await getTransactions(pool, 20, 'cursor-hash');
  assert.equal(items.length, 1);
  assert.equal(items[0].hash, 'a');
  assert.deepEqual(queries[0].params, [20, 'cursor-hash']);
});

test('getOperations builds WHERE clause only for provided filters', async () => {
  const { pool, queries } = fakePool([]);
  await getOperations(pool, { account: 'GABC', limit: 10 });
  assert.match(queries[0].sql, /WHERE source_account = \$1/);
  assert.deepEqual(queries[0].params, ['GABC', 10]);
});

test('getOperations omits WHERE entirely with no filters', async () => {
  const { pool, queries } = fakePool([]);
  await getOperations(pool, { limit: 10 });
  assert.doesNotMatch(queries[0].sql, /WHERE/);
});

test('getAccountFromDb returns null when no row is found', async () => {
  const { pool } = fakePool([]);
  assert.equal(await getAccountFromDb(pool, 'GABC'), null);
});

test('getEventsByContract filters by contract_id and optional topic', async () => {
  const { pool, queries } = fakePool([]);
  await getEventsByContract(pool, { contractId: 'CABC', topic: 'swap', limit: 5 });
  assert.match(queries[0].sql, /contract_id = \$1/);
  assert.match(queries[0].sql, /\$2 = ANY\(topics\)/);
  assert.deepEqual(queries[0].params, ['CABC', 'swap', 5]);
});
