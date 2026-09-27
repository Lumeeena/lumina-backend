import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAndIndexLedgerWithRetry, runIndependently, runLedgerCatchUp } from './index';

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

test('retry exhaustion reports failure so the cursor is not advanced', async () => {
  let attempts = 0;

  const indexed = await fetchAndIndexLedgerWithRetry(200, async () => {
    attempts++;
    throw new Error('scripted Horizon 429');
  }, 3, 0);

  assert.equal(indexed, false);
  assert.equal(attempts, 3);
});

test('a transient Horizon failure retries and then indexes the ledger', async () => {
  let attempts = 0;

  const indexed = await fetchAndIndexLedgerWithRetry(201, async () => {
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
