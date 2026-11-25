import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeSDK } from '@opentelemetry/sdk-node';

// Test setup: mock environment and SDK
const originalEnv = { ...process.env };

test('tracing module', async (t) => {
  await t.test('initTracing does nothing when OTEL_ENABLED is not set', async () => {
    // Clear OTEL_ENABLED to test disabled state
    delete process.env.OTEL_ENABLED;

    // Re-import to pick up new env
    const tracing = await import('./tracing');
    const sdkBefore = tracing.sdk;

    tracing.initTracing();
    const sdkAfter = tracing.sdk;

    assert.equal(sdkAfter, null, 'SDK should remain null when disabled');
  });

  await t.test('getTracer returns a tracer instance', async () => {
    // Re-import with OTEL_ENABLED false to avoid actual SDK init
    delete process.env.OTEL_ENABLED;
    const tracing = await import('./tracing');

    const tracer = tracing.getTracer();
    assert(tracer !== null, 'getTracer should return a tracer');
    assert.equal(typeof tracer.startSpan, 'function', 'tracer should have startSpan method');
  });

  await t.test('runWithSpan executes function and returns result', async () => {
    const tracing = await import('./tracing');

    const result = tracing.runWithSpan('test-span', (span) => {
      assert(span !== undefined, 'span should be provided');
      return { value: 42 };
    });

    assert.deepEqual(result, { value: 42 });
  });

  await t.test('runWithSpan propagates errors', async () => {
    const tracing = await import('./tracing');

    const error = new Error('test error');
    assert.throws(
      () => {
        tracing.runWithSpan('test-span', () => {
          throw error;
        });
      },
      error
    );
  });

  await t.test('runWithSpanAsync executes async function', async () => {
    const tracing = await import('./tracing');

    const result = await tracing.runWithSpanAsync('test-async-span', async (span) => {
      assert(span !== undefined, 'span should be provided');
      return { asyncValue: 'done' };
    });

    assert.deepEqual(result, { asyncValue: 'done' });
  });

  await t.test('runWithSpanAsync propagates async errors', async () => {
    const tracing = await import('./tracing');

    const error = new Error('async error');
    assert.rejects(
      () =>
        tracing.runWithSpanAsync('test-async-span', async () => {
          throw error;
        }),
      error
    );
  });

  await t.test('shutdownTracing is a no-op when SDK is null', async () => {
    const tracing = await import('./tracing');

    // Should not throw even though SDK is null
    await assert.doesNotReject(() => tracing.shutdownTracing());
  });

  // Restore original environment
  process.env = { ...originalEnv };
});
