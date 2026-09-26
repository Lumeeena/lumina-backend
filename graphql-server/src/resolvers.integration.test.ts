/**
 * Resolver integration tests against a real Postgres.
 *
 * Unit tests use a fake pool and mock data. These tests verify that resolvers
 * actually execute queries end-to-end against a real database, catching SQL
 * syntax errors and logic bugs that unit tests cannot surface.
 *
 * Skipped unless `TEST_DATABASE_URL` is set; CI provides one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { resolvers } from './resolvers';
import { createContext } from './resolvers';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const skip = DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

const TEST_TIMEOUT_MS = 30_000;
const LEDGER = 990_002;
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ACCOUNT = 'GACCOUNT';
const TX_HASH = 'tx_resolver_test_1';
const OPERATION_ID = 'op_resolver_test_1';

let pool: Pool;

async function seed(): Promise<void> {
  // Insert test ledger
  await pool.query(
    `INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count)
     VALUES ($1, NOW(), $2, $2) ON CONFLICT (sequence) DO NOTHING`,
    [LEDGER, 1]
  );

  // Insert test transaction
  await pool.query(
    `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo)
     VALUES ($1, $2, NOW(), $3, 100, 1, true, 'text', 'test memo')
     ON CONFLICT (hash) DO UPDATE SET memo = EXCLUDED.memo`,
    [TX_HASH, LEDGER, ACCOUNT]
  );

  // Insert test account
  await pool.query(
    `INSERT INTO accounts (address, sequence, subentry_count, last_modified_ledger, num_sponsored, num_sponsoring, flags, thresholds)
     VALUES ($1, '100', 0, $2, 0, 0, '{}', '{}')
     ON CONFLICT (address) DO UPDATE SET sequence = EXCLUDED.sequence`,
    [ACCOUNT, LEDGER]
  );

  // Insert test operation
  await pool.query(
    `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details)
     VALUES ($1, 'payment', $2, $3, NOW(), $4, $5)
     ON CONFLICT (id) DO UPDATE SET details = EXCLUDED.details`,
    [OPERATION_ID, TX_HASH, LEDGER, ACCOUNT, JSON.stringify({ asset_type: 'native', amount: '100' })]
  );
}

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query('DELETE FROM operations WHERE ledger = $1', [LEDGER]);
  await pool.query('DELETE FROM transactions WHERE ledger = $1', [LEDGER]);
  await pool.query('DELETE FROM accounts WHERE last_modified_ledger = $1', [LEDGER]);
  await pool.query('DELETE FROM ledgers WHERE sequence = $1', [LEDGER]);
  await seed();
});

after(async () => {
  if (skip) return;
  await pool.query('DELETE FROM operations WHERE ledger = $1', [LEDGER]);
  await pool.query('DELETE FROM transactions WHERE ledger = $1', [LEDGER]);
  await pool.query('DELETE FROM accounts WHERE last_modified_ledger = $1', [LEDGER]);
  await pool.query('DELETE FROM ledgers WHERE sequence = $1', [LEDGER]);
  await pool.end();
});

// ── Query tests ───────────────────────────────────────────────────────────────

test('transactions query returns paginated results from database', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const result = await resolvers.Query.transactions(undefined, { limit: 10 }, ctx);

  assert.ok(Array.isArray(result.items));
  assert.ok(typeof result.pageInfo.hasNextPage === 'boolean');
  // The test ledger should appear in results
  const txInResults = result.items.some(t => t.hash === TX_HASH);
  assert.ok(txInResults, 'test transaction should be in results');
});

test('transaction query fetches a specific transaction', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const result = await resolvers.Query.transaction(undefined, { hash: TX_HASH }, ctx);

  assert.ok(result);
  assert.equal(result.hash, TX_HASH);
  assert.equal(result.sourceAccount, ACCOUNT);
  assert.equal(result.memo, 'test memo');
});

test('account query resolves from database', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const result = await resolvers.Query.account(undefined, { address: ACCOUNT }, ctx);

  assert.ok(result);
  assert.equal(result.address, ACCOUNT);
  assert.equal(result.sequence, '100');
});

test('operations query returns results', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const result = await resolvers.Query.operations(undefined, { limit: 10 }, ctx);

  assert.ok(Array.isArray(result.items));
  assert.ok(typeof result.pageInfo.hasNextPage === 'boolean');
  const opInResults = result.items.some(o => o.id === OPERATION_ID);
  assert.ok(opInResults, 'test operation should be in results');
});

test('operations query with account filter works', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const result = await resolvers.Query.operations(undefined, { account: ACCOUNT, limit: 10 }, ctx);

  assert.ok(Array.isArray(result.items));
  const hasTestOp = result.items.some(o => o.id === OPERATION_ID);
  assert.ok(hasTestOp, 'test operation should match account filter');
});

test('latestLedger query returns ledger data', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const result = await resolvers.Query.latestLedger(undefined, {}, ctx);

  assert.ok(result);
  assert.ok(typeof result.sequence === 'number');
  assert.ok(typeof result.closedAt === 'string');
});

test('ledger query fetches by sequence', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const result = await resolvers.Query.ledger(undefined, { sequence: LEDGER }, ctx);

  assert.ok(result);
  assert.equal(result.sequence, LEDGER);
});

test('search query executes against real database', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  // Search for the memo we inserted
  const result = await resolvers.Query.search(undefined, { query: 'test', limit: 10 }, ctx);

  assert.ok(Array.isArray(result.items));
  assert.ok(typeof result.pageInfo.hasNextPage === 'boolean');
  // Should find the transaction with 'test memo'
  const foundTx = result.items.some(t => t.hash === TX_HASH);
  assert.ok(foundTx, 'search should find test transaction by memo');
});

test('search with invalid query is rejected', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);

  await assert.rejects(
    () => resolvers.Query.search(undefined, { query: '   ', limit: 10 }, ctx),
    /empty/i
  );
});

// ── Field resolvers tests ──────────────────────────────────────────────────────

test('Transaction.ledgerData resolves ledger data', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const tx = { hash: TX_HASH, ledger: LEDGER, sourceAccount: ACCOUNT };

  const ledger = await resolvers.Transaction.ledgerData(tx, undefined, ctx);

  assert.ok(ledger);
  assert.equal(ledger.sequence, LEDGER);
});

test('Transaction.account resolves account field', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const tx = { hash: TX_HASH, ledger: LEDGER, sourceAccount: ACCOUNT };

  const account = await resolvers.Transaction.account(tx, undefined, ctx);

  assert.ok(account);
  assert.equal(account.address, ACCOUNT);
});

test('Transaction.operations resolves related operations', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const tx = { hash: TX_HASH, ledger: LEDGER, sourceAccount: ACCOUNT };

  const ops = await resolvers.Transaction.operations(tx, undefined, ctx);

  assert.ok(Array.isArray(ops));
  const foundOp = ops.some(o => o.id === OPERATION_ID);
  assert.ok(foundOp, 'should resolve related operations');
});

test('Operation.transaction resolves transaction field', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const op = { id: OPERATION_ID, type: 'payment', transactionHash: TX_HASH, sourceAccount: ACCOUNT };

  const tx = await resolvers.Operation.transaction(op, undefined, ctx);

  assert.ok(tx);
  assert.equal(tx.hash, TX_HASH);
});

test('Operation.account resolves account field', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const op = { id: OPERATION_ID, type: 'payment', transactionHash: TX_HASH, sourceAccount: ACCOUNT };

  const account = await resolvers.Operation.account(op, undefined, ctx);

  assert.ok(account);
  assert.equal(account.address, ACCOUNT);
});

test('Account.transactions resolves account transactions', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const account = { address: ACCOUNT };

  const txs = await resolvers.Account.transactions(account, { limit: 10 }, ctx);

  assert.ok(Array.isArray(txs));
  const foundTx = txs.some(t => t.hash === TX_HASH);
  assert.ok(foundTx, 'should resolve account transactions');
});

test('Account.operations resolves account operations', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = createContext(pool);
  const account = { address: ACCOUNT };

  const ops = await resolvers.Account.operations(account, { limit: 10 }, ctx);

  assert.ok(Array.isArray(ops));
  const foundOp = ops.some(o => o.id === OPERATION_ID);
  assert.ok(foundOp, 'should resolve account operations');
});

test('asset query returns supply, holders and a matching volume series', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const assetLedger = 990_003;
  const holderA = 'GASSET_HOLDER_A';
  const holderB = 'GASSET_HOLDER_B';
  const txA = 'tx_asset_test_a';
  const txB = 'tx_asset_test_b';

  await pool.query(
    `INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count)
     VALUES ($1, NOW(), 2, 2) ON CONFLICT (sequence) DO NOTHING`,
    [assetLedger]
  );
  await pool.query(
    `INSERT INTO accounts (address, sequence, subentry_count, last_modified_ledger, num_sponsored, num_sponsoring, balances, flags, thresholds)
     VALUES ($1, '1', 1, $2, 0, 0, $3, '{}', '{}')
     ON CONFLICT (address) DO UPDATE SET balances = EXCLUDED.balances`,
    [holderA, assetLedger, JSON.stringify([{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, balance: '100' }])]
  );
  await pool.query(
    `INSERT INTO accounts (address, sequence, subentry_count, last_modified_ledger, num_sponsored, num_sponsoring, balances, flags, thresholds)
     VALUES ($1, '1', 1, $2, 0, 0, $3, '{}', '{}')
     ON CONFLICT (address) DO UPDATE SET balances = EXCLUDED.balances`,
    [holderB, assetLedger, JSON.stringify([{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, balance: '150.5' }])]
  );
  for (const [hash, createdAt] of [[txA, '2026-01-01T12:00:00Z'], [txB, '2026-01-02T12:00:00Z']] as const) {
    await pool.query(
      `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful)
       VALUES ($1, $2, $3, $4, 100, 1, true)
       ON CONFLICT (hash) DO UPDATE SET created_at = EXCLUDED.created_at`,
      [hash, assetLedger, createdAt, holderA]
    );
  }
  await pool.query(
    `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details)
     VALUES ('op_asset_test_a', 'payment', $1, $2, '2026-01-01T12:00:00Z', $3, $4)
     ON CONFLICT (id) DO UPDATE SET details = EXCLUDED.details`,
    [txA, assetLedger, holderA, JSON.stringify({ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, amount: '60', from: holderA, to: holderB })]
  );
  await pool.query(
    `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details)
     VALUES ('op_asset_test_b', 'payment', $1, $2, '2026-01-02T12:00:00Z', $3, $4)
     ON CONFLICT (id) DO UPDATE SET details = EXCLUDED.details`,
    [txB, assetLedger, holderA, JSON.stringify({ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, amount: '40', from: holderA, to: holderB })]
  );

  try {
    const ctx = createContext(pool);
    const detail = await resolvers.Query.asset(
      undefined,
      {
        asset: `USDC:${ISSUER}`,
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-03T00:00:00Z',
        bucketSeconds: 86400,
      },
      ctx
    );

    assert.equal(detail.asset, `USDC:${ISSUER}`);
    assert.equal(detail.supply, '250.5');
    assert.equal(detail.holders, 2);
    assert.equal(detail.series.length, 3);
    // Buckets are zero-filled and ascending; the total matches the parts.
    const total = detail.series.reduce((sum, bucket) => sum + Number(bucket.volume), 0);
    assert.equal(total, 100);
    assert.deepEqual(
      detail.series.map(bucket => bucket.operationCount),
      [1, 1, 0]
    );
  } finally {
    await pool.query('DELETE FROM operations WHERE id IN ($1, $2)', ['op_asset_test_a', 'op_asset_test_b']);
    await pool.query('DELETE FROM transactions WHERE hash IN ($1, $2)', [txA, txB]);
    await pool.query('DELETE FROM accounts WHERE address IN ($1, $2)', [holderA, holderB]);
    await pool.query('DELETE FROM ledgers WHERE sequence = $1', [assetLedger]);
  }
});
