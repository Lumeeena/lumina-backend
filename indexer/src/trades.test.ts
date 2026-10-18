import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { insertTrades, getLatestTradePagingToken } from './db';
import type { HorizonTrade } from './horizon';

function fakeTradesPool() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT paging_token FROM trades')) {
        return { rows: [{ paging_token: '12345-0' }] };
      }
      return { rows: [] };
    },
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        clientQueries.push({ sql, params });
        return { rows: [] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  return { pool, queries, clientQueries };
}

test('getLatestTradePagingToken returns highest token from database', async () => {
  const { pool, queries } = fakeTradesPool();
  const token = await getLatestTradePagingToken(pool, 'mainnet');
  assert.equal(token, '12345-0');
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /FROM trades/);
  assert.deepEqual(queries[0].params, ['mainnet']);
});

test('a path payment crossing several offers produces several trade rows from /trades endpoint', async () => {
  const { pool, clientQueries } = fakeTradesPool();

  // A path payment crossing 3 distinct DEX offers produces 3 trade records in Horizon /trades:
  // Leg 1: XLM -> USDC (offer 101)
  // Leg 2: USDC -> EURC (offer 202)
  // Leg 3: EURC -> BTC (offer 303)
  const pathPaymentOperationId = '987654321000';
  const trades: HorizonTrade[] = [
    {
      id: `${pathPaymentOperationId}-0`,
      paging_token: `${pathPaymentOperationId}-0`,
      ledger_close_time: '2026-10-18T12:00:00Z',
      trade_type: 'orderbook',
      base_account: 'GUSER_SENDER',
      base_amount: '100.0000000',
      base_asset_type: 'native',
      counter_account: 'GMARKET_MAKER_1',
      counter_amount: '25.0000000',
      counter_asset_type: 'credit_alphanum4',
      counter_asset_code: 'USDC',
      counter_asset_issuer: 'GISSUER_USDC',
      counter_offer_id: '101',
      base_is_seller: true,
      price: { n: '1', d: '4' },
    },
    {
      id: `${pathPaymentOperationId}-1`,
      paging_token: `${pathPaymentOperationId}-1`,
      ledger_close_time: '2026-10-18T12:00:00Z',
      trade_type: 'orderbook',
      base_account: 'GUSER_SENDER',
      base_amount: '25.0000000',
      base_asset_type: 'credit_alphanum4',
      base_asset_code: 'USDC',
      base_asset_issuer: 'GISSUER_USDC',
      base_offer_id: '101',
      counter_account: 'GMARKET_MAKER_2',
      counter_amount: '22.5000000',
      counter_asset_type: 'credit_alphanum4',
      counter_asset_code: 'EURC',
      counter_asset_issuer: 'GISSUER_EURC',
      counter_offer_id: '202',
      base_is_seller: true,
      price: { n: '9', d: '10' },
    },
    {
      id: `${pathPaymentOperationId}-2`,
      paging_token: `${pathPaymentOperationId}-2`,
      ledger_close_time: '2026-10-18T12:00:00Z',
      trade_type: 'orderbook',
      base_account: 'GUSER_SENDER',
      base_amount: '22.5000000',
      base_asset_type: 'credit_alphanum4',
      base_asset_code: 'EURC',
      base_asset_issuer: 'GISSUER_EURC',
      base_offer_id: '202',
      counter_account: 'GMARKET_MAKER_3',
      counter_amount: '0.0003500',
      counter_asset_type: 'credit_alphanum4',
      counter_asset_code: 'BTC',
      counter_asset_issuer: 'GISSUER_BTC',
      counter_offer_id: '303',
      base_is_seller: true,
      price: { n: '7', d: '450000' },
    },
  ];

  await insertTrades(pool, 'mainnet', trades);

  // BEGIN, 3 INSERT statements, COMMIT
  assert.equal(clientQueries.length, 5);
  assert.equal(clientQueries[0].sql, 'BEGIN');
  assert.equal(clientQueries[4].sql, 'COMMIT');

  // Verify all 3 distinct trades were inserted with their offer IDs and asset pairs
  const inserts = clientQueries.slice(1, 4);
  assert.equal(inserts.length, 3);

  // Check leg 1 (XLM -> USDC)
  assert.equal(inserts[0].params[0], `${pathPaymentOperationId}-0`);
  assert.equal(inserts[0].params[4], 'GUSER_SENDER'); // base_account
  assert.equal(inserts[0].params[5], '100.0000000'); // base_amount
  assert.equal(inserts[0].params[6], 'native'); // base_asset_type
  assert.equal(inserts[0].params[10], 'GMARKET_MAKER_1'); // counter_account
  assert.equal(inserts[0].params[11], '25.0000000'); // counter_amount
  assert.equal(inserts[0].params[13], 'USDC'); // counter_asset_code
  assert.equal(inserts[0].params[15], '101'); // counter_offer_id

  // Check leg 2 (USDC -> EURC)
  assert.equal(inserts[1].params[0], `${pathPaymentOperationId}-1`);
  assert.equal(inserts[1].params[7], 'USDC'); // base_asset_code
  assert.equal(inserts[1].params[13], 'EURC'); // counter_asset_code
  assert.equal(inserts[1].params[15], '202'); // counter_offer_id

  // Check leg 3 (EURC -> BTC)
  assert.equal(inserts[2].params[0], `${pathPaymentOperationId}-2`);
  assert.equal(inserts[2].params[7], 'EURC'); // base_asset_code
  assert.equal(inserts[2].params[13], 'BTC'); // counter_asset_code
  assert.equal(inserts[2].params[15], '303'); // counter_offer_id
});
