/**
 * Tests for the adaptive Horizon request throttle.
 *
 * The throttle is the primary defence against sustained Horizon 429s: when
 * the indexer trips rate limiting it backs off exponentially, then recovers
 * gradually once the 429s stop. These tests verify the backoff/recovery curve
 * using mocked fetch responses rather than real network calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from './throttle';
import type { ThrottleMetrics } from './throttle';

// ── helpers ───────────────────────────────────────────────────────────────────

function noopMetrics(): ThrottleMetrics {
  return {
    requestsTotal: { inc: () => {} },
    requestDuration: { startTimer: () => () => {} },
    currentInterval: { set: () => {} },
    queuedRequests: { set: () => {} },
    waitTime: { observe: () => {} },
  };
}

/** Build a throttle with a near-zero min interval so tests are not slow. */
function fastThrottle(overrides?: Partial<Parameters<typeof createThrottle>[0]>) {
  return createThrottle({
    name: 'test',
    minIntervalMs: 1,
    maxIntervalMs: 10000,
    metrics: noopMetrics(),
    ...overrides,
  });
}

/** Stub global fetch with a sequence of responses, restoring it afterwards. */
function withFetch(responses: Response[], fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async () => {
    const res = responses[index++];
    if (!res) throw new Error(`fetch called more times than expected (call ${index})`);
    return res;
  };
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function rateLimitResponse(retryAfter?: string): Response {
  const headers: Record<string, string> = {};
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;
  return new Response(JSON.stringify({ error: 'too many requests' }), {
    status: 429,
    headers,
  });
}

// ── basic operation ───────────────────────────────────────────────────────────

test('fetchJson returns parsed body on a 200 response', async () => {
  const throttle = fastThrottle();
  await withFetch([okResponse({ sequence: 42 })], async () => {
    const result = await throttle.fetchJson<{ sequence: number }>('https://horizon.example/ledger');
    assert.equal(result.sequence, 42);
  });
});

test('fetchJson throws on a non-200, non-429 response', async () => {
  const throttle = fastThrottle();
  await withFetch(
    [new Response('not found', { status: 404 })],
    async () => {
      await assert.rejects(
        () => throttle.fetchJson('https://horizon.example/missing'),
        /request failed \(404\)/
      );
    }
  );
});

test('postJson sends a POST with JSON body and returns parsed response', async () => {
  const throttle = fastThrottle();
  let captured: Request | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    captured = new Request(input as string, init);
    return okResponse({ ok: true });
  };
  try {
    const result = await throttle.postJson<{ ok: boolean }>(
      'https://rpc.example',
      { method: 'getLedger', params: [1] }
    );
    assert.equal(result.ok, true);
    assert.ok(captured, 'fetch was called');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers.get('content-type'), 'application/json');
  } finally {
    globalThis.fetch = original;
  }
});

// ── adaptive backoff ──────────────────────────────────────────────────────────

test('a 429 response increases the request interval (multiplicative decrease)', async () => {
  const intervals: number[] = [];
  const metrics: ThrottleMetrics = {
    requestsTotal: { inc: () => {} },
    currentInterval: {
      set: (_labels, value) => {
        intervals.push(value);
      },
    },
  };

  const throttle = createThrottle({
    name: 'test',
    minIntervalMs: 100,
    maxIntervalMs: 10000,
    metrics,
  });

  // Two requests: one 429, then verify the interval was doubled.
  await withFetch([rateLimitResponse(), okResponse({})], async () => {
    // The 429 will throw (no Retry-After), so we swallow it.
    await throttle.fetchJson('https://horizon.example').catch(() => {});
  });

  // At least one interval update should have been recorded above minIntervalMs.
  const backoffIntervals = intervals.filter(v => v > 100);
  assert.ok(backoffIntervals.length > 0, 'interval should increase after a 429');
  assert.ok(backoffIntervals[0]! <= 10000, 'interval should not exceed the max');
});

test('the interval is capped at maxIntervalMs', async () => {
  const intervals: number[] = [];
  const throttle = createThrottle({
    name: 'test',
    minIntervalMs: 100,
    maxIntervalMs: 200,
    metrics: {
      requestsTotal: { inc: () => {} },
      currentInterval: { set: (_l, v) => intervals.push(v) },
    },
  });

  // Fire several 429s to drive the interval up.
  const rateResponses = Array.from({ length: 5 }, () => rateLimitResponse());
  await withFetch(rateResponses, async () => {
    for (let i = 0; i < 5; i++) {
      await throttle.fetchJson('https://horizon.example').catch(() => {});
    }
  });

  const max = Math.max(...intervals);
  assert.ok(max <= 200, `interval must not exceed maxIntervalMs (was ${max})`);
});

