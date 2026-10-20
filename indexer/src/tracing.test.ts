import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithSpanAsync } from './tracing';

test('runWithSpanAsync awaits its callback and returns its result', async () => {
  const result = await runWithSpanAsync('indexer.test', async span => {
    assert.ok(span);
    await Promise.resolve();
    return 'completed';
  });

  assert.equal(result, 'completed');
});

test('runWithSpanAsync propagates callback failures', async () => {
  const failure = new Error('operation failed');

  await assert.rejects(
    runWithSpanAsync('indexer.test.failure', async () => {
      await Promise.resolve();
      throw failure;
    }),
    error => error === failure
  );
});
