import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  AssetError,
  balanceConditions,
  DEFAULT_BUCKET_SECONDS,
  getAssetDetail,
  getAssetSupply,
  getAssetVolumeSeries,
  MAX_BUCKETS,
  resolveRange,
} from './assets';
import { parseAsset } from './search';

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ASSET = `USDC:${ISSUER}`;
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-03T00:00:00.000Z';

interface Recorded {
  sql: string;
  params: unknown[];
}

function fakePool(handler: (sql: string, params: unknown[]) => unknown[]) {
  const calls: Recorded[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: handler(sql, params) };
    },
  } as unknown as Pool;
  return { pool, calls };
}

// ── Range validation ─────────────────────────────────────────────────────────

test('a missing range defaults to daily buckets', () => {
  const range = resolveRange({ asset: ASSET });
  assert.equal(range.bucketSeconds, DEFAULT_BUCKET_SECONDS);
  assert.ok(range.start < range.end);
});

test('an invalid asset is rejected before any query runs', async () => {
  const { pool, calls } = fakePool(() => []);
  await assert.rejects(() => getAssetDetail(pool, { asset: 'USDC', from: FROM, to: TO }));
  assert.equal(calls.length, 0);
});

test('an unparseable timestamp is rejected', () => {
  assert.throws(() => resolveRange({ asset: ASSET, from: 'not-a-date', to: TO }), AssetError);
});

test('a range running backwards is rejected', () => {
  assert.throws(() => resolveRange({ asset: ASSET, from: TO, to: FROM }), AssetError);
});

test('a sub-minute bucket is rejected', () => {
  assert.throws(() => resolveRange({ asset: ASSET, from: FROM, to: TO, bucketSeconds: 30 }), AssetError);
  assert.throws(() => resolveRange({ asset: ASSET, from: FROM, to: TO, bucketSeconds: 1.5 }), AssetError);
});

test('a range needing more buckets than the cap is rejected', () => {
  // Two days at 60s buckets = 2880 buckets, above the cap.
  assert.throws(
    () => resolveRange({ asset: ASSET, from: FROM, to: TO, bucketSeconds: 60 }),
    /above the limit/
  );
  // Same range at daily buckets fits.
  assert.doesNotThrow(() => resolveRange({ asset: ASSET, from: FROM, to: TO, bucketSeconds: 86400 }));
  assert.ok(MAX_BUCKETS >= 1000);
});

// ── Supply ───────────────────────────────────────────────────────────────────

test('an issued-asset supply query matches code and issuer together', async () => {
  const { pool, calls } = fakePool(() => [{ holders: 2, supply: '250.5' }]);
  const result = await getAssetSupply(pool, parseAsset(ASSET));

  assert.match(calls[0]?.sql ?? '', /jsonb_array_elements\(balances\)/);
  assert.match(calls[0]?.sql ?? '', /b->>'asset_code' = \$1 AND b->>'asset_issuer' = \$2/);
  assert.deepEqual(calls[0]?.params, ['USDC', ISSUER]);
  assert.deepEqual(result, { supply: '250.5', holders: 2 });
});

test('a native supply query matches on asset_type', async () => {
  const { pool, calls } = fakePool(() => [{ holders: 1, supply: '1000' }]);
  const result = await getAssetSupply(pool, parseAsset('XLM'));

  assert.match(calls[0]?.sql ?? '', /b->>'asset_type' = \$1/);
  assert.deepEqual(calls[0]?.params, ['native']);
  assert.equal(result.supply, '1000');
});

test('zero-balance trustlines do not count as holders', async () => {
  const { pool, calls } = fakePool(() => []);
  await getAssetSupply(pool, parseAsset(ASSET));

  assert.match(calls[0]?.sql ?? '', /\(b->>'balance'\)::numeric > 0/);
});

test('an asset nobody holds reports zero supply, not null', async () => {
  const { pool } = fakePool(() => []);
  const result = await getAssetSupply(pool, parseAsset(ASSET));

  assert.deepEqual(result, { supply: '0', holders: 0 });
});

