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
 *   INDEXED_CONTRACT_IDS  — Comma-separated contract IDs to index events for (requires a Soroban RPC URL)
 *   REGISTRY_CONTRACT_ID  — Lumina Registry contract to poll for additional contract IDs (primary network only; requires a Soroban RPC URL + REGISTRY_READ_ACCOUNT)
 *   REGISTRY_READ_ACCOUNT — Any funded account address used to simulate the registry's read calls (no secret key needed)
 *   REGISTRY_NETWORK_PASSPHRASE — Network passphrase for registry simulation (default: the primary network's passphrase)
 */

import {
  createPool,
  ensurePartitions,
  getLatestIndexedEventLedger,
  getLatestIndexedLedger,
  indexLedger,
  insertContractEvents,
  insertCustomEvents,
  loadContractSchemas,
} from './db';
import { decodeEvents } from './customDecode';
import { routineLogger, subsystem } from './logger';
import {
  contractEventsIndexed,
  customEventsDecoded,
  indexingErrors,
  ledgerIndexDuration,
  recordHorizonTip,
  recordIndexedLedger,
  lastSuccessfulRegistryDiscoveryTimestamp,
} from './metrics';
import { aggregateNetworkStates, startHealthServer, type NetworkState } from './health';
import { initTracing, shutdownTracing } from './tracing';
import { initErrorTracking, captureException, shutdownErrorTracking } from './errorTracking';

const log = subsystem('indexer');

// Routine success goes through `routine`, which samples (LOG_SAMPLE_RATE) and
// carries a `suppressed` count on every emitted line. Warnings and errors stay on
// `log`, which is never sampled.
const routine = routineLogger('indexer');

const HEALTH_PORT = parseInt(process.env['HEALTH_PORT'] ?? '9090', 10);

import { getAccount, getLatestLedgerSequence, getLedger, getLedgerOperations, getLedgerTransactions, HorizonAccount } from './horizon';
import { getActiveContracts } from './registry';
import { getEvents, getLatestLedgerSequence as getLatestRpcLedgerSequence, type ContractEvent } from './soroban';
import { resolveNetworks, type NetworkConfig } from './networks';

// Read version from package.json for logging
import { readFileSync } from 'fs';
import { join } from 'path';
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
const VERSION = packageJson.version;

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/lumina';
const POLL_INTERVAL_MS = parseInt(process.env['POLL_INTERVAL_MS'] ?? '5000', 10);
const START_LEDGER = process.env['START_LEDGER'] ? parseInt(process.env['START_LEDGER'], 10) : undefined;
const DB_POOL_MAX = process.env['DB_POOL_MAX'] ? parseInt(process.env['DB_POOL_MAX'], 10) : undefined;
const DB_POOL_IDLE_TIMEOUT = process.env['DB_POOL_IDLE_TIMEOUT'] ? parseInt(process.env['DB_POOL_IDLE_TIMEOUT'], 10) : undefined;
const DB_POOL_CONNECTION_TIMEOUT = process.env['DB_POOL_CONNECTION_TIMEOUT'] ? parseInt(process.env['DB_POOL_CONNECTION_TIMEOUT'], 10) : undefined;

// Soroban contract event indexing is opt-in — unset by default, the indexer
// behaves exactly as it did before these were introduced. The RPC endpoint
// itself is per network (see networks.ts); the contract list is shared unless
// a network overrides it with <NAME>_INDEXED_CONTRACT_IDS, because the same
// deployment usually indexes different contract ids on each chain.
const INDEXED_CONTRACT_IDS = (process.env['INDEXED_CONTRACT_IDS'] ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// Registry-based discovery is opt-in on top of the opt-in event indexing above —
// unset, the indexer relies solely on the static INDEXED_CONTRACT_IDS list.
// One Registry contract lives on one chain, so discovery runs on the primary
// network only; the contracts it finds are indexed alongside that network's
// static list.
const REGISTRY_CONTRACT_ID = process.env['REGISTRY_CONTRACT_ID'];
const REGISTRY_READ_ACCOUNT = process.env['REGISTRY_READ_ACCOUNT'];
const REGISTRY_NETWORK_PASSPHRASE = process.env['REGISTRY_NETWORK_PASSPHRASE'];
const REGISTRY_POLL_EVERY_N_TICKS = 12; // ~once/minute at the default 5s poll interval

const LEDGER_RETRY_ATTEMPTS = 3;
const LEDGER_RETRY_BASE_MS = 500;

// How long an account's Horizon data is considered fresh enough to skip
// re-fetching. Busy accounts (exchanges, bots) show up in most ledgers —
// without this, the indexer re-fetches the same accounts every ~5s and
// floods Horizon's per-IP rate limit, which then also breaks the GraphQL
// server's own account lookups sharing that limit. Kept per network: the
// account sequence on mainnet says nothing about the same address on testnet.
const ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const ACCOUNT_CACHE_MAX_SIZE = 50_000;

// getEvents' reported latestLedger is the RPC's chain-tip awareness, not a
// guarantee that ledger's events have finished being indexed internally —
// confirmed live: an event was missing from a response whose latestLedger
// was already past it, then present moments later at the same startLedger.
// Advancing the cursor straight to latestLedger + 1 can permanently skip
// events landing right at that boundary. Re-scanning the last few ledgers
// each poll is cheap and idempotent (insertContractEvents is ON CONFLICT
// DO NOTHING), so hold the cursor back by a small margin instead.
const EVENTS_SAFETY_LAG_LEDGERS = 3;

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
  };
}

