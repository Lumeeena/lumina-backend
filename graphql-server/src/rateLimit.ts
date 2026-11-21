/**
 * Per-key rate limiting using a token bucket algorithm.
 *
 * State lives in process memory: in a multi-replica deployment each replica
 * enforces its own budget independently. See `docs/AUTHENTICATION.md`.
 */
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { callerFromLocals, type ApiCaller } from './auth';
import { ERROR_CODES } from './errorCodes';
import { subsystem } from './logger';

const log = subsystem('rate-limit');

/**
 * Rate limit state stored in-memory per process.
 * For shared cross-replica limits, back these buckets with Redis.
 */
interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

export interface RateLimitOptions {
  /** Override wall-clock timestamp in milliseconds (primarily for tests). */
  now?: number;
  /** Override bucket key (used to scope anonymous callers per IP). */
  bucketKey?: string;
  /** Fallback requests/min when `caller.rateLimit` is null (e.g., anonymous tier). */
  fallbackLimit?: number | null;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Effective requests-per-minute budget, or null when unthrottled. */
  limit: number | null;
  /** Remaining whole tokens immediately available, or null when unthrottled. */
  remaining: number | null;
  /** Unix timestamp (seconds) when the bucket will be completely full, or null. */
  resetUnixSeconds: number | null;
  /** Seconds to wait before the next request can succeed (0 when allowed). */
  retryAfterSeconds: number;
}

function resolveBucketKey(caller: ApiCaller, explicitKey?: string): string {
  if (explicitKey) return explicitKey;
  return caller.keyId !== null ? `key:${caller.keyId}` : 'anonymous';
}

/**
 * Parse `ANONYMOUS_RATE_LIMIT` (requests per minute).
 *
 * Unset, empty, `0`, or `unlimited` disables anonymous throttling so existing
 * unauthenticated clients remain unaffected until an operator opts in.
 */
export function parseAnonymousRateLimit(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === '0' || trimmed === 'unlimited') return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.warn({ configured: raw }, 'invalid ANONYMOUS_RATE_LIMIT; leaving anonymous callers unthrottled');
    return null;
  }
  return parsed;
}

/** Clear all in-memory token buckets (intended for unit tests). */
export function resetRateLimitBuckets(): void {
  buckets.clear();
}

/**
 * Evaluate and consume one token from the caller's bucket, returning full
 * header and retry metadata alongside the allow/reject decision.
 */
export function evaluateRateLimit(
  caller: ApiCaller,
  options: RateLimitOptions = {}
): RateLimitDecision {
  const effectiveLimit = caller.rateLimit ?? options.fallbackLimit ?? null;
  if (effectiveLimit === null) {
    return {
      allowed: true,
      limit: null,
      remaining: null,
      resetUnixSeconds: null,
      retryAfterSeconds: 0,
    };
  }

  const now = options.now ?? Date.now();
  if (effectiveLimit <= 0) {
    return {
      allowed: false,
      limit: 0,
      remaining: 0,
      resetUnixSeconds: Math.ceil(now / 1000) + 60,
      retryAfterSeconds: 60,
    };
  }

  const key = resolveBucketKey(caller, options.bucketKey);
  const refillRate = effectiveLimit / 60; // tokens per second

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: effectiveLimit, lastRefill: now };
    buckets.set(key, bucket);
  }

  // Refill tokens proportionally to elapsed time (guarding against backwards clock steps).
  const elapsed = Math.max(0, (now - bucket.lastRefill) / 1000);
  bucket.tokens = Math.min(effectiveLimit, bucket.tokens + elapsed * refillRate);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterSeconds = Math.max(1, Math.ceil(tokensNeeded / refillRate));
    const resetUnixSeconds = Math.ceil(now / 1000 + (effectiveLimit - bucket.tokens) / refillRate);
    log.warn(
      { caller: caller.label, keyId: caller.keyId, limit: effectiveLimit, retryAfterSeconds },
      'Rate limit exceeded'
    );
    return {
      allowed: false,
      limit: effectiveLimit,
      remaining: 0,
      resetUnixSeconds,
      retryAfterSeconds,
    };
  }

  bucket.tokens -= 1;
  const remaining = Math.max(0, Math.floor(bucket.tokens));
  const resetUnixSeconds = Math.ceil(now / 1000 + (effectiveLimit - bucket.tokens) / refillRate);
  return {
    allowed: true,
    limit: effectiveLimit,
    remaining,
    resetUnixSeconds,
    retryAfterSeconds: 0,
  };
}

