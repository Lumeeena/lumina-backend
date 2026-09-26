/**
 * Lumina Indexer
 *
 * Polls Stellar Horizon for new ledgers and writes transactions and
 * operations to the PostgreSQL database defined in db/schema.sql.
 *
 * Architecture:
 *   Horizon API → Indexer → PostgreSQL ← GraphQL Server ← Frontend / API Consumers
 *
 * Environment variables:
 *   HORIZON_URL          — Stellar Horizon base URL (default: mainnet)
 *   DATABASE_URL         — PostgreSQL connection string
 *   START_LEDGER         — Ledger to begin indexing from if the DB is empty (default: latest)
 *   POLL_INTERVAL_MS     — How often to poll for new ledgers (default: 5000)
 *   SOROBAN_RPC_URL           — Soroban RPC endpoint; unset disables contract event indexing
 *   INDEXED_CONTRACT_IDS      — Comma-separated contract IDs to index events for (requires SOROBAN_RPC_URL)
 *   REGISTRY_CONTRACT_ID      — Lumina Registry contract to poll for additional contract IDs (requires SOROBAN_RPC_URL + REGISTRY_READ_ACCOUNT)
 *   REGISTRY_READ_ACCOUNT     — Any funded account address used to simulate the registry's read calls (no secret key needed)
 *   REGISTRY_NETWORK_PASSPHRASE — Network passphrase for registry simulation (default: Test SDF Network passphrase)
 */

import {
  createPool,
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
} from './metrics';
import { startHealthServer, type IndexerState } from './health';
import { initTracing, shutdownTracing } from './tracing';
import { initErrorTracking, captureException, shutdownErrorTracking } from './errorTracking';

const log = subsystem('indexer');

// Routine success goes through `routine`, which samples (LOG_SAMPLE_RATE) and
// carries a `suppressed` count on every emitted line. Warnings and errors stay on
// `log`, which is never sampled.
const routine = routineLogger('indexer');


/** Live state the health endpoint reports on. */
const state: IndexerState = {
  latestIndexedLedger: 0,
  latestHorizonLedger: 0,
  lastIndexedAt: null,
  startedAt: Date.now(),
};
import { getAccount, getLatestLedgerSequence, getLedger, getLedgerOperations, getLedgerTransactions, HorizonAccount } from './horizon';
import { getActiveContracts } from './registry';
import { getEvents, getLatestLedgerSequence as getLatestRpcLedgerSequence, type ContractEvent } from './soroban';
import { chunkContractIds, filterContractIds, recordFailure, recordSuccess } from './circuitBreaker';
import { loadConfig, type Config } from './config';

// Read version from package.json for logging
import { readFileSync } from 'fs';
import { join } from 'path';
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
const VERSION = packageJson.version;

// Configuration is loaded once at startup
let config: Config | null = null;
let pool: ReturnType<typeof createPool> | null = null;
let discoveredContractIds: string[] = [];
let loopTick = 0;
let eventsCursor = 0;
const accountCache = new Map<string, number>(); // address -> last-fetched-at

let isShuttingDown = false;
let isLoopRunning = false;

function pruneAccountCache(now: number): void {
  if (!config) return;
  if (accountCache.size < config.accountCacheMaxSize) return;
  for (const [address, fetchedAt] of accountCache) {
    if (now - fetchedAt > config.accountCacheTtlMs) accountCache.delete(address);
  }
}

