/**
 * Circuit breaker for contract IDs that fail repeatedly during event indexing.
 *
 * Prevents a single bad contract ID from breaking event indexing for all other
 * contracts by tracking consecutive failures and temporarily dropping problematic
 * IDs after a threshold, with periodic retries to handle transient issues.
 *
 * ## Why this exists
 * Contract IDs are queried for events in batches. When a batch request fails,
 * every ID in it is charged a failure (see `recordFailure`). One permanently
 * bad ID (unknown, malformed, or one the RPC rejects) would therefore fail its
 * batch on every poll and starve the healthy IDs that share it. Dropping the
 * offender after a few failures lets the rest keep indexing.
 *
 * ## How it works
 * Each contract ID is tracked independently:
 *
 *   healthy --(FAILURE_THRESHOLD consecutive failures)--> dropped
 *   dropped --(retry cycle reached in filterContractIds)--> healthy, counters reset
 *   any state --(recordSuccess)--> healthy, counters reset
 *
 * Unlike a classic breaker there is no separate half-open state: a retry fully
 * resets the ID's counters and lets it back in, so a still-broken ID needs
 * another FAILURE_THRESHOLD failures before it is dropped again.
 *
 * ## Things to know
 * - State is in-memory and per-process: it is lost on restart and not shared
 *   between instances.
 * - "Time" is counted in calls to `filterContractIds`, not wall-clock time.
 *   Call it exactly once per poll cycle, or the retry interval changes.
 * - Metrics are exported at the bottom of the file and registered on the
 *   shared indexer registry.
 */ 

import { subsystem } from './logger';

const log = subsystem('circuit-breaker');

/**
 * Per-contract-ID tracking record.
 * - `consecutiveFailures`: failures since the last success or retry reset.
 * - `dropped`: true while the ID is excluded from indexing.
 * - `droppedAt` / `lastFailureAt`: epoch ms timestamps, informational only
 *   (nothing in this module reads them for decisions).
 */
interface CircuitBreakerState {
  consecutiveFailures: number;
  dropped: boolean;
  droppedAt?: number;
  lastFailureAt?: number;
}

/**
 * Consecutive failures before an ID is dropped. Assuming at most one failure
 * is recorded per ID per poll cycle (5s by default), 5 failures is roughly
 * 25s of continuous failure: long enough to ride out a brief RPC hiccup,
 * short enough that a genuinely bad ID stops hurting its batch quickly.
 */
const FAILURE_THRESHOLD = 5;

/**
 * Number of `filterContractIds` calls between retries of dropped IDs.
 * 60 cycles is ~5 minutes at the default 5s poll interval, so a transient
 * outage heals within minutes while a permanently bad ID costs only one
 * failing attempt every 5 minutes. If the poll interval changes, the wall-clock
 * retry delay changes with it.
 */
const RETRY_INTERVAL_CYCLES = 60; // ~5 minutes at default 5s poll interval

/**
 * Maximum contract IDs per request batch. A failing batch charges a failure to
 * every ID in it, so a smaller batch means fewer healthy IDs are blamed (and
 * temporarily dropped) because of one bad neighbour. See `chunkContractIds`.
 */
const BATCH_SIZE = 10; // Chunk contract IDs to limit blast radius

const state = new Map<string, CircuitBreakerState>();
let cycleCount = 0;

/**
 * Records a failure for the given contract IDs (typically a batch that failed together).
 *
 * Every ID in the list gets its consecutive-failure counter incremented. When an
 * ID reaches FAILURE_THRESHOLD it is marked dropped, an error is logged and the
 * dropped-IDs metric is incremented (once per drop, not once per later failure).
 * Failures recorded for an already-dropped ID keep increasing the counter but
 * do not log or count again.
 */
export function recordFailure(contractIds: string[]): void {
  const now = Date.now();
  for (const id of contractIds) {
    const current = state.get(id) || { consecutiveFailures: 0, dropped: false };
    current.consecutiveFailures++;
    current.lastFailureAt = now;
    
    if (current.consecutiveFailures >= FAILURE_THRESHOLD && !current.dropped) {
      current.dropped = true;
      current.droppedAt = now;
      log.error(
        { contractId: id, failures: current.consecutiveFailures },
        'CIRCUIT BREAKER: Contract ID dropped after repeated failures - will retry periodically'
      );
      droppedContractIds.inc();
    }
    
    state.set(id, current);
  }
}