function pruneAccountCache(cache: Map<string, number>, now: number): void {
  if (cache.size < ACCOUNT_CACHE_MAX_SIZE) return;
  for (const [address, fetchedAt] of cache) {
    if (now - fetchedAt > ACCOUNT_CACHE_TTL_MS) cache.delete(address);
  }
}

async function fetchAndIndexLedger(loop: NetworkLoop, sequence: number): Promise<void> {
  const name = loop.network.name;
  log.debug({ network: name, ledger: sequence }, 'indexing ledger');
  const [ledger, transactions, operations] = await Promise.all([
    getLedger(loop.network.horizonUrl, sequence),
    getLedgerTransactions(loop.network.horizonUrl, sequence),
    getLedgerOperations(loop.network.horizonUrl, sequence),
  ]);

  const addresses = new Set<string>();
  for (const tx of transactions) addresses.add(tx.source_account);
  for (const op of operations) addresses.add(op.source_account);

  const now = Date.now();
  pruneAccountCache(loop.accountCache, now);
  const addressesToFetch = [...addresses].filter(address => {
    const fetchedAt = loop.accountCache.get(address);
    return fetchedAt === undefined || now - fetchedAt > ACCOUNT_CACHE_TTL_MS;
  });

  const accounts = (
    await Promise.all(
      addressesToFetch.map(address => getAccount(loop.network.horizonUrl, address))
    )
  ).filter((a): a is HorizonAccount => a !== null);
  for (const address of addressesToFetch) loop.accountCache.set(address, now);

  const stopTimer = ledgerIndexDuration.startTimer();
  await indexLedger(pool, name, ledger, transactions, operations, accounts);
  stopTimer();

  loop.state.latestIndexedLedger = sequence;
  loop.state.lastIndexedAt = Date.now();
  recordIndexedLedger(name, sequence, transactions.length, operations.length);
  routine.success(
    { network: name, ledger: sequence, transactions: transactions.length, operations: operations.length },
    'ledger indexed'
  );
}

export async function fetchAndIndexLedgerWithRetry(
  sequence: number,
  indexOne: (sequence: number) => Promise<void>,
  retryAttempts = LEDGER_RETRY_ATTEMPTS,
  retryBaseMs = LEDGER_RETRY_BASE_MS
): Promise<boolean> {
  if (!config) throw new Error('Configuration not loaded');
  const actualRetryAttempts = retryAttempts ?? config.ledgerRetryAttempts;
  const actualRetryBaseMs = retryBaseMs ?? config.ledgerRetryBaseMs;
  for (let attempt = 1; attempt <= actualRetryAttempts; attempt++) {
    try {
      await indexOne(sequence);
      return true;
    } catch (err) {
      if (attempt === actualRetryAttempts) {
        indexingErrors.inc({ loop: 'ledger' });
        log.error({ ledger: sequence, attempts: attempt, err: message(err) }, 'giving up on ledger');
        return false;
      }
      const delay = actualRetryBaseMs * 2 ** (attempt - 1);
      log.warn(
        { ledger: sequence, attempt, maxAttempts: actualRetryAttempts, retryInMs: delay, err: message(err) },
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
  if (!loop.sorobanRpcUrl || contractIds.length === 0) return;
  const name = loop.network.name;
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

    const { events, latestLedger } = await getEvents(loop.sorobanRpcUrl, contractIds, loop.eventsCursor);
    if (events.length > 0) {
      routine.success({ network: name, events: events.length, fromLedger: loop.eventsCursor }, 'indexing contract events');
      contractEventsIndexed.inc(events.length);
      await insertContractEvents(pool, name, events);
      await indexCustomEvents(loop, events);
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

/** Run one network's polling loop until the process shuts down. */
async function runNetworkLoop(loop: NetworkLoop, isPrimary: boolean): Promise<void> {
  const name = loop.network.name;

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

  const indexOne = (sequence: number): Promise<boolean> =>
    fetchAndIndexLedgerWithRetry(sequence, seq => fetchAndIndexLedger(loop, seq));

  while (!isShuttingDown) {
    try {
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
    } catch (err) {
      indexingErrors.inc({ loop: 'main' });
      log.error({ network: name, err: message(err) }, 'indexer loop error');
      if (err instanceof Error) {
        captureException(err, { loop: 'main', network: name, ledger: loop.cursor });
      }
    }

    if (isShuttingDown) break;
    await new Promise(r => setTimeout(r, config!.pollIntervalMs));
  }
}

async function run() {
  initErrorTracking();
  initTracing();

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
    },
    'lumina indexer starting'
  );

  startHealthServer({
    port: HEALTH_PORT,
    // The flat numbers describe the worst-off network; the per-network detail
    // rides alongside, so one stuck chain cannot hide behind a healthy one.
    getState: () => aggregateNetworkStates(startedAt, loops.map(loop => loop.state)),
    pool,
  });

  isLoopRunning = true;
  await Promise.all(
    loops.map(loop => runNetworkLoop(loop, loop.network.name === registry.primary.name))
  );
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

