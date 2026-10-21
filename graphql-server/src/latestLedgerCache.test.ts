import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLatestLedgerCache } from './latestLedgerCache';
import { latestLedgerCacheInvalidations, latestLedgerCacheRequests, registry } from './metrics';

async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await registry.getSingleMetric(name)?.get();
  return metric?.values.find(value =>
    Object.entries(labels).every(([key, expected]) => String(value.labels[key]) === expected)
  )?.value ?? 0;
}

test('ledger notification invalidates only the affected network before TTL expiry', async () => {
  let now = 1_000;
  const cache = createLatestLedgerCache(4_000, () => now);
  const invalidationsBefore = await metricValue('lumina_graphql_latest_ledger_cache_invalidations_total', {
    network: 'mainnet',
    reason: 'ledger_notification',
  });
  cache.set('mainnet', { sequence: 10 });
  cache.set('testnet', { sequence: 20 });

  assert.deepEqual(cache.get('mainnet'), { sequence: 10 });
  assert.equal(cache.invalidate('mainnet'), 1);
  assert.equal(cache.get('mainnet'), undefined);
  assert.deepEqual(cache.get('testnet'), { sequence: 20 });
  assert.equal(
    await metricValue('lumina_graphql_latest_ledger_cache_invalidations_total', {
      network: 'mainnet',
      reason: 'ledger_notification',
    }),
    invalidationsBefore + 1
  );

  now += 1_000;
  assert.equal(cache.get('mainnet'), undefined);
});

test('TTL expiry remains a backstop and cache hit rate is measurable', async () => {
  let now = 5_000;
  const cache = createLatestLedgerCache(100, () => now);
  const network = 'cache-test';
  const hitBefore = await metricValue('lumina_graphql_latest_ledger_cache_requests_total', { result: 'hit' });
  const missBefore = await metricValue('lumina_graphql_latest_ledger_cache_requests_total', { result: 'miss' });
  const invalidationBefore = await metricValue('lumina_graphql_latest_ledger_cache_invalidations_total', { network, reason: 'ttl_expired' });

  cache.set(network, { sequence: 30 });
  assert.deepEqual(cache.get(network), { sequence: 30 });
  now += 101;
  assert.equal(cache.get(network), undefined);

  assert.equal(await metricValue('lumina_graphql_latest_ledger_cache_requests_total', { result: 'hit' }), hitBefore + 1);
  assert.equal(await metricValue('lumina_graphql_latest_ledger_cache_requests_total', { result: 'miss' }), missBefore + 1);
  assert.equal(await metricValue('lumina_graphql_latest_ledger_cache_invalidations_total', { network, reason: 'ttl_expired' }), invalidationBefore + 1);
});

test('unspecified network notifications invalidate all cached networks', () => {
  const cache = createLatestLedgerCache(100_000);
  cache.set('mainnet', 1);
  cache.set('testnet', 2);

  assert.equal(cache.invalidate(undefined, 'ledger_notification'), 2);
  assert.equal(cache.get('mainnet'), undefined);
  assert.equal(cache.get('testnet'), undefined);
});

test('a pre-notification read cannot repopulate the invalidated cache', () => {
  const cache = createLatestLedgerCache(100_000);
  const generation = cache.generation('mainnet');

  cache.invalidate('mainnet');

  assert.equal(cache.setIfGeneration('mainnet', generation, { sequence: 10 }), false);
  assert.equal(cache.get('mainnet'), undefined);
});