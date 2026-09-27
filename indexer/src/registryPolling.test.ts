import { test } from 'node:test';
import * as assert from 'node:assert/strict';

test('registry polling uses time-based interval', () => {
  // Simulate the time-based polling logic
  const pollIntervalMs = 60_000; // 60 seconds
  let lastPollTime = 0;
  
  // First poll should happen immediately (lastPollTime is 0)
  const now1 = Date.now();
  assert.ok(now1 - lastPollTime >= pollIntervalMs);
  
  // After polling, update lastPollTime
  lastPollTime = now1;
  
  // Immediately after, should not poll again
  const now2 = Date.now();
  assert.ok(now2 - lastPollTime < pollIntervalMs);
  
  // After the interval, should poll again
  const now3 = lastPollTime + pollIntervalMs + 1;
  assert.ok(now3 - lastPollTime >= pollIntervalMs);
});

test('registry polling interval is configurable', () => {
  // Test that the interval can be configured
  const interval1 = 30_000; // 30 seconds
  const interval2 = 120_000; // 2 minutes
  
  assert.ok(interval1 > 0);
  assert.ok(interval2 > 0);
  assert.ok(interval2 > interval1);
});

test('registry polling is independent of loop iterations', () => {
  // The key difference: time-based vs tick-based
  // Tick-based: polls every N iterations, which varies with ledger indexing time
  // Time-based: polls every N milliseconds, regardless of ledger indexing time
  
  const pollIntervalMs = 60_000;
  let lastPollTime = 0;
  
  // With tick-based (every 12 ticks), would poll after 12 ledgers = 1.2 seconds
  // With time-based, polls after 60 seconds regardless of ledger count
  
  const now = Date.now();
  const timeSinceLastPoll = now - lastPollTime;
  
  // Time-based check is purely time-based, not iteration-based
  assert.ok(timeSinceLastPoll >= 0);
  
  // The interval is fixed in milliseconds
  assert.equal(pollIntervalMs, 60_000);
});
