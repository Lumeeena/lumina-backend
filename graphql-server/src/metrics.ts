/**
 * GraphQL server metrics.
 *
 * Latency is recorded per *operation name* rather than per HTTP route, because
 * every GraphQL request is a POST to the same path — a route histogram would
 * average a cheap `latestLedger` together with a deep `account` traversal and
 * tell you nothing about either.
 */
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * The one registry every metric in this file is registered on. `renderMetrics`
 * serialises it for scraping, and tests read individual metrics back out of it.
 */
export const registry = new Registry();

/**
 * Process metrics (CPU, memory, event loop and so on). The `lumina_graphql_`
 * prefix puts them in the same namespace as the metrics below.
 */
collectDefaultMetrics({ register: registry, prefix: 'lumina_graphql_' });

/**
 * GraphQL operations completed, labelled by operation name, operation type and
 * `outcome`. `outcome` is `ok` or `error`, set from whether the operation
 * returned any error.
 */
export const graphqlOperations = new Counter({
  name: 'lumina_graphql_operations_total',
  help: 'GraphQL operations by name, type and outcome.',
  labelNames: ['operation', 'type', 'outcome'] as const,
  registers: [registry],
});

/**
 * Latency of each GraphQL operation, labelled by operation name and type. It
 * shares those labels with `graphqlOperations` but not `outcome`, so a slow
 * operation can be read next to its error count. The buckets run from 5 ms to
 * 5 s. The source does not record why these bounds were chosen.
 */
