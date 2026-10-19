import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createContext, resolvers } from './resolvers';
import { CountPrecision } from './pagination';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function sampleTx(hash: string) {
  return {
    network: 'mainnet',
    hash,
    ledger: '100',
    created_at: new Date('2026-10-18T10:00:00Z'),
    source_account: 'GACCOUNT_TEST',
    fee_charged: '100',
    operation_count: 1,
    successful: true,
    memo_type: 'none',
    memo: null,
  };
}

function sampleTrade(id: string) {
  return {
    id,
    paging_token: id,
    ledger_close_time: new Date('2026-10-18T10:00:00Z'),
    trade_type: 'orderbook',
    base_account: 'GBASE_ACCOUNT',
    base_amount: '10.0000000',
    base_asset_type: 'native',
    base_asset_code: null,
    base_asset_issuer: null,
    base_offer_id: '123',
    counter_account: 'GCOUNTER_ACCOUNT',
    counter_amount: '5.0000000',
    counter_asset_type: 'credit_alphanum4',
    counter_asset_code: 'USDC',
    counter_asset_issuer: 'GISSUER_USDC',
    counter_offer_id: '456',
    base_is_seller: true,
    price_n: '1',
    price_d: '2',
    price: '0.5000000',
    network: 'mainnet',
  };
}

function createMockPool() {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM transactions\s+WHERE network = \$1/.test(sql)) {
        return { rows: [sampleTx('tx_1'), sampleTx('tx_2')] };
      }
      if (/FROM trades\s+WHERE network = \$1/.test(sql)) {
        return { rows: [sampleTrade('trade_1'), sampleTrade('trade_2')] };
      }
      if (/FROM pg_class WHERE relname = \$1/.test(sql)) {
        const table = params[0] as string;
        if (table === 'transactions') return { rows: [{ reltuples: '50000' }] }; // large -> estimate
        return { rows: [{ reltuples: '50' }] }; // small -> exact
      }
      if (/SELECT COUNT\(\*\)::bigint AS count FROM transactions/.test(sql)) {
        return { rows: [{ count: '2' }] };
      }
      if (/SELECT COUNT\(\*\)::bigint AS count FROM ledgers/.test(sql)) {
        return { rows: [{ count: '100' }] };
      }
      if (/SELECT COUNT\(\*\)::bigint AS count FROM trades/.test(sql)) {
        return { rows: [{ count: '2' }] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('duplicate queries in one request execute once against the database', async () => {
  const { pool, calls } = createMockPool();
  const context = createContext(pool);

  // Two identical queries in the same request context (e.g. two UI panels requesting latest transactions)
  const [panel1, panel2] = await Promise.all([
    resolvers.Query.transactions({}, { limit: 20 }, context),
    resolvers.Query.transactions({}, { limit: 20 }, context),
  ]);

  assert.equal(calls.length, 1);
  assert.deepEqual(panel1, panel2);
  assert.equal(panel1.items.length, 2);
});

test('nothing is shared between different requests', async () => {
  const { pool, calls } = createMockPool();

  // Two separate requests (distinct contexts)
  const request1Context = createContext(pool);
  const request2Context = createContext(pool);

  await resolvers.Query.transactions({}, { limit: 20 }, request1Context);
  await resolvers.Query.transactions({}, { limit: 20 }, request2Context);

  // Each request hits the database independently
  assert.equal(calls.length, 2);
});

test('multi-panel document with duplicate and distinct queries executes only unique database queries', async () => {
  const { pool, calls } = createMockPool();
  const context = createContext(pool);

  // Simulating a document with 4 panels:
  // Panel 1: transactions(limit: 20)
  // Panel 2: transactions(limit: 20) [duplicate]
  // Panel 3: transactions(limit: 10) [different limit]
  // Panel 4: trades(limit: 20)
  await Promise.all([
    resolvers.Query.transactions({}, { limit: 20 }, context),
    resolvers.Query.transactions({}, { limit: 20 }, context),
    resolvers.Query.transactions({}, { limit: 10 }, context),
    resolvers.Query.trades({}, { limit: 20 }, context),
  ]);

  // Expected 3 database queries instead of 4
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /FROM transactions/);
  assert.match(calls[1].sql, /FROM transactions/);
  assert.match(calls[2].sql, /FROM trades/);
});

test('returns total count where affordable and labels estimates as estimates', async () => {
  const { pool } = createMockPool();
  const context = createContext(pool);

  // 1. Transactions on large table: reltuples is 50000 (> 5000 threshold), so it returns ESTIMATE
  const txPage = await resolvers.Query.transactions({}, { limit: 20, includeTotalCount: true }, context);
  assert.ok(txPage.pageInfo.totalCount);
  assert.equal(txPage.pageInfo.totalCount.precision, CountPrecision.ESTIMATE);
  assert.equal(txPage.pageInfo.totalCount.isEstimate, true);
  assert.equal(txPage.pageInfo.totalCount.value, 50000);

  // 2. Ledgers: table is sequentially numbered and indexed, so it returns EXACT count
  const ledgerPage = await resolvers.Query.ledgers({}, { limit: 20, includeTotalCount: true }, context);
  assert.ok(ledgerPage.pageInfo.totalCount);
  assert.equal(ledgerPage.pageInfo.totalCount.precision, CountPrecision.EXACT);
  assert.equal(ledgerPage.pageInfo.totalCount.isEstimate, false);
  assert.equal(ledgerPage.pageInfo.totalCount.value, 100);

  // 3. Opt-in: when includeTotalCount is omitted or false, totalCount is null to keep cheap queries cheap
  const cheapPage = await resolvers.Query.transactions({}, { limit: 10, includeTotalCount: false }, context);
  assert.equal(cheapPage.pageInfo.totalCount, null);
});
