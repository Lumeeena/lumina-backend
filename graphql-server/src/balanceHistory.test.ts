import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { computeBalanceHistory } from './balanceHistory';
import { InvalidInputError } from './errorCodes';

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function fakePool(
  inRangeRows: unknown[] = [],
  beforeRows: unknown[] = []
): { pool: Pool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  let callIndex = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const rows = callIndex === 0 ? inRangeRows : beforeRows;
      callIndex += 1;
      return { rows };
    },
  } as unknown as Pool;
  return { pool, queries };
}

test('computeBalanceHistory replays prior and in-range native XLM operations', async () => {
  const address = 'GADDR111111111111111111111111111111111111111111111111111';
  const from = '2026-01-05T00:00:00.000Z';
  const to = '2026-01-20T00:00:00.000Z';

  // Returned in DESC order by the pre-range query; replayed oldest-first.
  const beforeRows = [
    {
      id: 'op-pre-2',
      type: 'payment',
      created_at: '2026-01-02T00:00:00.000Z',
      source_account: 'GOTHER',
      details: { asset_type: 'native', from: 'GOTHER', to: address, amount: '25.5000000' },
    },
    {
      id: 'op-pre-1',
      type: 'create_account',
      created_at: '2026-01-01T00:00:00.000Z',
      source_account: 'GFUNDER',
      details: { account: address, funder: 'GFUNDER', starting_balance: '100.0000000' },
    },
  ];

  const inRangeRows = [
    {
      id: 'op-1',
      type: 'payment',
      created_at: '2026-01-10T10:00:00.000Z',
      source_account: address,
      details: { asset_type: 'native', from: address, to: 'GBOB', amount: '10.2500000' },
    },
    {
      id: 'op-2',
      type: 'change_trust',
      created_at: '2026-01-11T10:00:00.000Z',
      source_account: address,
      details: { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER' },
    },
    {
      id: 'op-3',
      type: 'payment',
      created_at: '2026-01-12T10:00:00.000Z',
      source_account: 'GOTHER',
      details: {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUER',
        from: 'GOTHER',
        to: address,
        amount: '50.0000000',
      },
    },
    {
      id: 'op-4',
      type: 'create_account',
      created_at: '2026-01-13T10:00:00.000Z',
      source_account: address,
      details: { account: 'GNEW', funder: address, starting_balance: '5.2500000' },
    },
    {
      id: 'op-5',
      type: 'account_merge',
      created_at: '2026-01-14T10:00:00.000Z',
      source_account: address,
      details: { into: 'GBOB' },
    },
  ];

  const { pool, queries } = fakePool(inRangeRows, beforeRows);
  const result = await computeBalanceHistory(pool, 'mainnet', address, 'XLM', from, to);

  assert.equal(result.address, address);
  assert.equal(result.asset, 'XLM');
  assert.equal(result.from, from);
  assert.equal(result.to, to);
  assert.deepEqual(result.snapshots, [
    { timestamp: from, balance: '125.5', operationId: 'initial' },
    { timestamp: '2026-01-10T10:00:00.000Z', balance: '115.25', operationId: 'op-1' },
    { timestamp: '2026-01-13T10:00:00.000Z', balance: '110', operationId: 'op-4' },
    { timestamp: '2026-01-14T10:00:00.000Z', balance: '0', operationId: 'op-5' },
  ]);

  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0]!.params, ['mainnet', from, to, address]);
  assert.deepEqual(queries[1]!.params, ['mainnet', from, address, 100]);
});