/**
 * Check if a request is allowed under the rate limit.
 * Returns true if allowed, false if rate limited.
 */
export function checkRateLimit(caller: ApiCaller, options: RateLimitOptions = {}): boolean {
  return evaluateRateLimit(caller, options).allowed;
}

/**
 * Calculate seconds until next token is available.
 */
export function retryAfter(caller: ApiCaller, options: RateLimitOptions = {}): number {
  const effectiveLimit = caller.rateLimit ?? options.fallbackLimit ?? null;
  if (effectiveLimit === null) return 0;
  if (effectiveLimit <= 0) return 60;

  const key = resolveBucketKey(caller, options.bucketKey);
  const bucket = buckets.get(key);
  if (!bucket) return 0;

  const now = options.now ?? Date.now();
  const refillRate = effectiveLimit / 60;
  const elapsed = Math.max(0, (now - bucket.lastRefill) / 1000);
  const currentTokens = Math.min(effectiveLimit, bucket.tokens + elapsed * refillRate);

  const tokensNeeded = 1 - currentTokens;
  if (tokensNeeded <= 0) return 0;

  return Math.max(1, Math.ceil(tokensNeeded / refillRate));
}

export interface RateLimitMiddlewareOptions {
  /** Optional requests/min budget applied per client IP to anonymous callers. */
  anonymousRateLimit?: number | null;
  /** Override clock source (for tests). */
  now?: () => number;
}

/**
 * Express middleware that enforces the caller's per-key rate limit (and
 * optional per-IP anonymous rate limit) immediately after `apiKeyAuthMiddleware`.
 *
 * Sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`
 * headers on throttled and allowed responses whenever a limit applies, and
 * rejects over-limit requests with HTTP 429, `Retry-After`, and `RATE_LIMITED`.
 */
export function rateLimitMiddleware(options: RateLimitMiddlewareOptions = {}): RequestHandler {
  const anonymousLimit = options.anonymousRateLimit ?? null;
  const clock = options.now ?? Date.now;

  return (req, res, next) => {
    const caller = callerFromLocals(res.locals);
    if (!caller) {
      next();
      return;
    }

    const bucketKey =
      caller.kind === 'anonymous'
        ? `anon:${req.ip || req.socket?.remoteAddress || 'anonymous'}`
        : undefined;

    const decision = evaluateRateLimit(caller, {
      now: clock(),
      bucketKey,
      fallbackLimit: caller.kind === 'anonymous' ? anonymousLimit : null,
    });

    if (decision.limit !== null) {
      res.set('X-RateLimit-Limit', String(decision.limit));
      res.set('X-RateLimit-Remaining', String(decision.remaining ?? 0));
      if (decision.resetUnixSeconds !== null) {
        res.set('X-RateLimit-Reset', String(decision.resetUnixSeconds));
      }
    }

    if (!decision.allowed) {
      res.set('Retry-After', String(decision.retryAfterSeconds));
      res.status(429).json({
        errors: [
          {
            message: `Rate limit exceeded: ${decision.limit} requests per minute. Retry after ${decision.retryAfterSeconds} seconds.`,
            extensions: {
              code: ERROR_CODES.RATE_LIMITED,
              limit: decision.limit,
              retryAfter: decision.retryAfterSeconds,
            },
          },
        ],
      });
      return;
    }

    next();
  };
}

/**
 * Record API usage for analytics.
 */
export async function recordUsage(
  pool: Pool,
  caller: ApiCaller,
  operationName: string | null,
  responseTimeMs: number
): Promise<void> {
  if (caller.keyId === null) return; // Don't track anonymous

  try {
    await pool.query(
      `INSERT INTO api_usage (key_id, operation_name, response_time_ms, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [caller.keyId, operationName || 'unknown', responseTimeMs]
    );
  } catch (err) {
    log.error({ err, keyId: caller.keyId }, 'Failed to record usage');
  }
}

/**
 * Get usage stats for a caller.
 */
export async function getUsageStats(
  pool: Pool,
  keyId: number,
  hours = 24
): Promise<{ requests: number; avgResponseTime: number }> {
  const result = await pool.query(
    `SELECT COUNT(*) as requests, AVG(response_time_ms) as avg_response_time
     FROM api_usage
     WHERE key_id = $1 AND created_at > NOW() - INTERVAL '${hours} hours'`,
    [keyId]
  );

  return {
    requests: parseInt(result.rows[0]?.requests || '0'),
    avgResponseTime: parseFloat(result.rows[0]?.avg_response_time || '0')
  };
}
