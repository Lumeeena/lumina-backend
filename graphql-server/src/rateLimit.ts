/**
 * Per-key rate limiting using token bucket algorithm.
 * Issue #8: API key auth + per-key rate limiting
 */
import type { Pool } from 'pg';
import type { ApiCaller } from './auth';
import { subsystem } from './logger';

const log = subsystem('rate-limit');

/**
 * Rate limit state stored in-memory.
 * For production, consider Redis for multi-instance deployments.
 */
interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

/**
 * Check if a request is allowed under the rate limit.
 * Returns true if allowed, false if rate limited.
 */
export function checkRateLimit(caller: ApiCaller): boolean {
  if (caller.rateLimit === null) {
    // Unlimited access (e.g., admin keys)
    return true;
  }

  const key = caller.keyId?.toString() ?? 'anonymous';
  const now = Date.now();
  const refillRate = caller.rateLimit / 60; // tokens per second
  
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: caller.rateLimit, lastRefill: now };
    buckets.set(key, bucket);
  }

  // Refill tokens based on time elapsed
  const elapsed = (now - bucket.lastRefill) / 1000; // seconds
  bucket.tokens = Math.min(
    caller.rateLimit,
    bucket.tokens + elapsed * refillRate
  );
  bucket.lastRefill = now;

  // Check if we have tokens available
  if (bucket.tokens < 1) {
    log.warn({ caller: caller.label, keyId: caller.keyId }, 'Rate limit exceeded');
    return false;
  }

  // Consume one token
  bucket.tokens -= 1;
  return true;
}

/**
 * Calculate seconds until next token is available.
 */
export function retryAfter(caller: ApiCaller): number {
  if (caller.rateLimit === null) return 0;
  
  const key = caller.keyId?.toString() ?? 'anonymous';
  const bucket = buckets.get(key);
  if (!bucket) return 0;

  const tokensNeeded = 1 - bucket.tokens;
  if (tokensNeeded <= 0) return 0;

  const refillRate = caller.rateLimit / 60; // tokens per second
  return Math.ceil(tokensNeeded / refillRate);
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
