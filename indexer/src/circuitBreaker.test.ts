import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  recordFailure,
  recordSuccess,
  filterContractIds,
  chunkContractIds,
  resetCircuitBreaker,
  getCircuitBreakerState,
  droppedContractIds,
  recoveredContractIds,
  retryAttempts,
} from './circuitBreaker';

const ID = 'C' + '0'.repeat(55);

/** Current value of an unlabelled prom-client counter. */
async function counterValue(counter: {
  get(): Promise<{ values: Array<{ value: number }> }> | { values: Array<{ value: number }> };
}): Promise<number> {
  const data = await counter.get();
  return data.values[0]?.value ?? 0;
}

/** Drives an ID to the dropped state (FAILURE_THRESHOLD = 5 consecutive failures). */
function dropId(id: string): void {
  for (let i = 0; i < 5; i++) {
    recordFailure([id]);
  }
}

/** Calls filterContractIds `n` times with the given IDs and returns the last result. */
function advanceCycles(n: number, ids: string[]): string[] {
  let last: string[] = [];
  for (let i = 0; i < n; i++) {
    last = filterContractIds(ids);
  }
  return last;
}

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
  const ids = [ID];
  
  recordFailure(ids);
  assert.equal(getCircuitBreakerState().get(ID)?.consecutiveFailures, 1);
  
  recordFailure(ids);
  assert.equal(getCircuitBreakerState().get(ID)?.consecutiveFailures, 2);
});

test('recordFailure drops contract ID after threshold (5 failures)', async () => {
  resetCircuitBreaker();
  const before = await counterValue(droppedContractIds);
  
  // Record 5 failures to trigger drop
  dropId(ID);
  
  const state = getCircuitBreakerState();
  assert.equal(state.get(ID)?.consecutiveFailures, 5);
  assert.equal(state.get(ID)?.dropped, true);
  assert.ok(state.get(ID)?.droppedAt);
  
  assert.equal(await counterValue(droppedContractIds), before + 1);
});

test('an ID one failure short of the threshold is not dropped', () => {
  resetCircuitBreaker();
  for (let i = 0; i < 4; i++) {
    recordFailure([ID]);
  }
  assert.equal(getCircuitBreakerState().get(ID)?.dropped, false);
  assert.deepEqual(filterContractIds([ID]), [ID]);
});

test('failures after the drop keep counting but do not re-log or re-count the drop', async () => {
  resetCircuitBreaker();
  const before = await counterValue(droppedContractIds);

  dropId(ID);
  recordFailure([ID]);
  recordFailure([ID]);

  const entry = getCircuitBreakerState().get(ID);
  assert.equal(entry?.consecutiveFailures, 7);
  assert.equal(entry?.dropped, true);
  assert.equal(await counterValue(droppedContractIds), before + 1);
});

test('recordSuccess resets failure counter', () => {
  resetCircuitBreaker();
  const ids = [ID];
  
  recordFailure(ids);
  recordFailure(ids);
  assert.equal(getCircuitBreakerState().get(ID)?.consecutiveFailures, 2);
  
  recordSuccess(ids);
  assert.equal(getCircuitBreakerState().get(ID)?.consecutiveFailures, 0);
  assert.equal(getCircuitBreakerState().get(ID)?.dropped, false);
});

test('recordSuccess creates a clean entry for an ID that was never tracked', () => {
  resetCircuitBreaker();
  recordSuccess([ID]);
  assert.deepEqual(getCircuitBreakerState().get(ID), {
    consecutiveFailures: 0,
    dropped: false,
  });
});

test('filterContractIds removes dropped IDs from result', () => {
  resetCircuitBreaker();
  const id1 = 'C' + '1'.repeat(55);
  const id2 = 'C' + '2'.repeat(55);
  const ids = [id1, id2];
  
  // Drop id1
  dropId(id1);
  
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
  const ids = [ID];
  
  // Drop the ID
  dropId(ID);
  assert.equal(getCircuitBreakerState().get(ID)?.dropped, true);
  
  const before = await counterValue(retryAttempts);
  
  // Call filterContractIds 60 times to reach retry interval
  advanceCycles(60, ids);
  
  // After 60 cycles, the ID should be retried (included in result)
  const filtered = filterContractIds(ids);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0], ID);
  assert.equal(getCircuitBreakerState().get(ID)?.dropped, false);
  
  assert.equal(await counterValue(retryAttempts), before + 1);
});

test('dropped ID stays excluded on cycles 1-59 and is retried exactly on cycle 60', async () => {
  resetCircuitBreaker();
  dropId(ID);
  const before = await counterValue(retryAttempts);

  for (let cycle = 1; cycle <= 59; cycle++) {
    assert.deepEqual(filterContractIds([ID]), [], `cycle ${cycle} should exclude the dropped ID`);
  }
  assert.equal(await counterValue(retryAttempts), before);

  assert.deepEqual(filterContractIds([ID]), [ID]); // cycle 60
  assert.equal(await counterValue(retryAttempts), before + 1);
});

