/**
 * Indexer metrics, in Prometheus format.
 *
 * The metric that justifies this module is `lumina_horizon_requests_total`
 * labelled by status. A Horizon 429 spike previously showed up only as an
 * exception message in a log line nobody was tailing; as a counter it is a
 * graph line and an alert rule.
 *
 * The other one worth naming is `lumina_indexing_lag_ledgers`. "Is the indexer
 * up?" is the wrong question — a process that is running happily while falling
 * further behind the chain is the actual failure mode, and only a lag metric
 * distinguishes it from a healthy one.
 */
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export const registry = new Registry();

// Process/heap/GC metrics, so a leak or event-loop stall is visible without
// adding anything by hand.
collectDefaultMetrics({ register: registry, prefix: 'lumina_indexer_' });

export const ledgersIndexed = new Counter({
  name: 'lumina_ledgers_indexed_total',
  help: 'Ledgers successfully written to Postgres.',
  registers: [registry],
});

export const transactionsIndexed = new Counter({
  name: 'lumina_transactions_indexed_total',
  help: 'Transactions written as part of an indexed ledger.',
  registers: [registry],
});

export const operationsIndexed = new Counter({
  name: 'lumina_operations_indexed_total',
  help: 'Operations written as part of an indexed ledger.',
  registers: [registry],
});

export const contractEventsIndexed = new Counter({
  name: 'lumina_contract_events_indexed_total',
  help: 'Soroban contract events written to Postgres.',
  registers: [registry],
});

export const customEventsDecoded = new Counter({
  name: 'lumina_custom_events_decoded_total',
  help: 'Events decoded against a registered custom schema, by outcome.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * Labelled by status so a 429 spike is a number rather than a log line.
 * `error` covers a request that never got a response at all.
 */
export const horizonRequests = new Counter({
  name: 'lumina_horizon_requests_total',
  help: 'Outbound Horizon requests by HTTP status.',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const horizonRequestDuration = new Histogram({
  name: 'lumina_horizon_request_duration_seconds',
  help: 'Outbound Horizon request latency.',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const sorobanRequests = new Counter({
  name: 'lumina_soroban_requests_total',
  help: 'Outbound Soroban RPC requests by outcome.',
  labelNames: ['method', 'outcome'] as const,
  registers: [registry],
});

export const sorobanRequestDuration = new Histogram({
  name: 'lumina_soroban_request_duration_seconds',
  help: 'Outbound Soroban RPC request latency.',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const indexerPoolErrors = new Counter({
  name: 'lumina_indexer_db_pool_errors_total',
  help: 'Unexpected idle PostgreSQL pool client errors.',
  registers: [registry],
});

export const ledgerIndexDuration = new Histogram({
  name: 'lumina_ledger_index_duration_seconds',
  help: 'Time to fetch and write one ledger.',
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const indexingErrors = new Counter({
  name: 'lumina_indexing_errors_total',
  help: 'Errors raised in the polling loops, by loop.',
  labelNames: ['loop'] as const,
  registers: [registry],
});

/**
 * The three gauges below are labelled `network`.
 *
 * Two chains do not share a tip, a cursor or a lag: mainnet at 5,000 and
 * testnet at 100 are not the same number in different places, they are two
 * unrelated facts that happen to share a metric name. Aggregating them into a
 * single unlabeled series (a max, an average, whichever the scrape picks)
 * would report a healthy-looking value while one network sits stuck.
 *
 * Counters stay unlabeled — a rate summed across networks is still a rate.
 */
export const latestIndexedLedger = new Gauge({
  name: 'lumina_latest_indexed_ledger',
  help: 'Highest ledger sequence written to Postgres, by network.',
  labelNames: ['network'] as const,
  registers: [registry],
});

export const latestHorizonLedger = new Gauge({
  name: 'lumina_latest_horizon_ledger',
  help: 'Highest ledger sequence Horizon reports, by network.',
  labelNames: ['network'] as const,
  registers: [registry],
});

/**
 * Horizon's tip minus ours. The single number to alert on: a stuck indexer and
 * a busy one look identical on every other metric.
 */
export const indexingLag = new Gauge({
  name: 'lumina_indexing_lag_ledgers',
  help: 'Ledgers behind Horizon (latest Horizon ledger minus latest indexed), by network.',
  labelNames: ['network'] as const,
  registers: [registry],
});

export const lastSuccessfulIndexTimestamp = new Gauge({
  name: 'lumina_last_successful_index_timestamp_seconds',
  help: 'Unix time of the last successfully indexed ledger, by network.',
  labelNames: ['network'] as const,
  registers: [registry],
});

export const lastSuccessfulRegistryDiscoveryTimestamp = new Gauge({
  name: 'lumina_last_successful_registry_discovery_timestamp_seconds',
  help: 'Unix time of the last successful registry contract discovery.',
  registers: [registry],
});

export const accountCacheSize = new Gauge({
  name: 'lumina_account_cache_size',
  help: 'Current size of the account cache, by network.',
  labelNames: ['network'] as const,
  registers: [registry],
});

export const contractsWatched = new Gauge({
  name: 'lumina_contracts_watched',
  help: 'Distinct contract ids whose events are being indexed.',
  labelNames: ['network'] as const,
  registers: [registry],
});

export const sorobanEventsTruncated = new Counter({
  name: 'lumina_soroban_events_truncated_total',
  help: 'Soroban event polling cycles that hit the per-cycle event limit.',
  labelNames: ['network'] as const,
  registers: [registry],
});

export const sorobanRetentionWindowExceeded = new Counter({
  name: 'lumina_soroban_retention_window_exceeded_total',
  help: 'Times the Soroban event cursor fell behind the RPC retention window.',
  labelNames: ['network'] as const,
  registers: [registry],
});

/** Record a completed ledger and move the freshness gauges with it. */
export function recordIndexedLedger(
  network: string,
  sequence: number,
  transactions: number,
  operations: number
): void {
  ledgersIndexed.inc();
  transactionsIndexed.inc(transactions);
  operationsIndexed.inc(operations);
  latestIndexedLedger.set({ network }, sequence);
  lastSuccessfulIndexTimestamp.set({ network }, Date.now() / 1000);
}

/** Update the lag gauges from Horizon's reported tip. */
export function recordHorizonTip(network: string, sequence: number, latestIndexed: number): void {
  latestHorizonLedger.set({ network }, sequence);
  indexingLag.set({ network }, Math.max(0, sequence - latestIndexed));
}

export function metricsContentType(): string {
  return registry.contentType;
}

export function renderMetrics(): Promise<string> {
  return registry.metrics();
}
