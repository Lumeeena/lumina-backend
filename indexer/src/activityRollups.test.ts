import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import {
  backfillActivityRollups,
  bucketEndFor,
  bucketStartFor,
  refreshActivityRollupsForTimestamp,
} from './activityRollups';

test('bucketStartFor and bucketEndFor align UTC hour and day boundaries cleanly', () => {
  assert.equal(bucketStartFor('2026-03-31T23:59:59.999Z', 'hour'), '2026-03-31T23:00:00.000Z');
  assert.equal(bucketEndFor('2026-03-31T23:00:00.000Z', 'hour'), '2026-04-01T00:00:00.000Z');

  assert.equal(bucketStartFor('2026-03-31T23:59:59.999Z', 'day'), '2026-03-31T00:00:00.000Z');
  assert.equal(bucketEndFor('2026-03-31T00:00:00.000Z', 'day'), '2026-04-01T00:00:00.000Z');

  // Exact boundary timestamp belongs to the bucket starting at that instant.
  assert.equal(bucketStartFor('2026-02-28T00:00:00.000Z', 'hour'), '2026-02-28T00:00:00.000Z');
  assert.equal(bucketStartFor('2026-02-28T00:00:00.000Z', 'day'), '2026-02-28T00:00:00.000Z');
  assert.equal(bucketEndFor('2026-02-28T00:00:00.000Z', 'day'), '2026-03-01T00:00:00.000Z');
});

test('bucketStartFor rejects invalid timestamps', () => {
  assert.throws(() => bucketStartFor('not-a-date', 'hour'), /Invalid ledger timestamp/);
});

test('refreshActivityRollupsForTimestamp updates hour and day buckets idempotently on reindex', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fakeClient = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  } as unknown as PoolClient;

  // Simulate indexing and then reindexing the exact same ledger timestamp.
  await refreshActivityRollupsForTimestamp(fakeClient, 'testnet', '2026-05-10T14:42:15Z');
  await refreshActivityRollupsForTimestamp(fakeClient, 'testnet', '2026-05-10T14:42:15Z');

  assert.equal(calls.length, 4);
  // First pass: hour then day.
  assert.deepEqual(calls[0]?.params, [
    'testnet',
    'hour',
    '2026-05-10T14:00:00.000Z',
    '2026-05-10T15:00:00.000Z',
  ]);
  assert.deepEqual(calls[1]?.params, [
    'testnet',
    'day',
    '2026-05-10T00:00:00.000Z',
    '2026-05-11T00:00:00.000Z',
  ]);
  // Second pass (reindex) recomputes the exact same bucket via DO UPDATE (never +=).
  assert.deepEqual(calls[2]?.params, calls[0]?.params);
  assert.deepEqual(calls[3]?.params, calls[1]?.params);
  assert.match(calls[0]!.sql, /ON CONFLICT \(network, granularity, bucket_start\) DO UPDATE SET/);
  assert.match(calls[0]!.sql, /transaction_count = EXCLUDED\.transaction_count/);
  assert.doesNotMatch(calls[0]!.sql, /activity_rollups\.transaction_count \+/);
});

test('backfillActivityRollups runs idempotent full-range and bounded-range rollups', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fakePool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rowCount: params[1] === 'hour' ? 24 : 1, rows: [] };
    },
  } as unknown as Pool;

  const result = await backfillActivityRollups(fakePool, 'mainnet', {
    startTime: '2026-05-01T00:00:00Z',
    endTime: '2026-05-02T00:00:00Z',
  });

  assert.deepEqual(result, { network: 'mainnet', hourBuckets: 24, dayBuckets: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.params, [
    'mainnet',
    'hour',
    '2026-05-01T00:00:00Z',
    '2026-05-02T00:00:00Z',
  ]);
  assert.match(calls[0]!.sql, /ON CONFLICT \(network, granularity, bucket_start\) DO UPDATE SET/);
});
