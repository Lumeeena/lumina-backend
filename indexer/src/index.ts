/**
 * Lumina Indexer
 *
 * Polls Stellar Horizon for new ledgers and writes transactions and
 * operations to the PostgreSQL database defined in db/schema.sql.
 *
 * Architecture:
 *   Horizon API → Indexer → PostgreSQL ← GraphQL Server ← Frontend / API Consumers
 *
 * One polling loop runs per configured network, in the same process: each has
 * its own cursor, its own Horizon tip and its own account cache, and stamps
 * every row it writes with its own `network`. See networks.ts for how the
 * networks are declared and db.ts for why every write is keyed by them.
 *
 * Environment variables:
 *   NETWORKS              — Comma-separated networks to index (default: one network built from the flat variables)
 *   <NAME>_HORIZON_URL      — Horizon base URL for that network (required for every name in NETWORKS)
 *   <NAME>_SOROBAN_RPC_URL  — Soroban RPC endpoint; unset disables contract event indexing for that network
 *   <NAME>_NETWORK_PASSPHRASE — Network passphrase (defaults per network name)
 *   <NAME>_INDEXED_CONTRACT_IDS — Overrides INDEXED_CONTRACT_IDS for that network
 *   PRIMARY_NETWORK       — Which declared network is primary (default: the first one declared)
 *   HORIZON_URL           — Single-network deployments: the one Horizon base URL (default: mainnet)
 *   SOROBAN_RPC_URL       — Single-network deployments: Soroban RPC endpoint; unset disables contract event indexing
 *   DATABASE_URL          — PostgreSQL connection string
 *   START_LEDGER          — Ledger to begin indexing from if a network's DB is empty (default: that network's latest)
 *   POLL_INTERVAL_MS      — How often to poll for new ledgers (default: 5000)
 *   LEDGER_RETRY_ATTEMPTS — Attempts per failing ledger before the cursor stops at it (default: 3)
 *   LEDGER_RETRY_BASE_MS  — Base retry delay in ms, doubled each attempt (default: 500)
 *   INDEXED_CONTRACT_IDS  — Comma-separated contract IDs to index events for (requires a Soroban RPC URL)
 *   REGISTRY_CONTRACT_ID  — Lumina Registry contract to poll for additional contract IDs (primary network only; requires a Soroban RPC URL + REGISTRY_READ_ACCOUNT)
 *   REGISTRY_READ_ACCOUNT — Any funded account address used to simulate the registry's read calls (no secret key needed)
 *   REGISTRY_NETWORK_PASSPHRASE — Network passphrase for registry simulation (default: the primary network's passphrase)
 */

import {
  createPool,
  getAccountsNeedingRefresh,
  getLatestIndexedEventLedger,
  getLatestIndexedLedger,
  getTrackedContractStorageKeys,
  indexLedger,
  insertContractEvents,
  insertCustomEvents,
  loadContractSchemas,
  markContractStorageEntriesArchived,
  upsertContractStorageEntries,
  enqueueLedgerRetry,
} from './db';
import { decodeEvents } from './customDecode';
import { loadConfig } from './config';
import { routineLogger, subsystem } from './logger';
import { RetryWorker } from './retryWorker';
import { refreshAccountQueueBatch } from './accountRefresh';
import {
  contractEventsIndexed,
  customEventsDecoded,
  indexingErrors,
  ledgerIndexDuration,
  recordHorizonTip,
  recordIndexedLedger,
  accountCacheSize,
  sorobanEventsTruncated,
  contractsWatched,
  sorobanRetentionWindowExceeded,
} from './metrics';
import {
  aggregateNetworkStates,
  buildDebugConfiguration,
  startHealthServer,
  type NetworkState,
} from './health';
import { initTracing, shutdownTracing } from './tracing';
import {
  isRetentionEnabled,
  pruneExpiredData,
  retainedTables,
  sleep,
  type RetentionReport,
} from './retention';
import { initErrorTracking, captureException, shutdownErrorTracking } from './errorTracking';
import { getRetentionInfo, getContractStorageEntries } from './soroban';
import { getLatestLedgerSequence, getLedger, getLedgerOperations, getLedgerTransactions, initializeHorizonClient } from './horizon';
import type { RequestPurpose } from './throttle';
import { getActiveContracts } from './registry';
import { getEvents, getLatestLedgerSequence as getLatestRpcLedgerSequence, type ContractEvent } from './soroban';
import { resolveNetworks, type NetworkConfig } from './networks';