test('retry schedule follows the global cycle counter, not the time the ID was dropped', () => {
  resetCircuitBreaker();

  // Empty calls still advance the cycle counter.
  advanceCycles(59, []);

  // Dropped just before the boundary...
  dropId(ID);

  // ...so the very next cycle (60) already retries it.
  assert.deepEqual(filterContractIds([ID]), [ID]);
});

test('a retry fully resets the ID: a still-failing ID needs 5 new failures to be dropped again', async () => {
  resetCircuitBreaker();
  const before = await counterValue(droppedContractIds);

  dropId(ID);
  advanceCycles(60, [ID]); // cycle 60 grants the retry

  assert.deepEqual(getCircuitBreakerState().get(ID), {
    consecutiveFailures: 0,
    dropped: false,
  });

  for (let i = 0; i < 4; i++) {
    recordFailure([ID]);
  }
  assert.equal(getCircuitBreakerState().get(ID)?.dropped, false);
  assert.deepEqual(filterContractIds([ID]), [ID]); // still attempted

  recordFailure([ID]); // 5th failure after the retry
  assert.equal(getCircuitBreakerState().get(ID)?.dropped, true);
  assert.equal(await counterValue(droppedContractIds), before + 2);
});

test('retries repeat every 60 cycles while the ID keeps failing', () => {
  resetCircuitBreaker();
  dropId(ID);

  assert.deepEqual(advanceCycles(60, [ID]), [ID]); // cycle 60: retry
  dropId(ID); // fails again and is re-dropped

  for (let cycle = 61; cycle <= 119; cycle++) {
    assert.deepEqual(filterContractIds([ID]), [], `cycle ${cycle} should exclude the ID`);
  }
  assert.deepEqual(filterContractIds([ID]), [ID]); // cycle 120: next retry
});

test('all dropped IDs are retried together on the retry cycle', async () => {
  resetCircuitBreaker();
  const id1 = 'C' + '1'.repeat(55);
  const id2 = 'C' + '2'.repeat(55);
  dropId(id1);
  dropId(id2);
  const before = await counterValue(retryAttempts);

  const result = advanceCycles(60, [id1, id2]);

  assert.deepEqual(result, [id1, id2]);
  assert.equal(await counterValue(retryAttempts), before + 2);
});

test('recordSuccess on a still-dropped ID counts it as recovered and resets it', async () => {
  resetCircuitBreaker();
  dropId(ID);
  const before = await counterValue(recoveredContractIds);

  recordSuccess([ID]);

  assert.equal(await counterValue(recoveredContractIds), before + 1);
  assert.deepEqual(getCircuitBreakerState().get(ID), {
    consecutiveFailures: 0,
    dropped: false,
  });
});

// Pins CURRENT behaviour: filterContractIds clears `dropped` when it grants a
// retry, so recordSuccess no longer sees the ID as dropped and the "recovered"
// metric is not incremented. If the metric is later fixed to count recoveries
// after a retry, update this test to expect `before + 1`.
test('an ID that succeeds after a retry is not counted as recovered (current behaviour)', async () => {
  resetCircuitBreaker();
  dropId(ID);
  advanceCycles(60, [ID]); // retry granted, dropped flag cleared
  const before = await counterValue(recoveredContractIds);

  recordSuccess([ID]);

  assert.equal(await counterValue(recoveredContractIds), before);
  assert.equal(getCircuitBreakerState().get(ID)?.dropped, false);
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

test('getCircuitBreakerState returns a copy: deleting from it does not affect real state', () => {
  resetCircuitBreaker();
  recordFailure([ID]);

  const snapshot = getCircuitBreakerState();
  snapshot.delete(ID);

  assert.equal(snapshot.has(ID), false);
  assert.equal(getCircuitBreakerState().has(ID), true);
});

test('resetCircuitBreaker clears all state', () => {
  resetCircuitBreaker();
  
  recordFailure([ID]);
  recordFailure([ID]);
  assert.ok(getCircuitBreakerState().size > 0);
  
  resetCircuitBreaker();
  assert.equal(getCircuitBreakerState().size, 0);
});

test('resetCircuitBreaker also resets the cycle counter', () => {
  resetCircuitBreaker();
  advanceCycles(30, []);
  resetCircuitBreaker();

  dropId(ID);
  // Counter restarted at 0, so the retry is a full 60 cycles away again.
  for (let cycle = 1; cycle <= 59; cycle++) {
    assert.deepEqual(filterContractIds([ID]), []);
  }
  assert.deepEqual(filterContractIds([ID]), [ID]);
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
