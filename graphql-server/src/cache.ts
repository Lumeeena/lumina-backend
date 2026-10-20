/**
 * Redis caching layer for hot queries (#233).
 *
 * Optional cache in front of `latestLedger`, network statistics and order book
 * snapshots. Degrades to direct queries when Redis is unavailable.
 */

import { createClient, RedisClientType } from "redis";
import { logger } from "./logger.js";

// Per-query TTLs (in seconds) with documented rationale:
// - latestLedger: 2s — ledger close is ~5-6s; 2s keeps data fresh without
//   hammering the DB every request
// - networkStats: 10s — statistics aggregate over time windows and change slowly
// - orderBookSnapshot: 5s — order books change with each trade but a 5s window
//   is acceptable for display purposes
const CACHE_TTLS = {
  latestLedger: 2,
  networkStats: 10,
  orderBookSnapshot: 5,
} as const;

let redisClient: RedisClientType | null = null;
let isAvailable = false;

export async function initCache(redisUrl?: string): Promise<void> {
  if (!redisUrl) {
    logger.info("Redis cache disabled: no REDIS_URL provided");
    return;
  }

  try {
    redisClient = createClient({ url: redisUrl }) as RedisClientType;
    redisClient.on("error", (err) => {
      logger.warn("Redis cache error, degrading to direct queries", { error: err.message });
      isAvailable = false;
    });
    redisClient.on("ready", () => {
      logger.info("Redis cache ready");
      isAvailable = true;
    });

    await redisClient.connect();
    isAvailable = true;
    logger.info("Redis cache connected");
  } catch (err) {
    logger.warn("Redis cache unavailable, degrading to direct queries", {
      error: (err as Error).message,
    });
    isAvailable = false;
    redisClient = null;
  }
}

export async function closeCache(): Promise<void> {
  if (redisClient) {
    await redisClient.disconnect();
    redisClient = null;
    isAvailable = false;
  }
}

/**
 * Get a cached value. Returns null if not cached or cache unavailable.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!isAvailable || !redisClient) return null;

  try {
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    isAvailable = false;
    return null;
  }
}

/**
 * Set a cached value with a TTL. No-op if cache unavailable.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!isAvailable || !redisClient) return;

  try {
    await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
  } catch {
    isAvailable = false;
  }
}

/**
 * Execute a function with caching. If the cache is warm, returns the cached
 * value. Otherwise executes the function and caches the result.
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;

  const result = await fn();
  await cacheSet(key, result, ttlSeconds);
  return result;
}

export { CACHE_TTLS };
