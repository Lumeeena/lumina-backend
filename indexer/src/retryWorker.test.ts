/**
 * Tests for the failed-ledger retry worker.
 *
 * The worker runs independently of the forward indexing loop, periodically
 * pulling from `ledger_retry_queue` and attempting to re-index each entry.
 * A ledger that keeps failing stays in the queue; one that succeeds is removed.
 * These tests verify that the worker processes retries correctly using a
 * stub pool rather than a real database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { RetryWorker } from './retryWorker';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * A minimal pool stub, used for both the read and write pool.
 *
 * `getPendingRetries` (read pool) uses `pool.query` to SELECT from
 * `ledger_retry_queue`; `removeLedgerFromRetryQueue` (write pool) uses it to
 * DELETE. The stub records all calls and returns configurable results.
 */
function makePoolStub(pendingByCall: number[][]): {
  pool: Pool;
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let callIndex = 0;

  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });

      // SELECT queries for pending retries return rows from the preconfigured list.
      if (sql.includes('ledger_retry_queue') && sql.includes('SELECT')) {
        const ledgers = pendingByCall[callIndex++] ?? [];
        return { rows: ledgers.map(ledger => ({ ledger })) };
      }
      // DELETE queries succeed silently.
      return { rows: [] };
    },
  } as unknown as Pool;

  return { pool, queries };
}

// ── successful retry ──────────────────────────────────────────────────────────

test('a ledger that succeeds on retry is removed from the queue', async () => {
  const indexed: number[] = [];
  let removedLedgers: number[] = [];
  let callCount = 0;

  const worker = new RetryWorker({
    pools: { read: {} as any, write: {} as any },
    network: 'testnet',
    indexOne: async (seq) => {
      indexed.push(seq);
      return true;
    },
    pollIntervalMs: 1,
    getPendingRetries: async () => {
      return callCount++ === 0 ? [42] : [];
    },
    removeLedgerFromRetryQueue: async (_, __, ledger) => {
      removedLedgers.push(ledger);
    },
  });

  // Run one cycle by starting and immediately stopping.
  const done = worker.start();
  await new Promise(r => setTimeout(r, 20));
  worker.stop();
  await done;

  assert.deepEqual(indexed, [42], 'indexOne should have been called for ledger 42');
  assert.deepEqual(removedLedgers, [42], 'ledger 42 should have been removed from the queue after success');
});

test('a ledger that fails on retry stays in the queue', async () => {
  // Provide the same ledger twice so the second cycle attempts it again.
  let callCount = 0;
  const getPendingRetries = async () => {
    return callCount++ === 0 ? [55] : [];
  };
  let removedLedgers: number[] = [];

  const worker = new RetryWorker({
    pools: { read: {} as any, write: {} as any },
    network: 'testnet',
    indexOne: async () => false, // always fails
    pollIntervalMs: 1,
    getPendingRetries,
    removeLedgerFromRetryQueue: async (_, __, ledger) => {
      removedLedgers.push(ledger);
    },
  });

  const done = worker.start();
  await new Promise(r => setTimeout(r, 30));
  worker.stop();
  await done;

  assert.equal(removedLedgers.length, 0, 'no remove should be called for a ledger that keeps failing');
});

test('an indexOne that throws does not crash the worker', async () => {
  let callCount = 0;
  const getPendingRetries = async () => {
    return callCount++ === 0 ? [99] : [];
  };

  let cycles = 0;
  const worker = new RetryWorker({
    pools: { read: {} as any, write: {} as any },
    network: 'testnet',
    indexOne: async () => {
      cycles++;
      throw new Error('simulated indexer crash');
    },
    pollIntervalMs: 1,
    getPendingRetries,
    removeLedgerFromRetryQueue: async () => {},
  });

  const done = worker.start();
  await new Promise(r => setTimeout(r, 30));
  worker.stop();
  await done;

  // The worker should have survived the throw and kept running.
  assert.ok(cycles >= 1, 'indexOne should have been called');
});

