import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSlowOperationThresholdMs, redactVariables, slowOperationPlugin, REDACTED } from './slowOperations';

async function run(thresholdMs: number, delayMs: number) {
  const logs: Array<{ fields: Record<string, any>; message: string }> = [];
  const plugin = slowOperationPlugin({ thresholdMs, log: (fields, message) => logs.push({ fields, message }) });
  const listener: any = await (plugin as any).requestDidStart({});
  await new Promise(r => setTimeout(r, delayMs));
  await listener.willSendResponse?.({
    operationName: 'Events',
    operation: { operation: 'query' },
    request: { variables: { limit: 5, apiKey: 'abc', nested: { password: 'p', ok: 1 } } },
  });
  return logs;
}

test('a slow operation logs its name, duration and redacted variables', async () => {
  const [entry] = await run(10, 30);
  assert.equal(entry.message, 'slow GraphQL operation');
  assert.equal(entry.fields.operation, 'Events');
  assert.ok(entry.fields.durationMs >= 10);
  assert.deepEqual(entry.fields.variables, { limit: 5, apiKey: REDACTED, nested: { password: REDACTED, ok: 1 } });
});

test('a fast operation logs nothing', async () => {
  assert.equal((await run(60_000, 0)).length, 0);
});

test('threshold 0 disables the plugin listener entirely', async () => {
  const plugin: any = slowOperationPlugin({ thresholdMs: 0 });
  assert.deepEqual(await plugin.requestDidStart({}), {});
});

test('threshold parsing and redaction of arrays', () => {
  assert.equal(loadSlowOperationThresholdMs({}), 1000);
  assert.equal(loadSlowOperationThresholdMs({ SLOW_OPERATION_THRESHOLD_MS: '250' }), 250);
  assert.deepEqual(redactVariables([{ token: 't' }]), [{ token: REDACTED }]);
});