/**
 * Records success for the given contract IDs, resetting their failure counters.
 *
 * Side effects to be aware of:
 * - An entry is created for every ID passed in, even IDs that never failed, so
 *   the tracking map grows with the number of distinct IDs seen.
 * - The recovery log and `recoveredContractIds` metric fire only if the ID is
 *   still marked dropped at this point. `filterContractIds` clears the dropped
 *   flag when it grants a retry, so an ID that is retried and then succeeds is
 *   normally NOT counted as recovered.
 */
export function recordSuccess(contractIds: string[]): void {
  for (const id of contractIds) {
    const current = state.get(id);
    if (current && current.dropped) {
      log.info({ contractId: id }, 'CIRCUIT BREAKER: Previously dropped contract ID recovered');
      recoveredContractIds.inc();
    }
    state.set(id, { consecutiveFailures: 0, dropped: false });
  }
}

/**
 * Filters out dropped contract IDs, unless it's time to retry them.
 * Returns the list of IDs that should be attempted in this cycle.
 *
 * Call once per poll cycle. Every call advances the internal cycle counter,
 * including calls with an empty list. Behaviour:
 * - Healthy and unknown IDs always pass through, in their original order.
 * - Dropped IDs are excluded, except when the cycle counter is a multiple of
 *   RETRY_INTERVAL_CYCLES. On that cycle ALL dropped IDs are retried together:
 *   their state is fully reset (counter back to 0, no longer dropped) and the
 *   retry metric is incremented for each.
 * - The retry schedule follows the global counter, not each ID's `droppedAt`,
 *   so an ID dropped just before a multiple of the interval is retried
 *   almost immediately rather than after a full interval.
 */
export function filterContractIds(contractIds: string[]): string[] {
  cycleCount++;
  const result: string[] = [];
  
  for (const id of contractIds) {
    const current = state.get(id);
    if (!current || !current.dropped) {
      result.push(id);
      continue;
    }
    
    // Check if it's time to retry
    if (cycleCount % RETRY_INTERVAL_CYCLES === 0) {
      log.info({ contractId: id }, 'CIRCUIT BREAKER: Retrying previously dropped contract ID');
      retryAttempts.inc();
      // Reset state to allow retry
      state.set(id, { consecutiveFailures: 0, dropped: false });
      result.push(id);
    }
  }
  
  return result;
}

/**
 * Splits contract IDs into batches of size BATCH_SIZE to limit blast radius.
 *
 * Order is preserved and the last batch may be smaller. An empty input returns
 * an empty array (no empty batch).
 */
export function chunkContractIds(contractIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < contractIds.length; i += BATCH_SIZE) {
    chunks.push(contractIds.slice(i, i + BATCH_SIZE));
  }
  return chunks;
}

/**
 * Gets the current circuit breaker state for all tracked contract IDs.
 *
 * Returns a shallow copy: adding or deleting keys on the returned Map does not
 * affect the real state, but the entry objects are shared. Entries mutated in
 * place by `recordFailure` show up in an earlier snapshot, while entries
 * replaced by `recordSuccess` or a retry do not. Treat the result as read-only
 * and take a fresh snapshot when you need current values.
 */
export function getCircuitBreakerState(): Map<string, CircuitBreakerState> {
  return new Map(state);
}

/**
 * Resets the circuit breaker state (useful for testing).
 *
 * Clears all tracked IDs and the cycle counter. Metric counters are not reset.
 */
export function resetCircuitBreaker(): void {
  state.clear();
  cycleCount = 0;
}

// Metrics
import { Counter } from 'prom-client';
import { registry as metricsRegistry } from './metrics';

/** Incremented once each time an ID is dropped after reaching FAILURE_THRESHOLD. */
export const droppedContractIds = new Counter({
  name: 'lumina_circuit_breaker_dropped_contract_ids_total',
  help: 'Contract IDs dropped by the circuit breaker due to repeated failures.',
  registers: [metricsRegistry],
});

/**
 * Incremented when `recordSuccess` sees an ID still marked dropped. See the
 * note on `recordSuccess`: IDs recovering after a retry are normally not counted.
 */
export const recoveredContractIds = new Counter({
  name: 'lumina_circuit_breaker_recovered_contract_ids_total',
  help: 'Previously dropped contract IDs that recovered on retry.',
  registers: [metricsRegistry],
});

/** Incremented once per dropped ID each time `filterContractIds` grants a retry. */
export const retryAttempts = new Counter({
  name: 'lumina_circuit_breaker_retry_attempts_total',
  help: 'Retry attempts for dropped contract IDs.',
  registers: [metricsRegistry],
});