export const graphqlOperationDuration = new Histogram({
  name: 'lumina_graphql_operation_duration_seconds',
  help: 'GraphQL operation latency by name.',
  labelNames: ['operation', 'type'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

/**
 * Open GraphQL subscriptions right now. Set from the notifier's subscriber count
 * as subscriptions open and close.
 */
export const subscriptionsActive = new Gauge({
  name: 'lumina_graphql_subscriptions_active',
  help: 'Currently open GraphQL subscriptions.',
  registers: [registry],
});

/**
 * Subscriptions refused because the server was at its concurrency ceiling (see
 * `MAX_SUBSCRIPTIONS` in the README). A steady rise means the ceiling is the
 * thing turning clients away.
 */
export const subscriptionsRejected = new Counter({
  name: 'lumina_graphql_subscriptions_rejected_total',
  help: 'Subscriptions refused because the server was at its concurrency ceiling.',
  registers: [registry],
});

/**
 * Whether the Postgres `LISTEN` connection that feeds subscriptions is up: `1`
 * when connected, `0` when not. While it is `0`, subscriptions are paused.
 */
export const listenerConnected = new Gauge({
  name: 'lumina_graphql_listener_connected',
  help: 'Whether the Postgres LISTEN connection is currently established (1 or 0).',
  registers: [registry],
});

/**
 * GraphQL requests by `caller` and `outcome`. `caller` is `anonymous` or
 * `api-key`. `outcome` is `resolved`, `rejected` or `revoked`. The key itself is
 * never a label.
 */
export const authAttempts = new Counter({
  name: 'lumina_graphql_auth_total',
  help: 'GraphQL requests by presented credential and authentication outcome.',
  labelNames: ['caller', 'outcome'] as const,
  registers: [registry],
});

/**
 * Account lookups that went to Horizon because the indexer had no row, by
 * `result`: `hit` (Horizon had the account), `miss` (it did not), or
 * `negative_cache` (a recent miss, answered without calling Horizon). See
 * `loaders.ts`.
 */
export const horizonAccountFallbacks = new Counter({
  name: 'lumina_graphql_horizon_account_fallbacks_total',
  help: 'Account lookups that fell back to Horizon, by result.',
  labelNames: ['result'] as const,
  registers: [registry],
});

/**
 * Latest-ledger cache lookups, by `result`: `hit` or `miss`. The TTL is set by
 * `LATEST_LEDGER_CACHE_TTL_MS` (see the README), so a low hit rate suggests it is
 * shorter than the gap between repeated requests.
 */
export const latestLedgerCacheRequests = new Counter({
  name: 'lumina_graphql_latest_ledger_cache_requests_total',
  help: 'Latest-ledger cache lookups by hit or miss.',
  labelNames: ['result'] as const,
  registers: [registry],
});

/**
 * Latest-ledger cache entries removed, by `network` and `reason`.
 * `ledger_notification` means a new ledger arrived for that network. `ttl_expired`
 * means the entry aged out.
 */
export const latestLedgerCacheInvalidations = new Counter({
  name: 'lumina_graphql_latest_ledger_cache_invalidations_total',
  help: 'Latest-ledger cache entries invalidated by network and reason.',
  labelNames: ['network', 'reason'] as const,
  registers: [registry],
});

/**
 * Outbound Horizon traffic, by HTTP status. The fallback path is the only code
 * here that talks to a service this deployment does not control, and `error`
 * counts a request that never got a response at all: the shape a timeout that
 * is too eager, or a connection that was dropped, leaves behind.
 */
export const horizonRequests = new Counter({
  name: 'lumina_graphql_horizon_requests_total',
  help: 'Outbound Horizon requests by HTTP status.',
  labelNames: ['status'] as const,
  registers: [registry],
});

/**
 * Latency of outbound Horizon requests. The buckets run from 50 ms to 10 s, past
 * the default 2 s per-request timeout (`HORIZON_REQUEST_TIMEOUT_MS`). The source
 * does not record why these bounds were chosen.
 */
export const horizonRequestDuration = new Histogram({
  name: 'lumina_graphql_horizon_request_duration_seconds',
  help: 'Outbound Horizon request latency.',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

/**
 * Pool saturation is the metric that explains a latency cliff nothing else
 * accounts for: queries queue invisibly once every connection is checked out.
 *
 * Connections the pool holds right now, idle or checked out. Set from the pool's
 * counters (see `observability.ts`).
 */
export const dbPoolTotal = new Gauge({
  name: 'lumina_db_pool_connections_total',
  help: 'Connections currently held by the pool.',
  registers: [registry],
});

/**
 * Connections in the pool that are not checked out. Idle at zero while
 * `dbPoolWaiting` is above zero means every connection is busy and requests are
 * queueing for one.
 */
export const dbPoolIdle = new Gauge({
  name: 'lumina_db_pool_connections_idle',
  help: 'Idle connections in the pool.',
  registers: [registry],
});

/**
 * Queries queued for a connection. Above zero means requests are waiting on the
 * pool rather than on the database.
 */
export const dbPoolWaiting = new Gauge({
  name: 'lumina_db_pool_waiting',
  help: 'Requests queued waiting for a pool connection.',
  registers: [registry],
});

/**
 * Unexpected errors from idle PostgreSQL pool clients, meaning a connection that
 * was lost while not in use. Incremented by the error handler `index.ts` attaches
 * to each pool.
 */
export const dbPoolErrors = new Counter({
  name: 'lumina_graphql_db_pool_errors_total',
  help: 'Unexpected idle PostgreSQL pool client errors.',
  registers: [registry],
});

/**
 * Scheduled object-storage exports finished, by `outcome`: `success` or
 * `failure`. See `scheduledExport.ts`.
 */
export const exportRuns = new Counter({
  name: 'lumina_scheduled_exports_total',
  help: 'Scheduled object-storage exports by outcome.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * Wall-clock duration of a scheduled export run. The buckets run from 1 s to
 * 15 min. The source does not record why these bounds were chosen.
 */
export const exportRunDuration = new Histogram({
  name: 'lumina_scheduled_export_duration_seconds',
  help: 'Duration of scheduled object-storage exports.',
  buckets: [1, 5, 15, 30, 60, 120, 300, 900],
  registers: [registry],
});

/**
 * Requests that selected a deprecated GraphQL field, by `type` and `field`. Use
 * it to see whether anyone still depends on a field before removing it.
 */
export const deprecatedFieldUsage = new Counter({
  name: 'lumina_deprecated_field_usage_total',
  help: 'Usage of deprecated GraphQL fields, by type and field name.',
  labelNames: ['type', 'field'] as const,
  registers: [registry],
});

/**
 * The `Content-Type` to send with `renderMetrics` output: the Prometheus text
 * format.
 */
export function metricsContentType(): string {
  return registry.contentType;
}

/**
 * Serialises every metric in `registry` in the Prometheus text format. It
 * returns a promise because some collectors are asynchronous.
 */
export function renderMetrics(): Promise<string> {
  return registry.metrics();
}
