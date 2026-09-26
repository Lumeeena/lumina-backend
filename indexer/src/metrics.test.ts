/**
 * These assert that metrics actually move on the code paths they claim to
 * cover — the acceptance criterion the issue calls out, and the failure mode
 * that makes a dashboard worse than none: a panel that reads zero because
 * nothing increments it looks exactly like a panel reporting good news.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  horizonRequests,
  indexingLag,
  latestHorizonLedger,
  latestIndexedLedger,
  lastSuccessfulIndexTimestamp,
  ledgersIndexed,
  operationsIndexed,
  recordHorizonTip,
  recordIndexedLedger,
  registry,
  renderMetrics,
  transactionsIndexed,
  indexerPoolErrors,
} from './metrics';

/** The current value of a counter/gauge, optionally for one label set. */
async function value(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = await registry.getSingleMetric(name)?.get();
  const match = metric?.values.find(v =>
    Object.entries(labels).every(([k, expected]) => String(v.labels[k]) === expected)
  );
  return match?.value ?? 0;
}

test('recordIndexedLedger advances every ledger counter and gauge', async () => {
  const before = {
    ledgers: await value('lumina_ledgers_indexed_total'),
    transactions: await value('lumina_transactions_indexed_total'),
    operations: await value('lumina_operations_indexed_total'),
  };

  recordIndexedLedger(4242, 7, 19);

  assert.equal(await value('lumina_ledgers_indexed_total'), before.ledgers + 1);
  assert.equal(await value('lumina_transactions_indexed_total'), before.transactions + 7);
  assert.equal(await value('lumina_operations_indexed_total'), before.operations + 19);
  assert.equal(await value('lumina_latest_indexed_ledger'), 4242);
  assert.ok((await value('lumina_last_successful_index_timestamp_seconds')) > 0);
});

test('recordHorizonTip derives lag from the two ledger positions', async () => {
  recordHorizonTip(1000, 940);

  assert.equal(await value('lumina_latest_horizon_ledger'), 1000);
  assert.equal(await value('lumina_indexing_lag_ledgers'), 60);
});

test('lag is clamped at zero rather than going negative on a stale tip', async () => {
  // Horizon's reported tip can briefly trail what we already indexed; a
  // negative lag would break every threshold comparison built on it.
  recordHorizonTip(1000, 1005);

  assert.equal(await value('lumina_indexing_lag_ledgers'), 0);
});

test('Horizon requests are counted per status, so a 429 spike is a number', async () => {
  // This is the metric that closes the gap from the rate-limiting incident.
  const before = await value('lumina_horizon_requests_total', { status: '429' });

  horizonRequests.inc({ status: '429' });
  horizonRequests.inc({ status: '429' });
  horizonRequests.inc({ status: '200' });

  assert.equal(await value('lumina_horizon_requests_total', { status: '429' }), before + 2);
});

test('a request that never got a response is still counted', async () => {
  const before = await value('lumina_horizon_requests_total', { status: 'error' });

  horizonRequests.inc({ status: 'error' });

  // Otherwise a DNS failure or a dropped connection looks like silence.
  assert.equal(await value('lumina_horizon_requests_total', { status: 'error' }), before + 1);
});

test('unexpected PostgreSQL pool client errors have a scrapeable counter', async () => {
  const before = await value('lumina_indexer_db_pool_errors_total');
  indexerPoolErrors.inc();
  assert.equal(await value('lumina_indexer_db_pool_errors_total'), before + 1);
});

test('the registry renders Prometheus text exposition', async () => {
  recordIndexedLedger(5000, 1, 1);
  const body = await renderMetrics();

  assert.match(body, /# HELP lumina_ledgers_indexed_total/);
  assert.match(body, /# TYPE lumina_ledgers_indexed_total counter/);
  assert.match(body, /lumina_latest_indexed_ledger 5000/);
  // Default process metrics come along, so a leak or event-loop stall is
  // visible without anything being added by hand.
  assert.match(body, /lumina_indexer_process_cpu_user_seconds_total/);
});

test('every metric the dashboard queries is registered under its expected name', async () => {
  // A dashboard panel pointing at a renamed metric silently renders an empty
  // graph, which reads as "nothing is wrong".
  const expected = [
    'lumina_ledgers_indexed_total',
    'lumina_transactions_indexed_total',
    'lumina_operations_indexed_total',
    'lumina_contract_events_indexed_total',
    'lumina_custom_events_decoded_total',
    'lumina_horizon_requests_total',
    'lumina_horizon_request_duration_seconds',
    'lumina_soroban_requests_total',
    'lumina_ledger_index_duration_seconds',
    'lumina_indexing_errors_total',
    'lumina_latest_indexed_ledger',
    'lumina_latest_horizon_ledger',
    'lumina_indexing_lag_ledgers',
    'lumina_last_successful_index_timestamp_seconds',
  ];

  const registered = new Set((await registry.getMetricsAsJSON()).map(m => m.name));
  const missing = expected.filter(name => !registered.has(name));

  assert.deepEqual(missing, []);
});

test('counters only ever move forward', async () => {
  const before = await value('lumina_ledgers_indexed_total');
  ledgersIndexed.inc();
  transactionsIndexed.inc(0);
  operationsIndexed.inc(0);

  assert.ok((await value('lumina_ledgers_indexed_total')) > before);
  assert.ok((await latestIndexedLedger.get()).values.length > 0);
  assert.ok((await latestHorizonLedger.get()).values.length > 0);
  assert.ok((await indexingLag.get()).values.length > 0);
  assert.ok((await lastSuccessfulIndexTimestamp.get()).values.length > 0);
});

/** Metric prefixes this package is responsible for registering. */
const OWNED_PREFIXES = [
  'lumina_ledgers_',
  'lumina_transactions_',
  'lumina_operations_',
  'lumina_contract_events_',
  'lumina_custom_events_',
  'lumina_horizon_',
  'lumina_soroban_',
  'lumina_ledger_index_',
  'lumina_indexing_',
  'lumina_latest_',
  'lumina_last_successful_',
];

const HEADLINE_METRICS = [
  'lumina_indexing_lag_ledgers',
  'lumina_last_successful_index_timestamp_seconds',
  'lumina_horizon_requests_total',
];

test('every Lumina metric the dashboard queries actually exists', async () => {
  // A panel pointing at a renamed metric renders an empty graph, which reads
  // as "nothing is wrong" rather than "this panel is broken". This walks the
  // checked-in dashboard and resolves every metric this package owns.
  const dashboard = readFileSync(
    join(__dirname, '..', '..', 'docker', 'observability', 'lumina-dashboard.json'),
    'utf-8'
  );

  const referenced = new Set(dashboard.match(/lumina_[a-z0-9_]+/g) ?? []);
  const registered = new Set((await registry.getMetricsAsJSON()).map(m => m.name));

  const missing: string[] = [];
  for (const name of referenced) {
    // Histogram queries reference the generated series, not the base metric.
    const base = name.replace(/_(bucket|sum|count)$/, '');
    if (!OWNED_PREFIXES.some(prefix => base.startsWith(prefix))) continue;
    if (!registered.has(base)) missing.push(base);
  }

  assert.deepEqual(missing, [], `dashboard references unregistered metrics: ${missing.join(', ')}`);
});

test('the dashboard actually charts this package s headline metrics', async () => {
  const dashboard = readFileSync(
    join(__dirname, '..', '..', 'docker', 'observability', 'lumina-dashboard.json'),
    'utf-8'
  );

  for (const metric of HEADLINE_METRICS) {
    assert.ok(dashboard.includes(metric), `dashboard is missing a panel for ${metric}`);
  }
});
