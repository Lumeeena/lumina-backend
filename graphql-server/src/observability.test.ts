import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { buildServerHealth, samplePool, serverHealthStatusCode } from './observability';
import { dbPoolErrors, dbPoolIdle, dbPoolTotal, dbPoolWaiting, exportRuns, registry } from './metrics';

const NOW = 1_700_000_000_000;

const okPool = { query: async () => ({ rows: [{ '?column?': 1 }] }) } as unknown as Pool;
const deadPool = {
  query: async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:5432');
  },
} as unknown as Pool;

async function gauge(name: string): Promise<number> {
  const metric = await registry.getSingleMetric(name)?.get();
  return metric?.values[0]?.value ?? 0;
}

test('a server that can reach its database is healthy', async () => {
  const report = await buildServerHealth({ pool: okPool, startedAt: NOW - 30_000 }, NOW);

  assert.equal(report.status, 'ok');
  assert.equal(report.database, 'ok');
  assert.equal(report.uptimeSeconds, 30);
  assert.equal(serverHealthStatusCode(report), 200);
});

test('health issues a real query rather than reporting on process liveness', async () => {
  let queried = false;
  const pool = {
    query: async () => {
      queried = true;
      return { rows: [] };
    },
  } as unknown as Pool;

  await buildServerHealth({ pool, startedAt: NOW }, NOW);

  assert.equal(queried, true);
});

test('an unreachable database fails the check with the reason attached', async () => {
  const report = await buildServerHealth({ pool: deadPool, startedAt: NOW }, NOW);

  assert.equal(report.status, 'degraded');
  assert.equal(report.database, 'unreachable');
  assert.equal(serverHealthStatusCode(report), 503);
  assert.match(report.checks.find(c => c.name === 'database')?.detail ?? '', /ECONNREFUSED/);
});

test('a disconnected listener is reported but does not fail the server', async () => {
  // Queries still work without the LISTEN connection, and it reconnects on its
  // own — failing health here would pull a serving process out of rotation
  // over a degraded extra.
  const report = await buildServerHealth(
    { pool: okPool, startedAt: NOW, listenerConnected: false, subscriptionCount: 3 },
    NOW
  );

  assert.equal(report.status, 'ok');
  assert.equal(report.listener, 'disconnected');
  assert.equal(report.subscriptions, 3);
  assert.match(report.checks.find(c => c.name === 'listener')?.detail ?? '', /subscriptions are paused/);
});

test('a connected listener reports connected', async () => {
  const report = await buildServerHealth(
    { pool: okPool, startedAt: NOW, listenerConnected: true },
    NOW
  );

  assert.equal(report.listener, 'connected');
});

test('a server with no notifier reports the listener as not configured', async () => {
  const report = await buildServerHealth({ pool: okPool, startedAt: NOW }, NOW);

  assert.equal(report.listener, 'not-configured');
  assert.equal(report.checks.find(c => c.name === 'listener'), undefined);
});

test('samplePool publishes the pool counters', async () => {
  // Pool saturation is what explains a latency cliff nothing else accounts
  // for: queries queue invisibly once every connection is checked out.
  const pool = { totalCount: 10, idleCount: 2, waitingCount: 5 } as unknown as Pool;

  samplePool(pool);

  assert.equal(await gauge('lumina_db_pool_connections_total'), 10);
  assert.equal(await gauge('lumina_db_pool_connections_idle'), 2);
  assert.equal(await gauge('lumina_db_pool_waiting'), 5);
});

test('samplePool tolerates a pool that does not expose counts', async () => {
  // The properties are documented on pg.Pool but absent from some @types/pg
  // versions; reading them must not throw at scrape time.
  samplePool({} as unknown as Pool);

  assert.equal(await gauge('lumina_db_pool_connections_total'), 0);
  assert.equal(await gauge('lumina_db_pool_waiting'), 0);
});

test('PostgreSQL pool errors and scheduled export outcomes are exposed as metrics', async () => {
  dbPoolErrors.inc();
  exportRuns.inc({ outcome: 'success' });
  assert.equal((await gauge('lumina_graphql_db_pool_errors_total')), 1);
  assert.equal((await registry.getSingleMetric('lumina_scheduled_exports_total')?.get())?.values
    .find(value => value.labels.outcome === 'success')?.value, 1);
});

test('every metric the dashboard queries is registered under its expected name', async () => {
  const expected = [
    'lumina_graphql_operations_total',
    'lumina_graphql_operation_duration_seconds',
    'lumina_graphql_subscriptions_active',
    'lumina_graphql_subscriptions_rejected_total',
    'lumina_graphql_listener_connected',
    'lumina_db_pool_connections_total',
    'lumina_db_pool_connections_idle',
    'lumina_db_pool_waiting',
  ];

  const registered = new Set((await registry.getMetricsAsJSON()).map(m => m.name));
  assert.deepEqual(
    expected.filter(name => !registered.has(name)),
    []
  );
});

test('the registry renders Prometheus text exposition', async () => {
  dbPoolTotal.set(4);
  dbPoolIdle.set(1);
  dbPoolWaiting.set(0);

  const body = await registry.metrics();

  assert.match(body, /# TYPE lumina_db_pool_connections_total gauge/);
  assert.match(body, /lumina_db_pool_connections_total 4/);
  assert.match(body, /lumina_graphql_process_cpu_user_seconds_total/);
});

/** Metric prefixes this package is responsible for registering. */
const OWNED_PREFIXES = ['lumina_graphql_', 'lumina_db_pool_'];

const HEADLINE_METRICS = [
  'lumina_graphql_operation_duration_seconds',
  'lumina_db_pool_waiting',
  'lumina_graphql_listener_connected',
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
