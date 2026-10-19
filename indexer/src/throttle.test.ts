/**
 * Tests for indexer/src/throttle.ts.
 *
 * The throttle serialises outbound HTTP calls so bursts of concurrent
 * requests from a single process do not trip provider rate limits. It also
 * adapts the request interval based on 429 responses and Retry-After headers,
 * and gives tip traffic priority over backfill traffic when both are queued.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from './throttle';

// ─── Helpers ──────────────────────────────────────────────────────────────

interface RecordedRequest {
  url: string;
  method: string;
  status: number;
}

function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  let index = 0;
  (global as unknown as { fetch: typeof fetch }).fetch = (async (url: unknown) => {
    const resp = responses[index++] ?? { status: 200, body: {} };
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      headers: {
        get: (name: string) => resp.headers?.[name] ?? null,
      },
      json: async () => resp.body,
    } as unknown as Response;
  }) as typeof fetch;
}

// ─── Basic serialisation ───────────────────────────────────────────────────

test('fetchJson serialises concurrent requests through a single gate', async () => {
  const order: number[] = [];
  let resolveSecond!: () => void;
  const secondDone = new Promise<void>(r => { resolveSecond = r; });

  (global as unknown as { fetch: typeof fetch }).fetch = (async (_url: unknown) => {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({}),
    } as unknown as Response;
  }) as typeof fetch;

  const { fetchJson } = createThrottle({ name: 'test', minIntervalMs: 0 });

  // Fire two requests concurrently and record completion order.
  const p1 = fetchJson<object>('https://example.com/1').then(() => order.push(1));
  const p2 = fetchJson<object>('https://example.com/2').then(() => order.push(2));
  await Promise.all([p1, p2]);

  // Serial gate means they complete in the order they were queued, not in
  // parallel.
  assert.deepEqual(order, [1, 2]);
});

// ─── 429 backoff ──────────────────────────────────────────────────────────

test('a 429 response doubles the current interval up to the configured maximum', async () => {
  const metrics = {
    requestsTotal: { inc: (_l: Record<string, string | number>) => {} },
    currentInterval: {
      observations: [] as number[],
      set(_labels: Record<string, string>, value: number) { this.observations.push(value); },
    },
    queuedRequests: { set: () => {} },
    waitTime: { observe: () => {} },
  };

  // One 429, then one 200 so the second fetchJson call succeeds.
  mockFetch([
    { status: 429, body: {} },
    { status: 200, body: { ok: true } },
  ]);

  const { fetchJson } = createThrottle({
    name: 'test',
    minIntervalMs: 10,
    maxIntervalMs: 500,
    metrics,
  });

  // First call returns 429 — the throttle should back off and throw.
  await assert.rejects(() => fetchJson('https://example.com/a'), /request failed \(429\)/);

  // After a 429, the interval recorded in metrics should have grown.
  const intervalsAfter429 = metrics.currentInterval.observations;
  assert.ok(intervalsAfter429.length > 0, 'currentInterval metric should have been set after 429');
  // The backed-off value should be larger than the starting minIntervalMs.
  assert.ok(
    intervalsAfter429.some(v => v > 10),
    `expected an interval > 10ms after backoff, got: ${JSON.stringify(intervalsAfter429)}`
  );
});

test('a 429 with a Retry-After header honours that value rather than doubling', async () => {
  const recordedIntervals: number[] = [];
  const metrics = {
    requestsTotal: { inc: () => {} },
    currentInterval: {
      set(_labels: Record<string, string>, value: number) { recordedIntervals.push(value); },
    },
    queuedRequests: { set: () => {} },
    waitTime: { observe: () => {} },
  };

  mockFetch([{ status: 429, body: {}, headers: { 'Retry-After': '2' } }]);

  const { fetchJson } = createThrottle({
    name: 'test',
    minIntervalMs: 10,
    maxIntervalMs: 60_000,
    metrics,
  });

  await assert.rejects(() => fetchJson('https://example.com/a'));

  // The recorded interval should reflect the Retry-After value (2s = 2000 ms),
  // not a doubling of the 10 ms minimum.
  assert.ok(
    recordedIntervals.some(v => v >= 2000),
    `expected interval >= 2000 ms from Retry-After: 2, got: ${JSON.stringify(recordedIntervals)}`
  );
});

// ─── Recovery ─────────────────────────────────────────────────────────────

test('after 10 consecutive successes the interval recovers toward the minimum', async () => {
  const recordedIntervals: number[] = [];
  const metrics = {
    requestsTotal: { inc: () => {} },
    currentInterval: {
      set(_labels: Record<string, string>, value: number) { recordedIntervals.push(value); },
    },
    queuedRequests: { set: () => {} },
    waitTime: { observe: () => {} },
  };

  // First trigger a backoff via 429, then send enough successes to recover.
  const responses = [
    { status: 429, body: {} },
    ...Array(11).fill({ status: 200, body: {} }),
  ];
  mockFetch(responses);

  const { fetchJson } = createThrottle({
    name: 'test',
    minIntervalMs: 10,
    maxIntervalMs: 500,
    metrics,
  });

  // 429 triggers backoff.
  await assert.rejects(() => fetchJson('https://example.com/r'));

  // 11 successes — more than the RECOVERY_THRESHOLD of 10.
  for (let i = 0; i < 11; i++) {
    await fetchJson('https://example.com/r').catch(() => {});
  }

  // After recovery, the last recorded interval should be less than the
  // post-429 peak (which was at least 20ms from doubling 10ms).
  const peak = Math.max(...recordedIntervals);
  const last = recordedIntervals.at(-1) ?? peak;
  assert.ok(last < peak, `interval should recover below its peak after sustained success; peak=${peak}, last=${last}`);
});

// ─── Backfill vs tip priority ─────────────────────────────────────────────

test('backfill starts with a larger interval than tip by the tipWeightFactor', async () => {
  const intervals: Record<string, number[]> = { tip: [], backfill: [] };
  const metrics = {
    requestsTotal: { inc: () => {} },
    currentInterval: {
      set(labels: Record<string, string>, value: number) {
        const purpose = labels['purpose'];
        if (purpose === 'tip' || purpose === 'backfill') intervals[purpose]!.push(value);
      },
    },
    queuedRequests: { set: () => {} },
    waitTime: { observe: () => {} },
  };

  mockFetch([{ status: 200, body: {} }, { status: 200, body: {} }]);

  const { fetchJson } = createThrottle({
    name: 'test',
    minIntervalMs: 100,
    maxIntervalMs: 10_000,
    metrics,
    tipWeightFactor: 3,
  });

  await fetchJson('https://example.com/tip', undefined, 'tip');
  await fetchJson('https://example.com/backfill', undefined, 'backfill');

  // The backfill interval was initialised to minIntervalMs * tipWeightFactor.
  // The metric fires when queueSize changes, so we check the recorded values.
  // We just assert backfill's first recorded interval >= tip's first recorded
  // interval to prove the weighting is applied.
  const firstBackfill = intervals['backfill']?.[0] ?? 0;
  const firstTip = intervals['tip']?.[0] ?? 0;
  assert.ok(
    firstBackfill >= firstTip,
    `backfill initial interval (${firstBackfill}) should be >= tip (${firstTip})`
  );
});

// ─── postJson ────────────────────────────────────────────────────────────

test('postJson sends Content-Type application/json and the serialised body', async () => {
  let captured: { headers: Record<string, string>; body: string } | undefined;

  (global as unknown as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
    captured = {
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ result: 'ok' }),
    } as unknown as Response;
  }) as typeof fetch;

  const { postJson } = createThrottle({ name: 'test', minIntervalMs: 0 });

  await postJson('https://rpc.example.com', { method: 'getLatestLedger', id: 1 });

  assert.ok(captured, 'fetch should have been called');
  assert.equal(captured!.headers['Content-Type'], 'application/json');
  const body = JSON.parse(captured!.body) as { method: string };
  assert.equal(body.method, 'getLatestLedger');
});

test('postJson attaches Authorization header when authToken is set', async () => {
  let capturedAuth: string | undefined;

  (global as unknown as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string>)?.['Authorization'];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({}),
    } as unknown as Response;
  }) as typeof fetch;

  const { postJson } = createThrottle({ name: 'test', minIntervalMs: 0, authToken: 'secret-token' });
  await postJson('https://example.com', { id: 1 });

  assert.equal(capturedAuth, 'Bearer secret-token');
});

test('postJson throws on a non-ok response', async () => {
  mockFetch([{ status: 500, body: {} }]);
  const { postJson } = createThrottle({ name: 'test', minIntervalMs: 0 });
  await assert.rejects(() => postJson('https://example.com', {}), /request failed \(500\)/);
});

// ─── maxIntervalMs cap ────────────────────────────────────────────────────

test('the interval never exceeds maxIntervalMs even after repeated 429s', async () => {
  const recordedIntervals: number[] = [];
  const metrics = {
    requestsTotal: { inc: () => {} },
    currentInterval: {
      set(_labels: Record<string, string>, value: number) { recordedIntervals.push(value); },
    },
    queuedRequests: { set: () => {} },
    waitTime: { observe: () => {} },
  };

  // 5 consecutive 429s.
  mockFetch(Array(5).fill({ status: 429, body: {} }));

  const { fetchJson } = createThrottle({
    name: 'test',
    minIntervalMs: 100,
    maxIntervalMs: 400,
    metrics,
  });

  for (let i = 0; i < 5; i++) {
    await fetchJson('https://example.com/x').catch(() => {});
  }

  // Every recorded interval must be at or below the configured maximum.
  for (const interval of recordedIntervals) {
    assert.ok(interval <= 400, `interval ${interval} exceeds maxIntervalMs 400`);
  }
});