// Read version from package.json for logging
import { readFileSync } from 'fs';
import { join } from 'path';
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
const VERSION = packageJson.version;

const log = subsystem('indexer');

// Routine success goes through `routine`, which samples (LOG_SAMPLE_RATE) and
// carries a `suppressed` count on every emitted line. Warnings and errors stay on
// `log`, which is never sampled.
const routine = routineLogger('indexer');

// Parsed and validated once at startup; exported values are environment-driven.
const config = loadConfig();

const HEALTH_PORT = parseInt(process.env['HEALTH_PORT'] ?? '9090', 10);

const DATABASE_URL = config.databaseUrl;
const POLL_INTERVAL_MS = config.pollIntervalMs;
const START_LEDGER = config.startLedger;
const DB_POOL_MAX = config.dbPoolMax;
const DB_POOL_IDLE_TIMEOUT = config.dbPoolIdleTimeoutMs;
const DB_POOL_CONNECTION_TIMEOUT = config.dbPoolConnectionTimeoutMs;

// Soroban contract event indexing is opt-in — unset by default, the indexer
// behaves exactly as it did before these were introduced. The RPC endpoint
// itself is per network (see networks.ts); the contract list is shared unless
// a network overrides it with <NAME>_INDEXED_CONTRACT_IDS, because the same
// deployment usually indexes different contract ids on each chain.
const INDEXED_CONTRACT_IDS = config.indexedContractIds;

// Registry-based discovery is opt-in on top of the opt-in event indexing above —
// unset, the indexer relies solely on the static INDEXED_CONTRACT_IDS list.
// One Registry contract lives on one chain, so discovery runs on the primary
// network only; the contracts it finds are indexed alongside that network's
// static list.
const REGISTRY_CONTRACT_ID = config.registryContractId;
const REGISTRY_READ_ACCOUNT = config.registryReadAccount;
const REGISTRY_NETWORK_PASSPHRASE = config.registryNetworkPassphrase;
const REGISTRY_POLL_EVERY_N_TICKS = Math.max(1, Math.round(config.registryPollIntervalMs / POLL_INTERVAL_MS));

// How long an account's Horizon data is considered fresh enough to skip
// re-fetching. Busy accounts (exchanges, bots) show up in most ledgers —
// without this, the indexer re-fetches the same accounts every ~5s and
// floods Horizon's per-IP rate limit, which then also breaks the GraphQL
// server's own account lookups sharing that limit. Kept per network: the
// account sequence on mainnet says nothing about the same address on testnet.
const ACCOUNT_CACHE_TTL_MS = config.accountCacheTtlMs;
const ACCOUNT_CACHE_MAX_SIZE = config.accountCacheMaxSize;

// getEvents' reported latestLedger is the RPC's chain-tip awareness, not a
// guarantee that ledger's events have finished being indexed internally —
// confirmed live: an event was missing from a response whose latestLedger
// was already past it, then present moments later at the same startLedger.
// Advancing the cursor straight to latestLedger + 1 can permanently skip
// events landing right at that boundary. Re-scanning the last few ledgers
// each poll is cheap and idempotent (insertContractEvents is ON CONFLICT
// DO NOTHING), so hold the cursor back by a small margin instead.
const EVENTS_SAFETY_LAG_LEDGERS = config.eventsSafetyLagLedgers;

// Maximum events to fetch per polling cycle to prevent one busy range from stalling the loop.
const MAX_EVENTS_PER_CYCLE = config.sorobanMaxEventsPerCycle;

// RPC ledger retention window — how far back the RPC can serve events.
const RETENTION_WINDOW_LEDGERS = config.sorobanRetentionWindowLedgers;

const RETENTION_WINDOWS = config.retentionWindows;
const RETENTION_PRUNE_INTERVAL_MS = config.retentionPruneIntervalMs;
const RETENTION_PRUNE_BATCH_SIZE = config.retentionPruneBatchSize;

const pool = createPool(DATABASE_URL, {
  max: DB_POOL_MAX,
  idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT,
  connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT,
});