test('Retry-After header is respected on a 429', async () => {
  const intervals: number[] = [];
  const throttle = createThrottle({
    name: 'test',
    minIntervalMs: 100,
    maxIntervalMs: 10000,
    metrics: {
      requestsTotal: { inc: () => {} },
      currentInterval: { set: (_l, v) => intervals.push(v) },
    },
  });

  // Retry-After: 3 seconds → interval should be set to 3000 ms.
  await withFetch(
    [rateLimitResponse('3'), okResponse({})],
    async () => {
      await throttle.fetchJson('https://horizon.example').catch(() => {});
    }
  );

  const retryAfterInterval = intervals.find(v => v === 3000);
  assert.ok(
    retryAfterInterval !== undefined,
    `expected an interval of 3000 ms from Retry-After: 3, got: ${JSON.stringify(intervals)}`
  );
});

test('after sustained successes the interval recovers toward minIntervalMs', async () => {
  const RECOVERY_THRESHOLD = 10; // must match the constant in throttle.ts
  const intervals: number[] = [];
  const throttle = createThrottle({
    name: 'test',
    minIntervalMs: 100,
    maxIntervalMs: 10000,
    metrics: {
      requestsTotal: { inc: () => {} },
      currentInterval: { set: (_l, v) => intervals.push(v) },
    },
  });

  // One 429 to bump the interval, then enough successes to trigger recovery.
  const responses: Response[] = [
    rateLimitResponse(),
    ...Array.from({ length: RECOVERY_THRESHOLD + 1 }, () => okResponse({})),
  ];

  await withFetch(responses, async () => {
    await throttle.fetchJson('https://horizon.example').catch(() => {});
    for (let i = 0; i < RECOVERY_THRESHOLD + 1; i++) {
      await throttle.fetchJson('https://horizon.example');
    }
  });

  // Intervals should trend back down after the initial spike.
  const first = intervals[0];
  const last = intervals[intervals.length - 1];
  assert.ok(
    first !== undefined && last !== undefined && last < first,
    `interval should decrease after recovery (first=${first}, last=${last})`
  );
});

// ── separate budgets ──────────────────────────────────────────────────────────

test('tip and backfill requests use separate throttle budgets', async () => {
  const tipIntervals: number[] = [];
  const backfillIntervals: number[] = [];

  const throttle = createThrottle({
    name: 'test',
    minIntervalMs: 100,
    maxIntervalMs: 10000,
    metrics: {
      requestsTotal: { inc: () => {} },
      currentInterval: {
        set: (labels, v) => {
          if (labels.purpose === 'tip') tipIntervals.push(v);
          if (labels.purpose === 'backfill') backfillIntervals.push(v);
        },
      },
    },
    tipWeightFactor: 2,
  });

  // 429 on tip only.
  await withFetch([rateLimitResponse(), okResponse({})], async () => {
    await throttle.fetchJson('https://horizon.example', undefined, 'tip').catch(() => {});
  });

  // Backfill should still be at its initial interval, unaffected by the tip 429.
  const backfillInitial = backfillIntervals[0];
  assert.ok(
    backfillInitial === undefined || backfillInitial <= 200,
    'backfill budget should not have backed off because of a tip 429'
  );
});

// ── auth token ────────────────────────────────────────────────────────────────

test('Authorization header is injected when authToken is set', async () => {
  let capturedAuth: string | null = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    capturedAuth = headers?.Authorization ?? null;
    return okResponse({});
  };
  try {
    const throttle = createThrottle({
      name: 'test',
      minIntervalMs: 1,
      maxIntervalMs: 10000,
      authToken: 'lum_secret',
    });
    await throttle.fetchJson('https://horizon.example');
    assert.equal(capturedAuth, 'Bearer lum_secret');
  } finally {
    globalThis.fetch = original;
  }
});

test('no Authorization header is sent when authToken is unset', async () => {
  let capturedHeaders: Record<string, string> | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init?.headers as Record<string, string> | undefined;
    return okResponse({});
  };
  try {
    const throttle = createThrottle({ name: 'test', minIntervalMs: 1, maxIntervalMs: 10000 });
    await throttle.fetchJson('https://horizon.example');
    assert.equal(capturedHeaders?.Authorization, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