test('balanceConditions binds code and issuer as parameters, never interpolated', () => {
  const params: unknown[] = [];
  const sql = balanceConditions(parseAsset(ASSET), params);
  assert.ok(!sql.includes(ISSUER));
  assert.deepEqual(params, ['USDC', ISSUER]);
});

// ── Volume series ────────────────────────────────────────────────────────────

test('the series reuses the operations asset predicate', async () => {
  const { pool, calls } = fakePool(() => []);
  await getAssetVolumeSeries(pool, parseAsset(ASSET), {
    start: new Date(FROM),
    end: new Date(TO),
    bucketSeconds: 86400,
  });

  // Same three-role predicate the operations(asset:) filter uses, so the
  // series always agrees with the operation list.
  assert.match(calls[0]?.sql ?? '', /details->>'asset_code'/);
  assert.match(calls[0]?.sql ?? '', /details->>'selling_asset_code'/);
  assert.match(calls[0]?.sql ?? '', /details->>'buying_asset_code'/);
});

test('the series zero-fills empty buckets in ascending order', async () => {
  const { pool } = fakePool(() => [
    {
      bucket_start: new Date('2026-01-01T00:00:00.000Z'),
      bucket_end: new Date('2026-01-02T00:00:00.000Z'),
      volume: '150.25',
      operation_count: 3,
    },
    {
      bucket_start: new Date('2026-01-02T00:00:00.000Z'),
      bucket_end: new Date('2026-01-03T00:00:00.000Z'),
      volume: '0',
      operation_count: 0,
    },
  ]);
  const series = await getAssetVolumeSeries(pool, parseAsset(ASSET), {
    start: new Date(FROM),
    end: new Date(TO),
    bucketSeconds: 86400,
  });

  assert.deepEqual(series, [
    {
      bucketStart: '2026-01-01T00:00:00.000Z',
      bucketEnd: '2026-01-02T00:00:00.000Z',
      volume: '150.25',
      operationCount: 3,
    },
    {
      bucketStart: '2026-01-02T00:00:00.000Z',
      bucketEnd: '2026-01-03T00:00:00.000Z',
      volume: '0',
      operationCount: 0,
    },
  ]);
});

test('the bucket width reaches SQL only as a number, never interpolated', async () => {
  const { pool, calls } = fakePool(() => []);
  await getAssetVolumeSeries(pool, parseAsset(ASSET), {
    start: new Date(FROM),
    end: new Date(TO),
    bucketSeconds: 3600,
  });

  assert.ok(!/3600 seconds/.test(calls[0]?.sql ?? ''));
  assert.match(calls[0]?.sql ?? '', /\$3 \* INTERVAL '1 second'/);
  assert.equal(calls[0]?.params[2], 3600);
});

// ── One call ─────────────────────────────────────────────────────────────────

test('one detail call returns supply, holders and the series', async () => {
  const { pool, calls } = fakePool((sql: string) => {
    if (/FROM accounts/.test(sql)) return [{ holders: 4, supply: '1000.75' }];
    return [
      {
        bucket_start: new Date(FROM),
        bucket_end: new Date('2026-01-02T00:00:00.000Z'),
        volume: '10',
        operation_count: 1,
      },
    ];
  });

  const detail = await getAssetDetail(pool, { asset: ASSET, from: FROM, to: TO, bucketSeconds: 86400 });

  assert.equal(calls.length, 2);
  assert.equal(detail.asset, ASSET);
  assert.equal(detail.code, 'USDC');
  assert.equal(detail.issuer, ISSUER);
  assert.equal(detail.native, false);
  assert.equal(detail.supply, '1000.75');
  assert.equal(detail.holders, 4);
  assert.equal(detail.series.length, 1);
  assert.equal(detail.series[0]?.volume, '10');
});

test('a native detail normalizes the asset display string', async () => {
  const { pool } = fakePool((sql: string) => {
    if (/FROM accounts/.test(sql)) return [{ holders: 1, supply: '5' }];
    return [];
  });

  const detail = await getAssetDetail(pool, { asset: 'xlm', from: FROM, to: TO });
  assert.equal(detail.asset, 'XLM');
  assert.equal(detail.native, true);
  assert.equal(detail.code, null);
});