let isShuttingDown = false;
let isLoopRunning = false;

/**
 * Everything one network's loop owns.
 *
 * Nothing here is shared with another network's loop: cursors, tips and
 * caches are per chain, and two chains sharing any of them would resume one
 * network's ledger numbering from the other's.
 */
interface NetworkLoop {
  network: NetworkConfig;
  /** Soroban RPC endpoint for this network; unset disables contract events. */
  sorobanRpcUrl: string | undefined;
  /** Contract ids to index events for: the global list, or this network's override. */
  staticContractIds: string[];
  /** Registry discovery runs on the primary network only — one Registry, one chain. */
  registryEnabled: boolean;
  state: NetworkState;
  cursor: number;
  eventsCursor: number;
  loopTick: number;
  discoveredContractIds: string[];
  accountCache: Map<string, number>;
  accountCacheOrder: string[];
  retryWorker?: RetryWorker;
  /**
   * The in-flight account-refresh batch, if one is running.
   *
   * Held so the queue is drained by one batch at a time: each poll tick calls
   * scheduleAccountRefreshes, and without this a backlog would fan out into
   * concurrent batches racing each other for the same rows.
   */
  accountRefreshTask: Promise<void> | null;
}

function createLoop(network: NetworkConfig, primaryName: string): NetworkLoop {
  const override = process.env[`${network.name.toUpperCase()}_INDEXED_CONTRACT_IDS`];
  return {
    network,
    sorobanRpcUrl: network.sorobanRpcUrl,
    staticContractIds:
      override === undefined
        ? INDEXED_CONTRACT_IDS
        : override
            .split(',')
            .map(id => id.trim())
            .filter(Boolean),
    registryEnabled: network.name === primaryName,
    state: {
      network: network.name,
      latestIndexedLedger: 0,
      latestHorizonLedger: 0,
      lastIndexedAt: null,
    },
    cursor: 0,
    eventsCursor: 0,
    loopTick: 0,
    discoveredContractIds: [],
    accountCache: new Map<string, number>(),
    accountCacheOrder: [],
    accountRefreshTask: null,
  };
}

function pruneAccountCache(cache: Map<string, number>, order: string[], now: number): void {
  // First, remove expired entries
  for (const [address, fetchedAt] of cache) {
    if (now - fetchedAt > ACCOUNT_CACHE_TTL_MS) {
      cache.delete(address);
    }
  }
  // Rebuild order array to only contain valid entries
  const validOrder = order.filter(address => cache.has(address));
  order.length = 0;
  order.push(...validOrder);

  // Then, if still over size, evict LRU entries
  while (cache.size > ACCOUNT_CACHE_MAX_SIZE && order.length > 0) {
    const lruAddress = order.shift();
    if (lruAddress) cache.delete(lruAddress);
  }
}

async function fetchAndIndexLedger(loop: NetworkLoop, sequence: number): Promise<void> {
  const name = loop.network.name;
  log.debug({ network: name, ledger: sequence }, 'indexing ledger');
  
  const isBackfill = loop.state.latestHorizonLedger - sequence > 10;
  const purpose: RequestPurpose = isBackfill ? 'backfill' : 'tip';
  
  const [ledger, transactions, operations] = await Promise.all([
    getLedger(loop.network.horizonUrl, sequence, purpose),
    getLedgerTransactions(loop.network.horizonUrl, sequence, purpose),
    getLedgerOperations(loop.network.horizonUrl, sequence, purpose),
  ]);

  const addresses = new Set<string>();
  for (const tx of transactions) addresses.add(tx.source_account);
  for (const op of operations) addresses.add(op.source_account);

  const now = Date.now();
  pruneAccountCache(loop.accountCache, loop.accountCacheOrder, now);
  const expiredAddresses = [...addresses].filter(address => {
    const fetchedAt = loop.accountCache.get(address);
    return fetchedAt === undefined || now - fetchedAt > ACCOUNT_CACHE_TTL_MS;
  });
  const addressesToFetch = await getAccountsNeedingRefresh(pool, name, expiredAddresses, sequence);
  const stopTimer = ledgerIndexDuration.startTimer();
  await indexLedger(pool, name, ledger, transactions, operations, addressesToFetch);
  stopTimer();

  for (const address of expiredAddresses) {
    loop.accountCache.set(address, now);
    // Update LRU order: remove if exists, then add to end (most recent)
    const idx = loop.accountCacheOrder.indexOf(address);
    if (idx !== -1) loop.accountCacheOrder.splice(idx, 1);
    loop.accountCacheOrder.push(address);
  }
  accountCacheSize.set({ network: name }, loop.accountCache.size);
  scheduleAccountRefreshes(loop);

  loop.state.latestIndexedLedger = sequence;
  loop.state.lastIndexedAt = Date.now();
  recordIndexedLedger(name, sequence, transactions.length, operations.length);
  routine.success(
    { network: name, ledger: sequence, transactions: transactions.length, operations: operations.length },
    'ledger indexed'
  );
}