async function fetchAndIndexLedger(sequence: number): Promise<void> {
  if (!config || !pool) throw new Error('Configuration not loaded');
  log.debug({ ledger: sequence }, 'indexing ledger');
  const [ledger, transactions, operations] = await Promise.all([
    getLedger(config.horizonUrl, sequence),
    getLedgerTransactions(config.horizonUrl, sequence),
    getLedgerOperations(config.horizonUrl, sequence),
  ]);

  const addresses = new Set<string>();
  for (const tx of transactions) addresses.add(tx.source_account);
  for (const op of operations) addresses.add(op.source_account);

  const now = Date.now();
  pruneAccountCache(now);
  const addressesToFetch = [...addresses].filter(address => {
    const fetchedAt = accountCache.get(address);
    return fetchedAt === undefined || now - fetchedAt > config!.accountCacheTtlMs;
  });

  const accounts = (
    await Promise.all(addressesToFetch.map(address => getAccount(config!.horizonUrl, address)))
  ).filter((a): a is HorizonAccount => a !== null);
  for (const address of addressesToFetch) accountCache.set(address, now);

  const stopTimer = ledgerIndexDuration.startTimer();
  await indexLedger(pool, ledger, transactions, operations, accounts);
  stopTimer();

  state.latestIndexedLedger = sequence;
  state.lastIndexedAt = Date.now();
  recordIndexedLedger(sequence, transactions.length, operations.length);
  routine.success(
    { ledger: sequence, transactions: transactions.length, operations: operations.length },
    'ledger indexed'
  );
}

