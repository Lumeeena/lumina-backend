/**
 * Unit tests for per-key and anonymous token-bucket rate limiting (#374).
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { ANONYMOUS_CALLER, CALLER_LOCALS_KEY, type ApiCaller } from './auth';
import { ERROR_CODES } from './errorCodes';
import {
  checkRateLimit,
  evaluateRateLimit,
  parseAnonymousRateLimit,
  rateLimitMiddleware,
  resetRateLimitBuckets,
  retryAfter,
} from './rateLimit';

function makeCaller(overrides: Partial<ApiCaller> = {}): ApiCaller {
  return {
    kind: 'api-key',
    keyId: 1,
    label: 'test-app',
    rateLimit: 60,
    ...overrides,
  };
}

function makeMockRes(caller?: ApiCaller) {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let jsonBody: unknown;

  const locals: Record<PropertyKey, unknown> = {};
  if (caller) {
    locals[CALLER_LOCALS_KEY] = caller;
  }

  const res = {
    locals,
    set(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      jsonBody = body;
      return res;
    },
  } as unknown as Response;

  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get jsonBody() {
      return jsonBody;
    },
    headers,
  };
}

describe('rateLimit token bucket', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  test('allows burst up to the key rateLimit and rejects the next request', () => {
    const caller = makeCaller({ keyId: 10, rateLimit: 3 });
    const t0 = 1_700_000_000_000;

    for (let i = 0; i < 3; i++) {
      const decision = evaluateRateLimit(caller, { now: t0 });
      assert.equal(decision.allowed, true);
      assert.equal(decision.limit, 3);
      assert.equal(decision.remaining, 2 - i);
      assert.equal(decision.retryAfterSeconds, 0);
    }

    const rejected = evaluateRateLimit(caller, { now: t0 });
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.remaining, 0);
    // 3 req/min => 1 token every 20 seconds
    assert.equal(rejected.retryAfterSeconds, 20);
    assert.equal(retryAfter(caller, { now: t0 }), 20);
  });

  test('refills tokens proportionally over time and caps at the bucket size', () => {
    const caller = makeCaller({ keyId: 11, rateLimit: 60 }); // 1 token / second
    const t0 = 1_700_000_000_000;

    // Drain the full bucket of 60 tokens.
    for (let i = 0; i < 60; i++) {
      assert.equal(checkRateLimit(caller, { now: t0 }), true);
    }
    assert.equal(checkRateLimit(caller, { now: t0 }), false);

    // After 500ms, only 0.5 token refilled -> still rejected.
    assert.equal(checkRateLimit(caller, { now: t0 + 500 }), false);
    assert.equal(retryAfter(caller, { now: t0 + 500 }), 1);

    // After 1000ms total, 1 token refilled -> allowed once, then empty again.
    assert.equal(checkRateLimit(caller, { now: t0 + 1000 }), true);
    assert.equal(checkRateLimit(caller, { now: t0 + 1000 }), false);

    // After a long quiet period (10 minutes), bucket caps back at 60 (never exceeds rateLimit).
    const afterQuiet = evaluateRateLimit(caller, { now: t0 + 600_000 });
    assert.equal(afterQuiet.allowed, true);
    assert.equal(afterQuiet.remaining, 59);
  });

  test('isolates buckets per key and leaves unlimited callers unthrottled', () => {
    const keyA = makeCaller({ keyId: 21, rateLimit: 1 });
    const keyB = makeCaller({ keyId: 22, rateLimit: 1 });
    const admin = makeCaller({ keyId: 23, rateLimit: null });
    const t0 = 1_700_000_000_000;

    assert.equal(checkRateLimit(keyA, { now: t0 }), true);
    assert.equal(checkRateLimit(keyA, { now: t0 }), false);
    // Key B has its own full bucket.
    assert.equal(checkRateLimit(keyB, { now: t0 }), true);

    // Unlimited caller never gets rejected.
    for (let i = 0; i < 10; i++) {
      const decision = evaluateRateLimit(admin, { now: t0 });
      assert.equal(decision.allowed, true);
      assert.equal(decision.limit, null);
    }
  });

  test('parseAnonymousRateLimit parses positive limits and disables on unset/0/unlimited', () => {
    assert.equal(parseAnonymousRateLimit(undefined), null);
    assert.equal(parseAnonymousRateLimit(''), null);
    assert.equal(parseAnonymousRateLimit('0'), null);
    assert.equal(parseAnonymousRateLimit('unlimited'), null);
    assert.equal(parseAnonymousRateLimit('20'), 20);
    assert.equal(parseAnonymousRateLimit('not-a-number'), null);
  });
});

describe('rateLimitMiddleware', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  test('attaches X-RateLimit headers and rejects over-limit API key with 429, Retry-After, and RATE_LIMITED', () => {
    let now = 1_700_000_000_000;
    const mw = rateLimitMiddleware({ now: () => now });
    const caller = makeCaller({ keyId: 30, rateLimit: 2 });
    const req = { ip: '127.0.0.1' } as Request;

    // Requests 1 & 2 succeed.
    for (let i = 0; i < 2; i++) {
      let nextCalled = false;
      const mock = makeMockRes(caller);
      mw(req, mock.res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(mock.headers['x-ratelimit-limit'], '2');
      assert.equal(mock.headers['x-ratelimit-remaining'], String(1 - i));
      assert.ok(mock.headers['x-ratelimit-reset']);
    }

    // Request 3 is throttled.
    let nextCalled = false;
    const throttled = makeMockRes(caller);
    mw(req, throttled.res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(throttled.statusCode, 429);
    assert.equal(throttled.headers['retry-after'], '30');
    assert.equal(throttled.headers['x-ratelimit-remaining'], '0');
    const body = throttled.jsonBody as {
      errors: Array<{ message: string; extensions: { code: string; limit: number; retryAfter: number } }>;
    };
    assert.equal(body.errors[0].extensions.code, ERROR_CODES.RATE_LIMITED);
    assert.equal(body.errors[0].extensions.limit, 2);
    assert.equal(body.errors[0].extensions.retryAfter, 30);

    // Advance 30s -> 1 token refilled -> next request succeeds.
    now += 30_000;
    let recoveredNext = false;
    const recovered = makeMockRes(caller);
    mw(req, recovered.res, () => {
      recoveredNext = true;
    });
    assert.equal(recoveredNext, true);
  });

  test('leaves anonymous callers unthrottled by default and throttles per IP when configured', () => {
    const now = 1_700_000_000_000;

    // Default: unthrottled
    const defaultMw = rateLimitMiddleware({ now: () => now });
    for (let i = 0; i < 5; i++) {
      let nextCalled = false;
      const mock = makeMockRes(ANONYMOUS_CALLER);
      defaultMw({ ip: '10.0.0.1' } as Request, mock.res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(mock.headers['x-ratelimit-limit'], undefined);
    }

    // Configured per-IP limit: 1 req/min
    const limitedMw = rateLimitMiddleware({ anonymousRateLimit: 1, now: () => now });
    const reqIp1 = { ip: '10.0.0.1' } as Request;
    const reqIp2 = { ip: '10.0.0.2' } as Request;

    let ip1First = false;
    limitedMw(reqIp1, makeMockRes(ANONYMOUS_CALLER).res, () => {
      ip1First = true;
    });
    assert.equal(ip1First, true);

    const ip1Second = makeMockRes(ANONYMOUS_CALLER);
    let ip1SecondNext = false;
    limitedMw(reqIp1, ip1Second.res, () => {
      ip1SecondNext = true;
    });
    assert.equal(ip1SecondNext, false);
    assert.equal(ip1Second.statusCode, 429);

    // Different IP still gets its own bucket.
    let ip2First = false;
    limitedMw(reqIp2, makeMockRes(ANONYMOUS_CALLER).res, () => {
      ip2First = true;
    });
    assert.equal(ip2First, true);
  });
});