/** Records a ledger that exhausted its retries for the durable retry worker to pick up. */
export type EnqueueLedgerRetry = (
  network: string,
  sequence: number,
  error: string
) => Promise<void>;

export async function fetchAndIndexLedgerWithRetry(
  network: string,
  sequence: number,
  indexOne: (sequence: number) => Promise<void>,
  retryAttempts?: number,
  retryBaseMs?: number,
  // Injected rather than called directly so the retry path is testable without
  // a database — this function used to reach for the module pool on exhaustion,
  // which made "did it give up correctly" untestable without Postgres. Same
  // shape as accountRefresh's injected fetchAccount.
  enqueueRetry: EnqueueLedgerRetry = (net, seq, err) => enqueueLedgerRetry(pool, net, seq, err)
): Promise<boolean> {
  const actualRetryAttempts = retryAttempts ?? config.ledgerRetryAttempts;
  const actualRetryBaseMs = retryBaseMs ?? config.ledgerRetryBaseMs;
  for (let attempt = 1; attempt <= actualRetryAttempts; attempt++) {
    try {
      await indexOne(sequence);
      return true;
    } catch (err) {
      if (attempt === actualRetryAttempts) {
        indexingErrors.inc({ loop: 'ledger' });
        const errorMsg = message(err);
        log.error({ network, ledger: sequence, attempts: attempt, err: errorMsg }, 'giving up on ledger; enqueueing for durable retry');
        // Deliberately allowed to throw: if the retry cannot be recorded the
        // ledger is unindexed and unrecorded, and letting the error propagate
        // is what keeps the cursor from advancing past it.
        await enqueueRetry(network, sequence, errorMsg);
        return false;
      }
      const delay = actualRetryBaseMs * 2 ** (attempt - 1);
      log.warn(
        { network, ledger: sequence, attempt, maxAttempts: actualRetryAttempts, retryInMs: delay, err: message(err) },
        'ledger failed, retrying'
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return false;
}

export async function runLedgerCatchUp(
  cursor: number,
  latest: number,
  indexOne: (sequence: number) => Promise<boolean>,
  onAdvanced: (cursor: number) => void = () => {}
): Promise<number> {
  for (let seq = cursor + 1; seq <= latest; seq++) {
    if (isShuttingDown) break;
    const indexed = await indexOne(seq);
    if (!indexed) break;
    cursor = seq;
    onAdvanced(cursor);
  }
  return cursor;
}

/**
 * Run one task per item, concurrently, and wait for every one of them.
 *
 * Each task is isolated: one that rejects is logged and the rest keep running.
 * `Promise.all` would still let the other loops run, but it rejects the wait as
 * a whole, so a single misbehaving chain would take the process down with it —
 * the exact opposite of what per-network isolation is for. The wait therefore
 * always resolves, and the only thing that ends the process is shutdown.
 */
export async function runIndependently<T>(
  items: T[],
  run: (item: T) => Promise<void>,
  describe: (item: T) => string = () => 'task'
): Promise<void> {
  await Promise.all(items.map(item =>
    run(item).catch((err: unknown) => {
      indexingErrors.inc({ loop: 'network' });
      log.error({ task: describe(item), err: message(err) }, 'loop exited with an error; the others keep running');
    })
  ));
}

/**
 * The registry's contract_id field is just an Address — nothing stops a
 * registrant from passing a G... account instead of a real C... contract
 * (we hit exactly this with our own test data). A single bad entry would
 * otherwise make the whole getEvents filter error out, breaking event
 * indexing for every other registered contract too.
 */
function isContractAddress(address: string): boolean {
  return /^C[A-Z0-9]{55}$/.test(address);
}

/** Refreshes the set of contract IDs discovered from the Lumina Registry, if configured. */
async function pollRegistry(loop: NetworkLoop): Promise<void> {
  if (!loop.registryEnabled || !loop.sorobanRpcUrl || !REGISTRY_CONTRACT_ID || !REGISTRY_READ_ACCOUNT) return;
  try {
    const entries = await getActiveContracts(
      loop.sorobanRpcUrl,
      REGISTRY_CONTRACT_ID,
      REGISTRY_READ_ACCOUNT,
      REGISTRY_NETWORK_PASSPHRASE ?? loop.network.networkPassphrase
    );
    const invalid = entries.filter(id => !isContractAddress(id));
    if (invalid.length > 0) {
      log.warn({ count: invalid.length, addresses: invalid }, 'registry discovery skipped non-contract addresses');
    }
    loop.discoveredContractIds = entries.filter(isContractAddress);
    routine.success({ network: loop.network.name, contracts: loop.discoveredContractIds.length }, 'registry discovery complete');
  } catch (err) {
    indexingErrors.inc({ loop: 'registry' });
    log.error({ err: message(err) }, 'registry polling failed');
  }
}

/**
 * Fetches and stores contract events, tracking its own ledger cursor on
 * whatever network this loop's Soroban RPC points at — independent of the
 * Horizon loop's cursor, which may be a different chain entirely (e.g. mainnet
 * transactions alongside a testnet-deployed registry contract).
 */
async function pollContractEvents(loop: NetworkLoop): Promise<void> {
  const contractIds = [...new Set([...loop.staticContractIds, ...loop.discoveredContractIds])];
  const name = loop.network.name;
  contractsWatched.set({ network: name }, loop.sorobanRpcUrl ? contractIds.length : 0);
  if (!loop.sorobanRpcUrl || contractIds.length === 0) return;
  try {
    if (loop.eventsCursor === 0) {
      const dbCursor = await getLatestIndexedEventLedger(pool, name);
      if (dbCursor > 0) {
        loop.eventsCursor = dbCursor + 1;
      } else {
        // Match the Horizon indexer's own "fresh DB starts from latest" convention,
        // rather than guessing a backfill window — RPC getEvents silently returns
        // empty (no error) for startLedger values too far behind current, and how
        // far is "too far" is provider-specific and not worth hardcoding a guess at.
        loop.eventsCursor = await getLatestRpcLedgerSequence(loop.sorobanRpcUrl);
        log.info({ network: name, ledger: loop.eventsCursor }, 'contract event indexing starting from latest RPC ledger');
      }
    }

    // Check if cursor has fallen outside the RPC's retention window
    const retentionInfo = await getRetentionInfo(loop.sorobanRpcUrl);
    if (retentionInfo) {
      const oldestAvailable = retentionInfo.oldestLedger;
      if (loop.eventsCursor < oldestAvailable) {
        log.warn(
          { network: name, cursor: loop.eventsCursor, oldestAvailable, retentionWindowLedgers: RETENTION_WINDOW_LEDGERS },
          'Soroban event cursor is behind RPC retention window; skipping forward to oldest available ledger'
        );
        sorobanRetentionWindowExceeded.inc({ network: name });
        loop.eventsCursor = oldestAvailable;
      }
    }

    const { events, latestLedger, truncated } = await getEvents(
      loop.sorobanRpcUrl,
      contractIds,
      loop.eventsCursor,
      MAX_EVENTS_PER_CYCLE
    );
    if (events.length > 0) {
      routine.success({ network: name, events: events.length, fromLedger: loop.eventsCursor }, 'indexing contract events');
      contractEventsIndexed.inc(events.length);
      await insertContractEvents(pool, name, events);
      await indexCustomEvents(loop, events);
    }
    if (truncated) {
      sorobanEventsTruncated.inc({ network: name });
      log.info(
        { network: name, eventsFetched: events.length, maxEventsPerCycle: MAX_EVENTS_PER_CYCLE },
        'Soroban event polling hit per-cycle limit; remaining events will be fetched in next cycle'
      );
    }
    loop.eventsCursor = Math.max(loop.eventsCursor, latestLedger - EVENTS_SAFETY_LAG_LEDGERS + 1);
  } catch (err) {
    indexingErrors.inc({ loop: 'contract-events' });
    log.error({ network: name, err: message(err) }, 'contract event polling failed');
  }
}

/**
 * Decode this batch against any registered per-contract schemas.
 *
 * Deliberately after the generic insert and in its own try/catch: custom
 * decoding is an addition on top of `contract_events`, so a broken schema — or
 * a `custom_events` table that has not been migrated yet — must never cost the
 * generic indexing that everything else depends on.
 *
 * Schemas are re-read each cycle rather than cached at startup, because
 * registration is a CLI write to the database and there is no signal the
 * indexer could receive. They are read per network: the same contract id can
 * decode differently on two chains, and `register-schema --network` decides
 * which one a schema belongs to.
 */
async function indexCustomEvents(loop: NetworkLoop, events: ContractEvent[]): Promise<void> {
  try {
    const schemas = await loadContractSchemas(pool, loop.network.name);
    if (schemas.size === 0) return;

    const { decoded, failures } = decodeEvents(schemas, events);

    for (const failure of failures) {
      // A matched event that will not decode means the schema and the contract
      // have diverged — loud, because it is silently wrong data otherwise.
      customEventsDecoded.inc({ outcome: 'failed' });
      log.warn(
        { network: loop.network.name, eventId: failure.eventId, event: failure.eventName, reason: failure.reason },
        'custom schema decode failed; schema and contract have diverged'
      );
    }

    if (decoded.length > 0) {
      routine.success({ network: loop.network.name, decoded: decoded.length }, 'decoded events against custom schemas');
      customEventsDecoded.inc({ outcome: 'decoded' }, decoded.length);
      await insertCustomEvents(pool, loop.network.name, decoded);
    }
  } catch (err) {
    indexingErrors.inc({ loop: 'custom-schema' });
    log.error({ network: loop.network.name, err: message(err) }, 'custom schema indexing failed; generic indexing unaffected');
  }
}

/**
 * Fetches and stores contract storage entries, and detects archival.
 *
 * The watch list is the union of every key this network has already indexed
 * (read back from the database, so a key is never silently dropped from it) and
 * the configured seed. A watched key the RPC stops returning is the archival
 * signal: Soroban archives a persistent entry once its TTL expires, so the entry
 * becomes inaccessible rather than deleted. It is therefore marked `archived`
 * rather than removed, which is what lets a client tell an archived entry (a row
 * with `state = 'archived'`) from an absent one (no row at all).
 *
 * Archival is only ever inferred from disappearance plus a prior `active`
 * observation — a seed key that has never been returned has no row and stays
 * `absent`, never mislabelled `archived`.
 */
async function pollContractStorage(loop: NetworkLoop): Promise<void> {
  if (!loop.sorobanRpcUrl) return;
  const name = loop.network.name;
  try {
    const tracked = await getTrackedContractStorageKeys(pool, name);
    const keys = [...new Set([...tracked, ...config.indexedContractStorageKeys])];
    if (keys.length === 0) return;

    const { entries } = await getContractStorageEntries(loop.sorobanRpcUrl, keys);
    const returnedKeys = new Set(entries.map(entry => entry.key));

    if (entries.length > 0) {
      routine.success({ network: name, entries: entries.length }, 'indexed contract storage entries');
      await upsertContractStorageEntries(pool, name, entries);
    }

    // Watched keys the RPC did not return. Only those previously observed as
    // `active` are marked; the UPDATE's state guard makes the rest no-ops.
    const missing = keys.filter(key => !returnedKeys.has(key));
    if (missing.length > 0) {
      await markContractStorageEntriesArchived(pool, name, missing);
    }
  } catch (err) {
    indexingErrors.inc({ loop: 'contract-storage' });
    log.error({ network: name, err: message(err) }, 'contract storage polling failed');
  }
}

/** Run one network's polling loop until the process shuts down. */
async function runNetworkLoop(loop: NetworkLoop, isPrimary: boolean): Promise<void> {
  const name = loop.network.name;

  // Cursor initialisation talks to the database and Horizon, so it can fail
  // too. It is retried inside the loop rather than thrown, so one network's bad
  // start never takes the others down with it.
  let initialised = false;
  const initCursor = async (): Promise<void> => {
    loop.cursor = await getLatestIndexedLedger(pool, name);
    if (loop.cursor === 0 && START_LEDGER !== undefined) {
      loop.cursor = START_LEDGER - 1;
      log.info({ network: name, ledger: START_LEDGER }, 'starting from configured START_LEDGER');
    } else if (loop.cursor === 0) {
      loop.cursor = await getLatestLedgerSequence(loop.network.horizonUrl);
      log.info({ network: name, ledger: loop.cursor + 1 }, 'starting from latest ledger');
    } else {
      log.info({ network: name, ledger: loop.cursor + 1 }, 'resuming from ledger');
    }
    initialised = true;
  };

  scheduleAccountRefreshes(loop);

  const indexOne = (sequence: number): Promise<boolean> =>
    fetchAndIndexLedgerWithRetry(name, sequence, seq => fetchAndIndexLedger(loop, seq));

  // Start the retry worker for this network
  loop.retryWorker = new RetryWorker({
    pool,
    network: name,
    indexOne,
    pollIntervalMs: 30000, // Check retry queue every 30 seconds
  });
  
  // Run retry worker in background
  loop.retryWorker.start().catch(err => {
    log.error({ network: name, err: message(err) }, 'retry worker crashed');
  });

  while (!isShuttingDown) {
    try {
      if (!initialised) {
        await initCursor();
      }
      if (isPrimary && loop.loopTick % REGISTRY_POLL_EVERY_N_TICKS === 0) {
        await pollRegistry(loop);
      }
      loop.loopTick++;

      const latest = await getLatestLedgerSequence(loop.network.horizonUrl);
      loop.state.latestHorizonLedger = latest;
      recordHorizonTip(name, latest, loop.state.latestIndexedLedger || loop.cursor);

      loop.cursor = await runLedgerCatchUp(loop.cursor, latest, indexOne, advanced =>
        recordHorizonTip(name, latest, advanced)
      );

      if (isShuttingDown) break;
      await pollContractEvents(loop);
      await pollContractStorage(loop);
    } catch (err) {
      indexingErrors.inc({ loop: 'main' });
      log.error({ network: name, err: message(err) }, 'indexer loop error');
      if (err instanceof Error) {
        captureException(err, { loop: 'main', network: name, ledger: loop.cursor });
      }
    }

    if (isShuttingDown) break;
    scheduleAccountRefreshes(loop);
    await new Promise(r => setTimeout(r, config!.pollIntervalMs));
  }
  
  // Stop retry worker
  loop.retryWorker?.stop();
}

/**
 * One retention pass, wrapped so a failure is logged and the loop continues.
 *
 * A prune that throws — a lock it could not take within `lock_timeout`, a
 * partition another process is detaching — must not take the indexer down or
 * stop future passes. Retrying an hour later is the whole recovery strategy.
 */
export async function runRetentionOnce(): Promise<RetentionReport[]> {
  try {
    return await pruneExpiredData(pool, RETENTION_WINDOWS, { batchSize: RETENTION_PRUNE_BATCH_SIZE });
  } catch (err) {
    indexingErrors.inc({ loop: 'retention' });
    log.error({ err: message(err) }, 'retention prune failed; will retry on the next interval');
    return [];
  }
}

/**
 * The pruning loop. Sleeps first so a long indexer backfill is not competing
 * with a prune for the first hour of the process's life — on a cold database
 * the backfill is the priority.
 */
async function runRetentionLoop(): Promise<void> {
  const tables = retainedTables(RETENTION_WINDOWS);
  log.info(
    { tables, intervalMs: RETENTION_PRUNE_INTERVAL_MS, batchSize: RETENTION_PRUNE_BATCH_SIZE },
    'retention pruning enabled'
  );
  while (!isShuttingDown) {
    await sleep(RETENTION_PRUNE_INTERVAL_MS);
    if (isShuttingDown) break;
    await runRetentionOnce();
  }
}

async function run() {
  initErrorTracking();
  initTracing();
  
  // Initialize the horizon client with config
  initializeHorizonClient({
    minIntervalMs: config.horizonMinRequestIntervalMs,
    maxIntervalMs: config.horizonMaxRequestIntervalMs,
    authToken: config.horizonAuthToken,
    tipWeightFactor: config.horizonTipWeightFactor,
  });

  // Fails loudly here rather than inside a loop: a misconfigured network
  // otherwise means one chain silently stops while the others keep indexing.
  const registry = resolveNetworks(process.env);
  const startedAt = Date.now();
  const loops = registry.networks.map(network => createLoop(network, registry.primary.name));

  log.info(
    {
      version: VERSION,
      networks: loops.map(loop => loop.network.name),
      primary: registry.primary.name,
      database: redactUrl(DATABASE_URL),
      healthPort: HEALTH_PORT,
      dbPoolMax: DB_POOL_MAX ?? 10,
      dbPoolIdleTimeout: DB_POOL_IDLE_TIMEOUT ?? 10000,
      dbPoolConnectionTimeout: DB_POOL_CONNECTION_TIMEOUT ?? 0,
      retention: isRetentionEnabled(RETENTION_WINDOWS) ? RETENTION_WINDOWS : 'unlimited',
    },
    'lumina indexer starting'
  );

  startHealthServer({
    port: HEALTH_PORT,
    // The flat numbers describe the worst-off network; the per-network detail
    // rides alongside, so one stuck chain cannot hide behind a healthy one.
    getState: () => aggregateNetworkStates(startedAt, loops.map(loop => loop.state)),
    getDebugConfiguration: () => buildDebugConfiguration(
      config,
      registry.primary.name,
      loops.map(loop => ({
        network: loop.network.name,
        horizonUrl: loop.network.horizonUrl,
        sorobanRpcUrl: loop.sorobanRpcUrl,
        networkPassphrase: loop.network.networkPassphrase,
        cursor: loop.cursor,
        eventsCursor: loop.eventsCursor,
        latestIndexedLedger: loop.state.latestIndexedLedger,
        latestHorizonLedger: loop.state.latestHorizonLedger,
        watchedContracts: [...loop.staticContractIds, ...loop.discoveredContractIds],
      }))
    ),
    pool,
  });

  isLoopRunning = true;
  // The retention loop is a peer of the network loops, not a step inside one:
  // it has to keep running (and the network loops have to keep running)
  // regardless of what the other is doing.
  await Promise.all([
    runIndependently(
      loops,
      loop => runNetworkLoop(loop, loop.network.name === registry.primary.name),
      loop => loop.network.name
    ),
    isRetentionEnabled(RETENTION_WINDOWS) ? runRetentionLoop() : Promise.resolve(),
  ]);
  isLoopRunning = false;
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info('shutting down indexer');

  setTimeout(() => {
    log.fatal('shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, 10000).unref();

  while (isLoopRunning) {
    await new Promise(r => setTimeout(r, 100));
  }

  if (pool) await pool.end();
  await shutdownTracing();
  await shutdownErrorTracking();
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  run().catch(err => {
    log.fatal({ err: message(err) }, 'fatal indexer error');
    process.exit(1);
  });
}

/** Errors are logged as a field, not interpolated, so they stay queryable. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scheduleAccountRefreshes(loop: NetworkLoop): void {
  if (loop.accountRefreshTask || isShuttingDown) return;

  let continueQueue = false;
  const task = (async () => {
    try {
      const result = await refreshAccountQueueBatch(
        pool,
        loop.network.name,
        loop.network.horizonUrl
      );
      continueQueue = result.hasMore;
      for (const failure of result.failures) {
        log.warn(
          { network: loop.network.name, address: failure.address, err: message(failure.error) },
          'account refresh failed; durable queue entry will be retried'
        );
      }
    } catch (err) {
      indexingErrors.inc({ loop: 'account-refresh' });
      log.error({ network: loop.network.name, err: message(err) }, 'account refresh worker failed');
    } finally {
      loop.accountRefreshTask = null;
      if (continueQueue && !isShuttingDown) scheduleAccountRefreshes(loop);
    }
  })();
  loop.accountRefreshTask = task;
}

/** Redacts the password from a database URL for logging. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '(unparseable)';
  }
}

