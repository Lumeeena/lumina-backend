/**
 * Small per-network cache for latest-ledger reads.
 * Generation tokens prevent a stale asynchronous result from repopulating the
 * cache after a ledger notification invalidates it.
 */
import { latestLedgerCacheInvalidations, latestLedgerCacheRequests } from './metrics';

interface CacheEntry {
  value: unknown;
  cachedAt: number;
}

/**
 * Creates an isolated cache with TTL and generation-checked writes for tests
 * and for the process-wide instance below.
 */
export function createLatestLedgerCache(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, CacheEntry>();
  const generations = new Map<string, number>();

  return {
    get<T>(network: string): T | undefined {
      const entry = entries.get(network);
      if (!entry) {
        latestLedgerCacheRequests.inc({ result: 'miss' });
        return undefined;
      }
      if (now() - entry.cachedAt >= ttlMs) {
        entries.delete(network);
        latestLedgerCacheInvalidations.inc({ network, reason: 'ttl_expired' });
        latestLedgerCacheRequests.inc({ result: 'miss' });
        return undefined;
      }
      latestLedgerCacheRequests.inc({ result: 'hit' });
      return entry.value as T;
    },

    set<T>(network: string, value: T): void {
      entries.set(network, { value, cachedAt: now() });
    },

    generation(network: string): number {
      return generations.get(network) ?? 0;
    },

    setIfGeneration<T>(network: string, generation: number, value: T): boolean {
      if ((generations.get(network) ?? 0) !== generation) return false;
      entries.set(network, { value, cachedAt: now() });
      return true;
    },

    invalidate(network?: string, reason = 'ledger_notification'): number {
      const networks = network === undefined
        ? [...new Set([...entries.keys(), ...generations.keys()])]
        : [network];
      let invalidated = 0;
      for (const cachedNetwork of networks) {
        invalidated += Number(entries.delete(cachedNetwork));
        generations.set(cachedNetwork, (generations.get(cachedNetwork) ?? 0) + 1);
        latestLedgerCacheInvalidations.inc({ network: cachedNetwork, reason });
      }
      return invalidated;
    },
  };
}

// Four seconds avoids repeated reads during bursts while keeping new ledgers visible promptly.
const latestLedgerCacheTtlMs = parseInt(process.env['LATEST_LEDGER_CACHE_TTL_MS'] ?? '4000', 10);
/** Process-wide latest-ledger cache, partitioned by network. */
export const latestLedgerCache = createLatestLedgerCache(latestLedgerCacheTtlMs);
