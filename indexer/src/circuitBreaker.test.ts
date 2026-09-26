import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  recordFailure,
  recordSuccess,
  filterContractIds,
  chunkContractIds,
  resetCircuitBreaker,
  getCircuitBreakerState,
} from './circuitBreaker';
import { registry } from './metrics';

test('contract IDs are chunked into batches of 10', () => {
  const ids = Array.from({ length: 25 }, (_, i) => `C${i.toString().padStart(55, '0')}`);
  const chunks = chunkContractIds(ids);
  
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.length, 10);
  assert.equal(chunks[1]?.length, 10);
  assert.equal(chunks[2]?.length, 5);
});

test('chunking handles empty array', () => {
  const chunks = chunkContractIds([]);
  assert.deepEqual(chunks, []);
});

test('chunking handles single ID', () => {
  const ids = ['C' + '0'.repeat(55)];
  const chunks = chunkContractIds(ids);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], ids);
});

test('recordFailure increments consecutive failure count', () => {
  resetCircuitBreaker();
  const id = 'C' + '0'.repeat(55);
  const ids = [id];
  
  recordFailure(ids);
  const state = getCircuitBreakerState();
  assert.equal(state.get(id)?.consecutiveFailures, 1);
  
  recordFailure(ids);
  assert.equal(state.get(id)?.consecutiveFailures, 2);
});

test('recordFailure drops contract ID after threshold (5 failures)', async () => {
  resetCircuitBreaker();
  const id = 'C' + '0'.repeat(55);
  const ids = [id];
  
  const beforeDropped = await registry.getSingleMetric('lumina_circuit_breaker_dropped_contract_ids_total')?.get();
  const beforeValue = beforeDropped?.values[0]?.value ?? 0;
  
  // Record 5 failures to trigger drop
  for (let i = 0; i < 5; i++) {
    recordFailure(ids);
  }
  
  const state = getCircuitBreakerState();
  assert.equal(state.get(id)?.consecutiveFailures, 5);
  assert.equal(state.get(id)?.dropped, true);
  assert.ok(state.get(id)?.droppedAt);
  
  const afterDropped = await registry.getSingleMetric('lumina_circuit_breaker_dropped_contract_ids_total')?.get();
  if (afterDropped && afterDropped.values[0]) {
    assert.equal(afterDropped.values[0].value, beforeValue + 1);
  }
});

test('recordSuccess resets failure counter', () => {
  resetCircuitBreaker();
  const id = 'C' + '0'.repeat(55);
  const ids = [id];
  
  recordFailure(ids);
  recordFailure(ids);
  assert.equal(getCircuitBreakerState().get(id)?.consecutiveFailures, 2);
  
  recordSuccess(ids);
  assert.equal(getCircuitBreakerState().get(id)?.consecutiveFailures, 0);
  assert.equal(getCircuitBreakerState().get(id)?.dropped, false);
});

test('filterContractIds removes dropped IDs from result', () => {
  resetCircuitBreaker();
  const id1 = 'C' + '1'.repeat(55);
  const id2 = 'C' + '2'.repeat(55);
  const ids = [id1, id2];
  
  // Drop id1
  for (let i = 0; i < 5; i++) {
    recordFailure([id1]);
  }
  
  const filtered = filterContractIds(ids);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0], id2);
});

test('filterContractIds returns all IDs when none are dropped', () => {
  resetCircuitBreaker();
  const ids = ['C' + '1'.repeat(55), 'C' + '2'.repeat(55)];
  
  const filtered = filterContractIds(ids);
  assert.deepEqual(filtered, ids);
});

test('filterContractIds retries dropped IDs after 60 cycles', async () => {
  resetCircuitBreaker();
  const id = 'C' + '0'.repeat(55);
  const ids = [id];
  
  // Drop the ID
  for (let i = 0; i < 5; i++) {
    recordFailure(ids);
  }
  assert.equal(getCircuitBreakerState().get(id)?.dropped, true);
  
  const beforeRetry = await registry.getSingleMetric('lumina_circuit_breaker_retry_attempts_total')?.get();
  const beforeValue = beforeRetry?.values[0]?.value ?? 0;
  
  // Call filterContractIds 60 times to reach retry interval
  for (let i = 0; i < 60; i++) {
    filterContractIds(ids);
  }
  
  // After 60 cycles, the ID should be retried (included in result)
  const filtered = filterContractIds(ids);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0], id);
  assert.equal(getCircuitBreakerState().get(id)?.dropped, false);
  
  const afterRetry = await registry.getSingleMetric('lumina_circuit_breaker_retry_attempts_total')?.get();
  if (afterRetry && afterRetry.values[0]) {
    assert.equal(afterRetry.values[0].value, beforeValue + 1);
  }
});

test('recordSuccess on previously dropped ID increments recovery metric', async () => {
  resetCircuitBreaker();
  const id = 'C' + '0'.repeat(55);
  const ids = [id];
  
  // Drop the ID
  for (let i = 0; i < 5; i++) {
    recordFailure(ids);
  }
  
  // Simulate retry by resetting dropped state
  getCircuitBreakerState().set(id, { consecutiveFailures: 0, dropped: true });
  
  const beforeRecovered = await registry.getSingleMetric('lumina_circuit_breaker_recovered_contract_ids_total')?.get();
  const beforeValue = beforeRecovered?.values[0]?.value ?? 0;
  
  recordSuccess(ids);
  
  const afterRecovered = await registry.getSingleMetric('lumina_circuit_breaker_recovered_contract_ids_total')?.get();
  if (afterRecovered && afterRecovered.values[0]) {
    assert.equal(afterRecovered.values[0].value, beforeValue + 1);
  }
});

test('multiple contract IDs are tracked independently', () => {
  resetCircuitBreaker();
  const id1 = 'C' + '1'.repeat(55);
  const id2 = 'C' + '2'.repeat(55);
  
  recordFailure([id1]);
  recordFailure([id1]);
  recordFailure([id2]);
  
  const state = getCircuitBreakerState();
  assert.equal(state.get(id1)?.consecutiveFailures, 2);
  assert.equal(state.get(id2)?.consecutiveFailures, 1);
});

test('resetCircuitBreaker clears all state', () => {
  resetCircuitBreaker();
  const id = 'C' + '0'.repeat(55);
  
  recordFailure([id]);
  recordFailure([id]);
  assert.ok(getCircuitBreakerState().size > 0);
  
  resetCircuitBreaker();
  assert.equal(getCircuitBreakerState().size, 0);
});

test('filterContractIds handles empty input', () => {
  resetCircuitBreaker();
  const filtered = filterContractIds([]);
  assert.deepEqual(filtered, []);
});

test('circuit breaker limits blast radius by chunking', () => {
  resetCircuitBreaker();
  // Create 15 contract IDs
  const ids = Array.from({ length: 15 }, (_, i) => `C${i.toString().padStart(55, '0')}`);
  const chunks = chunkContractIds(ids);
  
  // Should be 2 chunks: 10 and 5
  assert.equal(chunks.length, 2);
  
  if (chunks[0]) {
    // Simulate failure in first batch only
    recordFailure(chunks[0]);
    recordFailure(chunks[0]);
    recordFailure(chunks[0]);
    recordFailure(chunks[0]);
    recordFailure(chunks[0]);
  }
  
  // First batch should be dropped, second batch should not
  const filtered = filterContractIds(ids);
  assert.equal(filtered.length, 5); // Only second batch remains
  if (chunks[1]) {
    assert.deepEqual(filtered, chunks[1]);
  }
});
