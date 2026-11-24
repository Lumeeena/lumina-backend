/**
 * Per-request batching for the GraphQL resolvers. Each loader collects the keys
 * requested in one tick of the event loop and answers them with one database
 * query, so a document that asks for ten accounts does not run ten queries.
 *
 * The account loader is the one that can leave the database: an address the
 * indexer has not recorded falls back to Horizon, and that fallback is bounded
 * (see `withAccountFallbackBudget`) and remembers misses (see
 * `NEGATIVE_ACCOUNT_TTL_MS`).
 */
import DataLoader from 'dataloader';
import type { Pool } from 'pg';
import {
  getAccountsFromDb,
  getLedgersBySequences,
  getOperationsByTransactionHashes,
  getTransactionsByHashes,
  mapAccount,
} from './db';
import { getAccount as getAccountFromHorizon } from './horizon';
import type { NetworkConfig } from './networks';
import { horizonAccountFallbacks } from './metrics';

/**
 * Most Horizon account lookups allowed in flight at once, across every request
 * in this process. A burst of account fields in many requests then queues
 * instead of opening that many connections to Horizon at the same time. The
 * README documents the value; the source does not record why 4 was chosen.
 */
const ACCOUNT_FALLBACK_CONCURRENCY = 4;

/**
 * How long, in milliseconds, a Horizon miss for an address is remembered. While
 * the entry is fresh, a repeat lookup returns `null` without calling Horizon.
 * The trade-off: an account created on Horizon can read as missing for up to
 * this long after its first miss, while a client repeatedly asking for an
 * address that does not exist costs Horizon one call per window instead of one
 * per request. The README documents the value; the source does not record why
 * 30 seconds was chosen.
 */
const NEGATIVE_ACCOUNT_TTL_MS = 30_000;

/** Lookups currently running against Horizon, process-wide. */
let activeAccountFallbacks = 0;

/**
 * Lookups waiting for a free slot, oldest first. Finishing a lookup wakes the
 * head of this queue, so waiters are served in arrival order.
 */
const queuedAccountFallbacks: Array<() => void> = [];

/**
 * Horizon misses keyed by `horizonUrl:address`, holding the time each was seen.
 * Entries are only removed when read after they expire, so a miss for an address
 * nobody asks for again stays in memory until the process restarts. That is
 * bounded by the number of distinct missing addresses requested.
 */
const negativeAccountCache = new Map<string, number>();

/**
 * Runs one Horizon lookup inside the process-wide concurrency budget. When
 * `ACCOUNT_FALLBACK_CONCURRENCY` lookups are already running, the call waits in
 * `queuedAccountFallbacks` until one of them finishes. The slot is released in
 * `finally`, so a failed lookup still frees it.
 */
async function withAccountFallbackBudget<T>(work: () => Promise<T>): Promise<T> {
  if (activeAccountFallbacks >= ACCOUNT_FALLBACK_CONCURRENCY) {
    await new Promise<void>(resolve => queuedAccountFallbacks.push(resolve));
  }
  activeAccountFallbacks++;
  try {
    return await work();
  } finally {
    activeAccountFallbacks--;
    queuedAccountFallbacks.shift()?.();
  }
}

/**
 * The four loaders for one network. Returned by `createLoaders`; each `load`
 * resolves to one row, or `null` (or `[]` for operations) when the key has no
 * row on that network.
 */
export interface RequestLoaders {
  /** Keyed by address. Falls back to Horizon when the indexer has no row. */
  account: DataLoader<string, ReturnType<typeof mapAccount> | null>;
  /** Keyed by ledger sequence. */
  ledger: DataLoader<number, Awaited<ReturnType<typeof getLedgersBySequences>> extends Map<number, infer T> ? T | null : never>;
  /** Keyed by transaction hash. */
  transaction: DataLoader<string, Awaited<ReturnType<typeof getTransactionsByHashes>> extends Map<string, infer T> ? T | null : never>;
  /** Keyed by transaction hash. Returns every operation in that transaction, in order. */
  operationsByTransactionHash: DataLoader<string, Awaited<ReturnType<typeof getOperationsByTransactionHashes>> extends Map<string, infer T> ? T : never>;
}

/**
 * Loaders for one network.
 *
 * The batch functions are keyed by database column, and a key means something
 * different per network — the same ledger sequence, transaction hash or account
 * address exists on each chain — so a single loader instance cannot serve two
 * of them. The context keeps one instance per network and memoises it there,
 * which is what stops two fields in one document from sharing batches.
 */
export function createLoaders(pool: Pool, network: NetworkConfig): RequestLoaders {
  return {
    account: new DataLoader(async addresses => {
      const rows = await getAccountsFromDb(pool, network.name, addresses);
      return Promise.all(addresses.map(async address => {
        const fromDb = rows.get(address);
        if (fromDb) return fromDb;

        const cacheKey = `${network.horizonUrl}:${address}`;
        const cachedMissingAt = negativeAccountCache.get(cacheKey);
        if (cachedMissingAt && Date.now() - cachedMissingAt < NEGATIVE_ACCOUNT_TTL_MS) {
          horizonAccountFallbacks.inc({ result: 'negative_cache' });
          return null;
        }
        if (cachedMissingAt) negativeAccountCache.delete(cacheKey);

        const horizonAccount = await withAccountFallbackBudget(() => getAccountFromHorizon(address, network.horizonUrl));
        horizonAccountFallbacks.inc({ result: horizonAccount ? 'hit' : 'miss' });
        if (!horizonAccount) {
          negativeAccountCache.set(cacheKey, Date.now());
          return null;
        }
        return mapAccount({
          network: network.name,
          address: horizonAccount.account_id,
          sequence: horizonAccount.sequence,
          subentry_count: horizonAccount.subentry_count,
          last_modified_ledger: horizonAccount.last_modified_ledger,
          num_sponsored: horizonAccount.num_sponsored,
          num_sponsoring: horizonAccount.num_sponsoring,
          balances: horizonAccount.balances,
          flags: horizonAccount.flags,
          thresholds: horizonAccount.thresholds,
        });
      }));
    }),
    ledger: new DataLoader(async sequences => {
      const rows = await getLedgersBySequences(pool, network.name, sequences);
      return sequences.map(sequence => rows.get(sequence) ?? null);
    }),
    transaction: new DataLoader(async hashes => {
      const rows = await getTransactionsByHashes(pool, network.name, hashes);
      return hashes.map(hash => rows.get(hash) ?? null);
    }),
    operationsByTransactionHash: new DataLoader(async hashes => {
      const rows = await getOperationsByTransactionHashes(pool, network.name, hashes);
      return hashes.map(hash => rows.get(hash) ?? []);
    }),
  };
}
