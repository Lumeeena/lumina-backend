/**
 * Circuit breaker for contract IDs that fail repeatedly during event indexing.
 *
 * Prevents a single bad contract ID from breaking event indexing for all other
 * contracts by tracking consecutive failures and temporarily dropping problematic
 * IDs after a threshold, with periodic retries to handle transient issues.
 */

import { subsystem } from './logger';

const log = subsystem('circuit-breaker');

interface CircuitBreakerState {
  consecutiveFailures: number;
  dropped: boolean;
  droppedAt?: number;
  lastFailureAt?: number;
}

const FAILURE_THRESHOLD = 5;
const RETRY_INTERVAL_CYCLES = 60; // ~5 minutes at default 5s poll interval
const BATCH_SIZE = 10; // Chunk contract IDs to limit blast radius

const state = new Map<string, CircuitBreakerState>();
let cycleCount = 0;

/**
 * Records a failure for the given contract IDs (typically a batch that failed together).
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
 */
export function getCircuitBreakerState(): Map<string, CircuitBreakerState> {
  return new Map(state);
}

/**
 * Resets the circuit breaker state (useful for testing).
 */
export function resetCircuitBreaker(): void {
  state.clear();
  cycleCount = 0;
}

// Metrics
import { Counter } from 'prom-client';
import { registry as metricsRegistry } from './metrics';

export const droppedContractIds = new Counter({
  name: 'lumina_circuit_breaker_dropped_contract_ids_total',
  help: 'Contract IDs dropped by the circuit breaker due to repeated failures.',
  registers: [metricsRegistry],
});

export const recoveredContractIds = new Counter({
  name: 'lumina_circuit_breaker_recovered_contract_ids_total',
  help: 'Previously dropped contract IDs that recovered on retry.',
  registers: [metricsRegistry],
});

export const retryAttempts = new Counter({
  name: 'lumina_circuit_breaker_retry_attempts_total',
  help: 'Retry attempts for dropped contract IDs.',
  registers: [metricsRegistry],
});