test('computeBalanceHistory replays issued asset payments and path payments', async () => {
  const address = 'GADDR222222222222222222222222222222222222222222222222222';
  const issuer = 'GISSUER1111111111111111111111111111111111111111111111111';
  const from = '2026-02-01T00:00:00.000Z';
  const to = '2026-02-10T00:00:00.000Z';

  const inRangeRows = [
    {
      id: 'op-pp-1',
      type: 'path_payment_strict_receive',
      created_at: '2026-02-02T12:00:00.000Z',
      source_account: 'GOTHER',
      details: {
        source_asset_type: 'native',
        source_amount: '100.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: issuer,
        from: 'GOTHER',
        to: address,
        amount: '40.0000000',
      },
    },
    {
      id: 'op-pp-2',
      type: 'path_payment_strict_send',
      created_at: '2026-02-03T12:00:00.000Z',
      source_account: address,
      details: {
        source_asset_type: 'credit_alphanum4',
        source_asset_code: 'USDC',
        source_asset_issuer: issuer,
        source_amount: '12.5000000',
        asset_type: 'native',
        from: address,
        to: 'GBOB',
        amount: '30.0000000',
      },
    },
  ];

  const { pool } = fakePool(inRangeRows, []);
  const result = await computeBalanceHistory(pool, 'testnet', address, `USDC:${issuer}`, from, to);

  assert.deepEqual(result.snapshots, [
    { timestamp: from, balance: '0', operationId: 'initial' },
    { timestamp: '2026-02-02T12:00:00.000Z', balance: '40', operationId: 'op-pp-1' },
    { timestamp: '2026-02-03T12:00:00.000Z', balance: '27.5', operationId: 'op-pp-2' },
  ]);
});

test('computeBalanceHistory omits initial snapshot when empty and zero balance', async () => {
  const { pool } = fakePool([], []);
  const result = await computeBalanceHistory(
    pool,
    'mainnet',
    'GEMPTY',
    'XLM',
    '2026-03-01T00:00:00.000Z',
    '2026-03-10T00:00:00.000Z'
  );
  assert.deepEqual(result.snapshots, []);
});

test('computeBalanceHistory emits initial snapshot when no in-range ops but positive prior balance', async () => {
  const address = 'GHOLDER';
  const from = '2026-03-05T00:00:00.000Z';
  const to = '2026-03-10T00:00:00.000Z';
  const beforeRows = [
    {
      id: 'op-prior',
      type: 'create_account',
      created_at: '2026-03-01T00:00:00.000Z',
      source_account: 'GFUNDER',
      details: { account: address, funder: 'GFUNDER', starting_balance: '50.0000000' },
    },
  ];

  const { pool } = fakePool([], beforeRows);
  const result = await computeBalanceHistory(pool, 'mainnet', address, 'native', from, to);

  assert.deepEqual(result.snapshots, [
    { timestamp: from, balance: '50', operationId: 'initial' },
  ]);
});

test('computeBalanceHistory defaults to a 30-day window when from and to are omitted', async () => {
  const { pool } = fakePool([], []);
  const result = await computeBalanceHistory(pool, 'mainnet', 'GADDR', 'XLM');
  const diffMs = new Date(result.to).getTime() - new Date(result.from).getTime();
  assert.equal(diffMs, 30 * 24 * 60 * 60 * 1000);
});

test('computeBalanceHistory validates time range and asset format', async () => {
  const { pool } = fakePool([], []);

  await assert.rejects(
    () =>
      computeBalanceHistory(
        pool,
        'mainnet',
        'GADDR',
        'XLM',
        '2026-01-01T00:00:00.000Z',
        '2026-04-15T00:00:00.000Z'
      ),
    (err: unknown) => err instanceof InvalidInputError && /maximum of 90 days/.test(err.message)
  );

  await assert.rejects(
    () =>
      computeBalanceHistory(
        pool,
        'mainnet',
        'GADDR',
        'XLM',
        '2026-02-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z'
      ),
    (err: unknown) => err instanceof InvalidInputError && /from must be before to/.test(err.message)
  );

  await assert.rejects(
    () => computeBalanceHistory(pool, 'mainnet', 'GADDR', 'INVALID_ASSET'),
    (err: unknown) => err instanceof InvalidInputError && /Invalid asset format/.test(err.message)
  );
});
