import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchAndIndexLedgerWithRetry,
  runIndependently,
  runLedgerCatchUp,
  calculateBackoffWithJitter,
  repairLedgerGaps,
} from './index';

test('ledger catch-up advances the cursor after each indexed ledger', async () => {
  const indexed: number[] = [];
  const advanced: number[] = [];

  const cursor = await runLedgerCatchUp(99, 102, async sequence => {
    indexed.push(sequence);
    return true;
  }, sequence => advanced.push(sequence));

  assert.equal(cursor, 102);
  assert.deepEqual(indexed, [100, 101, 102]);
  assert.deepEqual(advanced, [100, 101, 102]);
});

test('ledger catch-up stops at the first failed ledger without skipping the gap', async () => {
  const indexed: number[] = [];

  const cursor = await runLedgerCatchUp(99, 102, async sequence => {
    indexed.push(sequence);
    return sequence !== 101;
  });

  assert.equal(cursor, 100);
  assert.deepEqual(indexed, [100, 101]);
});

test('retry exhaustion reports failure, records failed ledger, and enqueues for durable retry', async () => {
  let attempts = 0;
  const enqueued: { network: string; sequence: number; error: string }[] = [];
  const recordedFailed: { network: string; sequence: number; error: string; attempts: number }[] = [];

  const indexed = await fetchAndIndexLedgerWithRetry('mainnet', 200, async () => {
    attempts++;
    throw new Error('scripted Horizon 429');
  }, 3, 0, async (network, sequence, error) => {
    enqueued.push({ network, sequence, error });
  }, async (network, sequence, error, att) => {
    recordedFailed.push({ network, sequence, error, attempts: att });
  });

  assert.equal(indexed, false);
  assert.equal(attempts, 3);
  // Giving up without recording it would drop the ledger entirely: the cursor
  // does not advance and nothing is left to retry it.
  assert.deepEqual(enqueued, [
    { network: 'mainnet', sequence: 200, error: 'scripted Horizon 429' },
  ]);
  assert.deepEqual(recordedFailed, [
    { network: 'mainnet', sequence: 200, error: 'scripted Horizon 429', attempts: 3 },
  ]);
});


test('a ledger that indexes is not enqueued for durable retry', async () => {
  const enqueued: number[] = [];

  const indexed = await fetchAndIndexLedgerWithRetry(
    'testnet',
    5,
    async () => {},
    3,
    0,
    async (_network, sequence) => { enqueued.push(sequence); }
  );

  assert.equal(indexed, true);
  assert.deepEqual(enqueued, []);
});

test('a transient Horizon failure retries and then indexes the ledger', async () => {
  let attempts = 0;

  const indexed = await fetchAndIndexLedgerWithRetry('mainnet', 201, async () => {
    attempts++;
    if (attempts === 1) throw new Error('scripted Horizon 503');
  }, 3, 0);

  assert.equal(indexed, true);
  assert.equal(attempts, 2);
});

test('runIndependently keeps other tasks running when one rejects', async () => {
  const finished: string[] = [];
  await runIndependently(['a', 'b', 'c'], async name => {
    if (name === 'b') throw new Error('boom');
    await new Promise(r => setTimeout(r, 5));
    finished.push(name);
  });
  assert.deepEqual(finished.sort(), ['a', 'c']);
});

test('runIndependently runs tasks concurrently with independent state', async () => {
  const cursors: Record<string, number> = { mainnet: 0, testnet: 0 };
  const order: string[] = [];
  await runIndependently(['mainnet', 'testnet'], async name => {
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 1));
      cursors[name] += name === 'mainnet' ? 1 : 10;
      order.push(name);
    }
  });
  assert.deepEqual(cursors, { mainnet: 3, testnet: 30 });
  assert.ok(order.indexOf('testnet') < order.lastIndexOf('mainnet'), 'interleaved');
});

test('calculateBackoffWithJitter bounds delay and varies between attempts', () => {
  const baseMs = 1000;
  const maxDelayMs = 5000;

  // Zero and negative baseMs return 0
  assert.equal(calculateBackoffWithJitter(0, 1), 0);
  assert.equal(calculateBackoffWithJitter(-10, 2), 0);

  // Attempt 1: ceiling is 1000, half is 500 -> delay in [500, 1000]
  const delaysAttempt1 = new Set<number>();
  for (let i = 0; i < 50; i++) {
    const delay = calculateBackoffWithJitter(baseMs, 1, maxDelayMs);
    assert.ok(delay >= 500 && delay <= 1000, `Delay ${delay} should be between 500 and 1000`);
    delaysAttempt1.add(delay);
  }
  // Two retries at the same attempt number wait different amounts (jitter variance)
  assert.ok(delaysAttempt1.size > 1, 'Delays at attempt 1 should vary');

  // Attempt 2: ceiling is 2000, half is 1000 -> delay in [1000, 2000]
  for (let i = 0; i < 20; i++) {
    const delay = calculateBackoffWithJitter(baseMs, 2, maxDelayMs);
    assert.ok(delay >= 1000 && delay <= 2000, `Delay ${delay} should be between 1000 and 2000`);
  }

  // Attempt 10: ceiling capped at maxDelayMs (5000), half is 2500 -> delay in [2500, 5000]
  for (let i = 0; i < 20; i++) {
    const delay = calculateBackoffWithJitter(baseMs, 10, maxDelayMs);
    assert.ok(delay >= 2500 && delay <= maxDelayMs, `Delay ${delay} should be bounded by maxDelayMs`);
  }
});

test('calculateBackoffWithJitter supports injected random function', () => {
  // Deterministic min (random = 0)
  assert.equal(calculateBackoffWithJitter(1000, 1, 30000, () => 0), 500);
  // Deterministic max (random = 1)
  assert.equal(calculateBackoffWithJitter(1000, 1, 30000, () => 1), 1000);
});

test('repairLedgerGaps detects and repairs gaps and reports count', async () => {
  let gapCount = 2;
  const fakePool = {
    query: async (sql: string) => {
      if (sql.includes('COUNT(')) {
        return { rows: [{ count: String(gapCount) }] };
      }
      if (sql.includes('seq_gaps')) {
        return { rows: [{ sequence: '102' }, { sequence: '105' }] };
      }
      return { rows: [] };
    },
  } as any;

  const repairedLedgers: number[] = [];
  const result = await repairLedgerGaps(fakePool, 'testnet', async (seq) => {
    repairedLedgers.push(seq);
    gapCount--;
    return true;
  });

  assert.equal(result.detected, 2);
  assert.equal(result.repaired, 2);
  assert.deepEqual(repairedLedgers, [102, 105]);
});

