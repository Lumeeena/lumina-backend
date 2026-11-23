import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTracer, runWithSpan, runWithSpanAsync, initTracing, shutdownTracing, sdk } from './tracing';

test('getTracer returns a tracer instance with standard span creation methods', () => {
  const tracer = getTracer();
  assert.ok(tracer, 'tracer should be defined');
  assert.equal(typeof tracer.startSpan, 'function', 'startSpan should be a function');
});

test('runWithSpan executes synchronous callback, returns its value, and ends span', () => {
  let spanEnded = false;
  const result = runWithSpan('test.sync.op', (span) => {
    assert.ok(span, 'span should be provided to callback');
    const origEnd = span.end.bind(span);
    span.end = () => {
      spanEnded = true;
      origEnd();
    };
    return 42;
  });

  assert.equal(result, 42);
  assert.equal(spanEnded, true, 'span.end() must be called in finally block');
});

test('runWithSpan guarantees span.end() is called even if callback throws', () => {
  let spanEnded = false;
  assert.throws(
    () => {
      runWithSpan('test.sync.error', (span) => {
        const origEnd = span.end.bind(span);
        span.end = () => {
          spanEnded = true;
          origEnd();
        };
        throw new Error('deliberate sync failure');
      });
    },
    { message: 'deliberate sync failure' }
  );

  assert.equal(spanEnded, true, 'span.end() must be called even on exception');
});

test('runWithSpanAsync executes async callback, returns resolved value, and ends span', async () => {
  let spanEnded = false;
  const result = await runWithSpanAsync('test.async.op', async (span) => {
    assert.ok(span, 'span should be provided to async callback');
    const origEnd = span.end.bind(span);
    span.end = () => {
      spanEnded = true;
      origEnd();
    };
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'async_result';
  });

  assert.equal(result, 'async_result');
  assert.equal(spanEnded, true, 'span.end() must be called on async completion');
});

test('runWithSpanAsync guarantees span.end() is called even if promise rejects', async () => {
  let spanEnded = false;
  await assert.rejects(
    async () => {
      await runWithSpanAsync('test.async.error', async (span) => {
        const origEnd = span.end.bind(span);
        span.end = () => {
          spanEnded = true;
          origEnd();
        };
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('deliberate async failure');
      });
    },
    { message: 'deliberate async failure' }
  );

  assert.equal(spanEnded, true, 'span.end() must be called even on async rejection');
});

test('initTracing is a safe no-op when OTEL_ENABLED is not enabled', () => {
  assert.equal(sdk, null);
  initTracing();
  assert.equal(sdk, null, 'sdk should remain null when OTEL_ENABLED is false');
});

test('shutdownTracing cleanly resolves without errors when sdk is null', async () => {
  await assert.doesNotReject(async () => {
    await shutdownTracing();
  });
});
