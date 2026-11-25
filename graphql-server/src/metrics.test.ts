/**
 * The metrics live on one process-wide registry, so these tests read values back
 * out of it rather than inspecting the module-level objects. Each test uses its
 * own label values so it is not affected by the others.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  graphqlOperationDuration,
  graphqlOperations,
  metricsContentType,
  registry,
  renderMetrics,
  subscriptionsActive,
} from './metrics';

const PUBLISHED_NAMES = [
  'lumina_graphql_operations_total',
  'lumina_graphql_operation_duration_seconds',
  'lumina_graphql_subscriptions_active',
  'lumina_graphql_subscriptions_rejected_total',
  'lumina_graphql_listener_connected',
  'lumina_graphql_auth_total',
  'lumina_graphql_horizon_account_fallbacks_total',
  'lumina_graphql_latest_ledger_cache_requests_total',
  'lumina_graphql_latest_ledger_cache_invalidations_total',
  'lumina_graphql_horizon_requests_total',
  'lumina_graphql_horizon_request_duration_seconds',
  'lumina_db_pool_connections_total',
  'lumina_db_pool_connections_idle',
  'lumina_db_pool_waiting',
  'lumina_graphql_db_pool_errors_total',
  'lumina_scheduled_exports_total',
  'lumina_scheduled_export_duration_seconds',
  'lumina_deprecated_field_usage_total',
];

test('every metric is registered under the name dashboards and alerts depend on', () => {
  for (const name of PUBLISHED_NAMES) {
    assert.ok(registry.getSingleMetric(name), `${name} is not registered`);
  }
});

test('default process metrics are namespaced under lumina_graphql_', async () => {
  const output = await renderMetrics();

  assert.match(output, /^# HELP lumina_graphql_process_cpu_user_seconds_total /m);
});

test('operation counts are labelled by name, type and outcome', async () => {
  graphqlOperations.inc({ operation: 'metricsTestAccount', type: 'query', outcome: 'ok' }, 2);

  const metric = await registry.getSingleMetric('lumina_graphql_operations_total')?.get();
  const value = metric?.values.find(
    entry => entry.labels.operation === 'metricsTestAccount' && entry.labels.outcome === 'ok'
  );

  assert.equal(value?.value, 2);
});

test('operation latency is recorded under the same name and type labels', async () => {
  graphqlOperationDuration.observe({ operation: 'metricsTestLatest', type: 'query' }, 0.03);

  const output = await renderMetrics();

  assert.match(
    output,
    /lumina_graphql_operation_duration_seconds_count\{operation="metricsTestLatest",type="query"\} 1/
  );
});

test('a gauge reports its most recent value', async () => {
  subscriptionsActive.set(3);
  subscriptionsActive.set(1);

  const metric = await registry.getSingleMetric('lumina_graphql_subscriptions_active')?.get();

  assert.equal(metric?.values[0]?.value, 1);
});

test('the content type is the Prometheus text format', () => {
  assert.equal(metricsContentType(), registry.contentType);
  assert.match(metricsContentType(), /^text\/plain/);
});
