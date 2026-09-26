/**
 * Ranking and asset filtering against a real Postgres.
 *
 * The unit tests assert the *shape* of the SQL — that ranking is trigram, that
 * paging is keyset, that an asset matches all three roles. None of that shows
 * whether the ranking actually puts the right row first, which is the only
 * thing a user notices. That needs real rows, a real `pg_trgm`, and a real
 * planner, so it lives here.
 *
 * Skipped unless `TEST_DATABASE_URL` is set; CI provides one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { decodeCursor, getOperationsByAsset, searchTransactions } from './search';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const skip = DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

const TEST_TIMEOUT_MS = 30_000;
const LEDGER = 990_001;
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const OTHER_ISSUER = 'GBBBBEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

let pool: Pool;

/** Memos chosen to look like the ones Stellar transactions actually carry. */
const MEMOS: [string, string][] = [
  ['tx_exact', 'ORDER-4471'],
  ['tx_prefix', 'ORDER-4471-REFUND'],
  ['tx_typo', 'ORDR-4471'],
  ['tx_other', 'INVOICE-9920'],
  ['tx_unrelated', 'coffee money'],
];

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count)
     VALUES ($1, NOW(), $2, $2) ON CONFLICT (sequence) DO NOTHING`,
    [LEDGER, MEMOS.length]
  );

  for (const [hash, memo] of MEMOS) {
    await pool.query(
      `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo)
       VALUES ($1, $2, NOW(), 'GSOURCE', 100, 1, true, 'text', $3)
       ON CONFLICT (hash) DO UPDATE SET memo = EXCLUDED.memo`,
      [hash, LEDGER, memo]
    );
  }

  const operations: [string, Record<string, unknown>][] = [
    ['op_usdc_payment', { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER }],
    ['op_usdc_selling', { selling_asset_type: 'credit_alphanum4', selling_asset_code: 'USDC', selling_asset_issuer: ISSUER }],
    ['op_usdc_buying', { buying_asset_type: 'credit_alphanum4', buying_asset_code: 'USDC', buying_asset_issuer: ISSUER }],
    // Same code, different issuer — the confusion asset issuers exist to prevent.
    ['op_usdc_impostor', { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: OTHER_ISSUER }],
    ['op_native', { asset_type: 'native' }],
  ];

  for (const [id, details] of operations) {
    await pool.query(
      `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details)
       VALUES ($1, 'payment', $2, $3, NOW(), 'GSOURCE', $4)
       ON CONFLICT (id) DO UPDATE SET details = EXCLUDED.details`,
      [id, 'tx_exact', LEDGER, JSON.stringify(details)]
    );
  }
}

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query('DELETE FROM operations WHERE ledger = $1', [LEDGER]);
  await pool.query('DELETE FROM transactions WHERE ledger = $1', [LEDGER]);
  await pool.query('DELETE FROM ledgers WHERE sequence = $1', [LEDGER]);
  await seed();
});

after(async () => {
  if (skip) return;
  await pool.query('DELETE FROM operations WHERE ledger = $1', [LEDGER]);
  await pool.query('DELETE FROM transactions WHERE ledger = $1', [LEDGER]);
  await pool.query('DELETE FROM ledgers WHERE sequence = $1', [LEDGER]);
  await pool.end();
});

test('an exact memo match ranks first', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const { items } = await searchTransactions(pool, { query: 'ORDER-4471', limit: 10 });

  assert.equal(items[0]?.hash, 'tx_exact', 'the exact match should lead');
  // And the near-misses are still found, which is the point of trigram over
  // exact matching.
  const hashes = items.map(i => i.hash);
  assert.ok(hashes.includes('tx_prefix'));
});

test('search is case-insensitive', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const { items } = await searchTransactions(pool, { query: 'order-4471', limit: 10 });

  assert.equal(items[0]?.hash, 'tx_exact');
});

test('a typo still finds the transaction', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  // The reason for trigram: `to_tsvector` would not match a misspelled
  // identifier at all.
  const { items } = await searchTransactions(pool, { query: 'ORDR-4471', limit: 10 });

  assert.ok(items.some(i => i.hash === 'tx_typo'));
});

test('a partial memo finds the full one', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const { items } = await searchTransactions(pool, { query: 'INVOICE', limit: 10 });

  assert.ok(items.some(i => i.hash === 'tx_other'));
});

test('unrelated memos are excluded by the similarity floor', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const { items } = await searchTransactions(pool, { query: 'ORDER-4471', limit: 10 });

  assert.ok(
    !items.some(i => i.hash === 'tx_unrelated'),
    'an unrelated memo should not clear the similarity threshold'
  );
});

test('paging never repeats or skips a row', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const seen: string[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 10; page++) {
    const result = await searchTransactions(pool, { query: 'ORDER', limit: 1, cursor });
    if (result.items.length === 0) break;
    seen.push(...result.items.map(i => i.hash));
    cursor = result.nextCursor;
    if (!cursor) break;
  }

  assert.deepEqual(seen, [...new Set(seen)], 'a hash appeared on more than one page');
  assert.ok(seen.includes('tx_exact'));
});

test('a page boundary survives a new matching row landing mid-scroll', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  // The scenario keyset paging exists for: with OFFSET, inserting a row that
  // sorts earlier shifts every later page by one and duplicates a row across
  // the seam.
  const first = await searchTransactions(pool, { query: 'ORDER', limit: 1 });
  assert.equal(first.items.length, 1);

  await pool.query(
    `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo)
     VALUES ('tx_inserted', $1, NOW(), 'GSOURCE', 100, 1, true, 'text', 'ORDER-4471')
     ON CONFLICT (hash) DO NOTHING`,
    [LEDGER]
  );

  try {
    const second = await searchTransactions(pool, { query: 'ORDER', limit: 5, cursor: first.nextCursor });
    assert.ok(
      !second.items.some(i => i.hash === first.items[0].hash),
      'the first page’s row must not reappear on the second'
    );
  } finally {
    await pool.query("DELETE FROM transactions WHERE hash = 'tx_inserted'");
  }
});

test('the cursor carries the rank, not just a row id', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const { nextCursor } = await searchTransactions(pool, { query: 'ORDER-4471', limit: 1 });
  const decoded = decodeCursor(nextCursor!);

  assert.ok(decoded);
  assert.ok(decoded!.rank > 0, 'rank should be a real similarity score');
  assert.equal(decoded!.ledger, LEDGER);
});

test('an asset filter finds the asset in all three roles', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const items = await getOperationsByAsset(pool, { asset: `USDC:${ISSUER}`, limit: 20 });
  const ids = items.map(i => i.id);

  assert.ok(ids.includes('op_usdc_payment'));
  assert.ok(ids.includes('op_usdc_selling'));
  assert.ok(ids.includes('op_usdc_buying'));
});

test('an asset filter excludes the same code from another issuer', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const items = await getOperationsByAsset(pool, { asset: `USDC:${ISSUER}`, limit: 20 });

  assert.ok(
    !items.some(i => i.id === 'op_usdc_impostor'),
    'matching on code alone would mix up every lookalike asset'
  );
});

test('the native filter finds XLM operations', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const items = await getOperationsByAsset(pool, { asset: 'XLM', limit: 20 });
  const ids = items.map(i => i.id);

  assert.ok(ids.includes('op_native'));
  assert.ok(!ids.includes('op_usdc_payment'));
});

test('the search indexes are actually present', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  // A missing index turns every search into a sequential scan, which is a
  // performance bug rather than a correctness one and so passes every other
  // test in this file.
  const { rows } = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE tablename IN ('transactions', 'operations')
        AND indexname IN (
          'idx_transactions_memo_trgm',
          'idx_operations_asset_code',
          'idx_operations_asset_issuer',
          'idx_operations_asset_type'
        )`
  );

  assert.equal(rows.length, 4, `expected all four search indexes, found ${rows.map(r => r.indexname).join(', ')}`);
});