test('a failed ledger does not prevent later ledgers in the batch from retrying', async () => {
  const indexed: number[] = [];
  let removedLedgers: number[] = [];
  let callCount = 0;

  const worker = new RetryWorker({
    pools: { read: {} as any, write: {} as any },
    network: 'testnet',
    indexOne: async (seq) => {
      indexed.push(seq);
      if (seq === 101) throw new Error('temporary failure');
      return true;
    },
    pollIntervalMs: 1,
    getPendingRetries: async () => {
      return callCount++ === 0 ? [101, 102] : [];
    },
    removeLedgerFromRetryQueue: async (_, __, ledger) => {
      removedLedgers.push(ledger);
    },
  });

  const done = worker.start();
  await new Promise(r => setTimeout(r, 20));
  worker.stop();
  await done;

  assert.deepEqual(indexed, [101, 102]);
  assert.deepEqual(removedLedgers, [102], 'the successful later ledger should be removed from the queue');
});

// ── empty queue ───────────────────────────────────────────────────────────────

test('the worker is a no-op when the queue is empty', async () => {
  let indexOneCalled = false;

  const worker = new RetryWorker({
    pools: { read: {} as any, write: {} as any },
    network: 'testnet',
    indexOne: async () => {
      indexOneCalled = true;
      return true;
    },
    pollIntervalMs: 1,
    getPendingRetries: async () => [],
    removeLedgerFromRetryQueue: async () => {},
  });

  const done = worker.start();
  await new Promise(r => setTimeout(r, 20));
  worker.stop();
  await done;

  assert.equal(indexOneCalled, false, 'indexOne must not be called when nothing is queued');
});

// ── multiple ledgers in one cycle ─────────────────────────────────────────────

test('multiple pending ledgers in one cycle are each retried', async () => {
  const indexed: number[] = [];
  let removedLedgers: number[] = [];
  let callCount = 0;

  const worker = new RetryWorker({
    pools: { read: {} as any, write: {} as any },
    network: 'mainnet',
    indexOne: async (seq) => {
      indexed.push(seq);
      return true;
    },
    pollIntervalMs: 1,
    getPendingRetries: async () => {
      return callCount++ === 0 ? [10, 11, 12] : [];
    },
    removeLedgerFromRetryQueue: async (_, __, ledger) => {
      removedLedgers.push(ledger);
    },
  });

  const done = worker.start();
  await new Promise(r => setTimeout(r, 30));
  worker.stop();
  await done;

  assert.deepEqual(indexed.sort((a, b) => a - b), [10, 11, 12]);
  assert.deepEqual(removedLedgers.sort((a, b) => a - b), [10, 11, 12]);
});

// ── stop is respected mid-cycle ───────────────────────────────────────────────

test('stop() prevents new cycles from starting', async () => {
  let selectCalls = 0;

  const worker = new RetryWorker({
    pools: { read: {} as any, write: {} as any },
    network: 'mainnet',
    indexOne: async () => true,
    pollIntervalMs: 5,
    getPendingRetries: async () => {
      selectCalls++;
      return [];
    },
    removeLedgerFromRetryQueue: async () => {},
  });

  const done = worker.start();
  // Let one or two cycles run, then stop.
  await new Promise(r => setTimeout(r, 15));
  worker.stop();
  await done;
  const callsAtStop = selectCalls;

  // After stop returns, no more cycles should run.
  await new Promise(r => setTimeout(r, 20));
  assert.equal(selectCalls, callsAtStop, 'no getPendingRetries should be called after stop()');
});

// ── network isolation ──────────────────────────────────────────────────────────

test('network is passed to the database query', async () => {
  let passedNetwork: string | undefined;

  const worker = new RetryWorker({
    pools: { read: {} as any, write: {} as any },
    network: 'futurenet',
    indexOne: async () => true,
    pollIntervalMs: 1,
    getPendingRetries: async (_, network) => {
      passedNetwork = network;
      return [];
    },
    removeLedgerFromRetryQueue: async () => {},
  });

  const done = worker.start();
  await new Promise(r => setTimeout(r, 15));
  worker.stop();
  await done;

  assert.equal(
    passedNetwork,
    'futurenet',
    'network should be passed to getPendingRetries to prevent cross-network data mixing'
  );
});
