import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBenchmarkArgs, runBenchmark } from './benchmark';

test('parseBenchmarkArgs accepts an inclusive range, including a single ledger', () => {
  assert.deepEqual(parseBenchmarkArgs(['10', '20']), { start: 10, end: 20 });
  assert.deepEqual(parseBenchmarkArgs(['5', '5']), { start: 5, end: 5 });
});

test('parseBenchmarkArgs rejects missing, non-numeric and reversed ranges', () => {
  assert.equal(parseBenchmarkArgs([]), null);
  assert.equal(parseBenchmarkArgs(['10']), null);
  assert.equal(parseBenchmarkArgs(['a', 'b']), null);
  assert.equal(parseBenchmarkArgs(['20', '10']), null);
});

test('runBenchmark indexes the whole inclusive range in order and computes throughput', async () => {
  const seen: number[] = [];
  const times = [1000, 3000];
  const result = await runBenchmark(100, 103, async seq => {
    seen.push(seq);
    return true;
  }, () => times.shift() as number);

  assert.deepEqual(seen, [100, 101, 102, 103]);
  assert.equal(result.indexedCount, 4);
  assert.equal(result.errorCount, 0);
  assert.equal(result.durationMs, 2000);
  assert.equal(result.ledgersPerSecond, 2);
});

test('runBenchmark counts false results and thrown errors as failures and keeps going', async () => {
  const seen: number[] = [];
  const result = await runBenchmark(1, 4, async seq => {
    seen.push(seq);
    if (seq === 2) return false;
    if (seq === 3) throw new Error('boom');
    return true;
  });

  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(result.indexedCount, 2);
  assert.equal(result.errorCount, 2);
});

test('runBenchmark reports zero throughput when no time elapses', async () => {
  const result = await runBenchmark(1, 1, async () => true, () => 5);
  assert.equal(result.ledgersPerSecond, 0);
});