export async function fetchAndIndexLedgerWithRetry(
  sequence: number,
  indexOne: (sequence: number) => Promise<void> = fetchAndIndexLedger,
  retryAttempts?: number,
  retryBaseMs?: number
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
  indexOne: (sequence: number) => Promise<boolean> = fetchAndIndexLedgerWithRetry,
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
async function pollRegistry(): Promise<void> {
  if (!config) throw new Error('Configuration not loaded');
  if (!config.sorobanRpcUrl || !config.registryContractId || !config.registryReadAccount) return;
  try {
    const entries = await getActiveContracts(
      config.sorobanRpcUrl,
      config.registryContractId,
      config.registryReadAccount,
      config.registryNetworkPassphrase
    );
    const invalid = entries.filter(id => !isContractAddress(id));
    if (invalid.length > 0) {
      log.warn({ count: invalid.length, addresses: invalid }, 'registry discovery skipped non-contract addresses');
    }
    discoveredContractIds = entries.filter(isContractAddress);
    routine.success({ contracts: discoveredContractIds.length }, 'registry discovery complete');
  } catch (err) {
    indexingErrors.inc({ loop: 'registry' });
    log.error({ err: message(err) }, 'registry polling failed');
  }
}

/**
 * Fetches and stores contract events, tracking its own ledger cursor on
 * whatever network SOROBAN_RPC_URL points to — independent of the Horizon
 * loop's cursor, which may be a different network entirely (e.g. mainnet
 * transactions/ledgers alongside a testnet-deployed registry contract).
 */
async function pollContractEvents(): Promise<void> {
  if (!config || !pool) throw new Error('Configuration not loaded');
  const contractIds = [...new Set([...config.indexedContractIds, ...discoveredContractIds])];
  if (!config.sorobanRpcUrl || contractIds.length === 0) return;
  try {
    if (eventsCursor === 0) {
      const dbCursor = await getLatestIndexedEventLedger(pool);
      if (dbCursor > 0) {
        eventsCursor = dbCursor + 1;
      } else {
        // Match the Horizon indexer's own "fresh DB starts from latest" convention,
        // rather than guessing a backfill window — RPC getEvents silently returns
        // empty (no error) for startLedger values too far behind current, and how
        // far is "too far" is provider-specific and not worth hardcoding a guess at.
        eventsCursor = await getLatestRpcLedgerSequence(config.sorobanRpcUrl);
        log.info({ ledger: eventsCursor }, 'contract event indexing starting from latest RPC ledger');
      }
    }

    // Filter out dropped contract IDs (unless it's time to retry)
    const filteredIds = filterContractIds(contractIds);
    if (filteredIds.length === 0) {
      log.debug('all contract IDs dropped by circuit breaker, skipping event polling');
      return;
    }

    // Chunk contract IDs to limit blast radius of failures
    const batches = chunkContractIds(filteredIds);
    let allEvents: ContractEvent[] = [];
    let latestLedger = eventsCursor;

    for (const batch of batches) {
      try {
        const { events, latestLedger: batchLatest } = await getEvents(config!.sorobanRpcUrl, batch, eventsCursor);
        allEvents.push(...events);
        latestLedger = Math.max(latestLedger, batchLatest);
        recordSuccess(batch);
      } catch (err) {
        recordFailure(batch);
        log.warn({ contractIds: batch, err: message(err) }, 'contract event batch failed, circuit breaker tracking failure');
      }
    }

    if (allEvents.length > 0) {
      routine.success({ events: allEvents.length, fromLedger: eventsCursor }, 'indexing contract events');
      contractEventsIndexed.inc(allEvents.length);
      await insertContractEvents(pool, allEvents);
      await indexCustomEvents(allEvents);
    }
    eventsCursor = Math.max(eventsCursor, latestLedger - config.eventsSafetyLagLedgers + 1);
  } catch (err) {
    indexingErrors.inc({ loop: 'contract-events' });
    log.error({ err: message(err) }, 'contract event polling failed');
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
 * indexer could receive.
 */
async function indexCustomEvents(events: ContractEvent[]): Promise<void> {
  if (!pool) throw new Error('Configuration not loaded');
  try {
    const schemas = await loadContractSchemas(pool);
    if (schemas.size === 0) return;

    const { decoded, failures } = decodeEvents(schemas, events);

    for (const failure of failures) {
      // A matched event that will not decode means the schema and the contract
      // have diverged — loud, because it is silently wrong data otherwise.
      customEventsDecoded.inc({ outcome: 'failed' });
      log.warn(
        { eventId: failure.eventId, event: failure.eventName, reason: failure.reason },
        'custom schema decode failed; schema and contract have diverged'
      );
    }

    if (decoded.length > 0) {
      routine.success({ decoded: decoded.length }, 'decoded events against custom schemas');
      customEventsDecoded.inc({ outcome: 'decoded' }, decoded.length);
      await insertCustomEvents(pool, decoded);
    }
  } catch (err) {
    indexingErrors.inc({ loop: 'custom-schema' });
    log.error({ err: message(err) }, 'custom schema indexing failed; generic indexing unaffected');
  }
}

async function run() {
  // Load and validate configuration at startup
  config = loadConfig();
  
  // Initialize pool with validated config
  pool = createPool(config.databaseUrl, {
    max: config.dbPoolMax,
    idleTimeoutMillis: config.dbPoolIdleTimeoutMs,
    connectionTimeoutMillis: config.dbPoolConnectionTimeoutMs,
  });
  
  initErrorTracking();
  initTracing();
  log.info({ version: VERSION }, 'lumina indexer starting');
  startHealthServer({ port: config.healthPort, getState: () => state, pool });

  let cursor = await getLatestIndexedLedger(pool);
  if (cursor === 0 && config.startLedger !== undefined) {
    cursor = config.startLedger - 1;
    log.info({ ledger: config.startLedger }, 'starting from configured START_LEDGER');
  } else if (cursor === 0) {
    cursor = await getLatestLedgerSequence(config.horizonUrl);
    log.info({ ledger: cursor + 1 }, 'starting from latest ledger');
  } else {
    log.info({ ledger: cursor + 1 }, 'resuming from ledger');
  }

  isLoopRunning = true;
  while (!isShuttingDown) {
    try {
      if (loopTick % config.registryPollEveryNTicks === 0) {
        await pollRegistry();
      }
      loopTick++;

      const latest = await getLatestLedgerSequence(config.horizonUrl);
      state.latestHorizonLedger = latest;
      recordHorizonTip(latest, state.latestIndexedLedger || cursor);

      cursor = await runLedgerCatchUp(cursor, latest, undefined, advanced => recordHorizonTip(latest, advanced));

      if (isShuttingDown) break;
      await pollContractEvents();
    } catch (err) {
      indexingErrors.inc({ loop: 'main' });
      log.error({ err: message(err) }, 'indexer loop error');
      if (err instanceof Error) {
        captureException(err, { loop: 'main', ledger: cursor });
      }
    }

    if (isShuttingDown) break;
    await new Promise(r => setTimeout(r, config!.pollIntervalMs));
  }
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

