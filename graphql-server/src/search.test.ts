import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  assetConditions,
  decodeCursor,
  encodeCursor,
  getOperationsByAsset,
  MAX_QUERY_LENGTH,
  MIN_SIMILARITY,
  parseAsset,
  SearchError,
  searchTransactions,
} from './search';

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

interface Recorded {
  sql: string;
  params: unknown[];
}

function txRow(hash: string, memo: string, ledger = 100, rank = 0.5) {
  return {
    network: 'mainnet',
    hash,
    ledger,
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GSOURCE',
    fee_charged: '100',
    operation_count: 1,
    successful: true,
    memo_type: 'text',
    memo,
    rank,
  };
}

function opRow(id: string, details: Record<string, unknown> = {}) {
  return {
    network: 'mainnet',
    id,
    type: 'payment',
    transaction_hash: 'tx1',
    ledger: 100,
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GSOURCE',
    details,
  };
}

function fakePool(rows: unknown[] = []) {
  const calls: Recorded[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

// ── Ranking ────────────────────────────────────────────────────────────────

test('search ranks by trigram similarity, not recency', async () => {
  const { pool, calls } = fakePool([txRow('a', 'hello world')]);

  await searchTransactions(pool, { network: 'mainnet', query: 'hello', limit: 20 });

  // Ordering by ledger alone would return the newest transactions that happen
  // to match, which is not the same as the best matches.
  assert.match(calls[0]?.sql ?? '', /ORDER BY rank DESC, ledger DESC, hash DESC/);
  assert.match(calls[0]?.sql ?? '', /similarity\(memo, \$1\)/);
});

test('an exact case-insensitive memo always outranks a fuzzy match', async () => {
  const { pool, calls } = fakePool([]);

  await searchTransactions(pool, { network: 'mainnet', query: 'ORDER-4471', limit: 20 });

  // Someone pasting a full memo wants that transaction, not things resembling
  // it — so exact matches are pinned to rank 1.
  assert.match(calls[0]?.sql ?? '', /CASE WHEN lower\(memo\) = lower\(\$1\) THEN 1 ELSE 0 END/);
  assert.match(calls[0]?.sql ?? '', /GREATEST\(/);
});

test('search uses the trigram operator so the GIN index applies', async () => {
  const { pool, calls } = fakePool([]);

  await searchTransactions(pool, { network: 'mainnet', query: 'invoice', limit: 20 });

  assert.match(calls[0]?.sql ?? '', /memo % \$1/);
  // An explicit threshold keeps results independent of the session's
  // pg_trgm.similarity_threshold.
  assert.equal(calls[0]?.params[1], MIN_SIMILARITY);
});

test('search skips transactions with no memo', async () => {
  const { pool, calls } = fakePool([]);

  await searchTransactions(pool, { network: 'mainnet', query: 'x', limit: 20 });

  assert.match(calls[0]?.sql ?? '', /memo IS NOT NULL/);
});

test('the query is bound as a parameter, never interpolated', async () => {
  const { pool, calls } = fakePool([]);
  const hostile = "'; DROP TABLE transactions; --";

  await searchTransactions(pool, { network: 'mainnet', query: hostile, limit: 20 });

  assert.equal(calls[0]?.params[0], hostile);
  assert.ok(!(calls[0]?.sql ?? '').includes('DROP TABLE'));
});

test('an empty or whitespace query is rejected', async () => {
  const { pool } = fakePool([]);

  await assert.rejects(() => searchTransactions(pool, { network: 'mainnet', query: '   ', limit: 20 }), SearchError);
  await assert.rejects(() => searchTransactions(pool, { network: 'mainnet', query: '', limit: 20 }), SearchError);
});

test('an absurdly long query is rejected rather than run', async () => {
  const { pool } = fakePool([]);

  await assert.rejects(
    () => searchTransactions(pool, { network: 'mainnet', query: 'x'.repeat(MAX_QUERY_LENGTH + 1), limit: 20 }),
    SearchError
  );
});

// ── Pagination ─────────────────────────────────────────────────────────────

test('a cursor round-trips through its encoding', () => {
  const cursor = { rank: 0.42, ledger: 1234, hash: 'abc' };

  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
});

test('a malformed cursor decodes to null rather than throwing', () => {
  assert.equal(decodeCursor('not-base64-at-all!!'), null);
  assert.equal(decodeCursor(Buffer.from('{}').toString('base64url')), null);
  assert.equal(decodeCursor(Buffer.from('{"rank":"high"}').toString('base64url')), null);
});

test('search returns the cursor for the next page from the last row', async () => {
  const { pool } = fakePool([txRow('a', 'one', 300, 0.9), txRow('b', 'two', 200, 0.4)]);

  const { nextCursor } = await searchTransactions(pool, { network: 'mainnet', query: 'o', limit: 2 });

  assert.deepEqual(decodeCursor(nextCursor!), { rank: 0.4, ledger: 200, hash: 'b' });
});

test('an exhausted search returns no cursor', async () => {
  const { pool } = fakePool([]);

  const { items, nextCursor } = await searchTransactions(pool, { network: 'mainnet', query: 'nothing', limit: 20 });

  assert.deepEqual(items, []);
  assert.equal(nextCursor, null);
});

test('paging keysets on the whole ranking tuple, so a page boundary is stable', async () => {
  const { pool, calls } = fakePool([]);
  const cursor = encodeCursor({ rank: 0.5, ledger: 900, hash: 'zzz' });

  await searchTransactions(pool, { network: 'mainnet', query: 'hello', limit: 20, cursor });

  // An OFFSET would shift every subsequent page by one as new matching
  // transactions land, duplicating a row across the seam.
  assert.ok(!/OFFSET/i.test(calls[0]?.sql ?? ''));
  assert.match(calls[0]?.sql ?? '', /\(.*similarity.*, ledger, hash\) < \(\$\d+::real, \$\d+::bigint, \$\d+\)/s);
  assert.deepEqual(calls[0]?.params.slice(3, 6), [0.5, 900, 'zzz']);
});

test('an invalid cursor is rejected rather than silently ignored', async () => {
  const { pool } = fakePool([]);

  // Silently dropping it would restart pagination from the top, which reads to
  // a client as duplicate results rather than an error.
  await assert.rejects(
    () => searchTransactions(pool, { network: 'mainnet', query: 'x', limit: 20, cursor: 'garbage!!' }),
    SearchError
  );
});

// ── Asset parsing ──────────────────────────────────────────────────────────

test('a CODE:ISSUER asset parses into its parts', () => {
  assert.deepEqual(parseAsset(`USDC:${ISSUER}`), {
    code: 'USDC',
    issuer: ISSUER,
    native: false,
  });
});

test('XLM and native both mean the native asset', () => {
  // Native payments carry no code or issuer, only asset_type — without this
  // the most common asset on the network would be unfindable.
  for (const input of ['XLM', 'xlm', 'native', 'NATIVE']) {
    assert.deepEqual(parseAsset(input), { code: null, issuer: null, native: true });
  }
});

test('a malformed asset filter is rejected with the expected form named', () => {
  for (const bad of ['USDC', `:${ISSUER}`, 'USDC:', `USDC:${ISSUER}:extra`, '  ']) {
    assert.throws(() => parseAsset(bad), SearchError, `should reject ${JSON.stringify(bad)}`);
  }
});

// ── Asset filtering ────────────────────────────────────────────────────────

test('an asset filter matches payments and both sides of an offer', () => {
  const params: unknown[] = [];
  const sql = assetConditions(parseAsset(`USDC:${ISSUER}`), params);

  // Checking only asset_code would silently miss every trade in the asset.
  assert.match(sql, /details->>'asset_code'/);
  assert.match(sql, /details->>'selling_asset_code'/);
  assert.match(sql, /details->>'buying_asset_code'/);
  assert.deepEqual(params, ['USDC', ISSUER]);
});

test('an asset filter requires code and issuer together', () => {
  const params: unknown[] = [];
  const sql = assetConditions(parseAsset(`USDC:${ISSUER}`), params);

  // Matching on code alone would mix up every USDC lookalike from a different
  // issuer, which is exactly the confusion asset issuers exist to prevent.
  assert.match(sql, /asset_code' = \$1 AND details->>'asset_issuer' = \$2/);
});

test('the native filter matches on asset_type across all three roles', () => {
  const params: unknown[] = [];
  const sql = assetConditions(parseAsset('XLM'), params);

  assert.deepEqual(params, ['native']);
  assert.match(sql, /details->>'asset_type' = \$1/);
  assert.match(sql, /details->>'selling_asset_type' = \$1/);
  assert.match(sql, /details->>'buying_asset_type' = \$1/);
});

test('getOperationsByAsset scopes, orders and limits', async () => {
  const { pool, calls } = fakePool([opRow('op1', { asset_code: 'USDC' })]);

  await getOperationsByAsset(pool, { network: 'mainnet', asset: `USDC:${ISSUER}`, limit: 10 });

  assert.match(calls[0]?.sql ?? '', /FROM operations/);
  assert.match(calls[0]?.sql ?? '', /ORDER BY ledger DESC, id DESC/);
  assert.equal(calls[0]?.params.at(-1), 10);
});

test('an asset filter composes with account and type filters', async () => {
  const { pool, calls } = fakePool([]);

  await getOperationsByAsset(pool, {
    network: 'mainnet',
    asset: `USDC:${ISSUER}`,
    account: 'GACCOUNT',
    type: 'PAYMENT',
    limit: 5,
  });

  assert.match(calls[0]?.sql ?? '', /network = \$1/);
  assert.match(calls[0]?.sql ?? '', /source_account = \$4/);
  assert.match(calls[0]?.sql ?? '', /type = \$5/);
  // Types are stored lowercase but the GraphQL enum is uppercase.
  assert.equal(calls[0]?.params[4], 'payment');
});

test('an asset query paginates by keyset rather than offset', async () => {
  const { pool, calls } = fakePool([]);

  await getOperationsByAsset(pool, { network: 'mainnet', asset: 'XLM', limit: 5, cursor: 'op99' });

  assert.ok(!/OFFSET/i.test(calls[0]?.sql ?? ''));
  assert.match(calls[0]?.sql ?? '', /\(ledger, id\) </);
  assert.ok(calls[0]?.params.includes('op99'));
});

test('an invalid asset is rejected before any query runs', async () => {
  const { pool, calls } = fakePool([]);

  await assert.rejects(() => getOperationsByAsset(pool, { network: 'mainnet', asset: 'USDC', limit: 5 }), SearchError);
  assert.equal(calls.length, 0);
});
