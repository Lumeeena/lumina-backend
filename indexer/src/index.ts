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

import { Networks } from '@stellar/stellar-sdk';
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
import { subsystem } from './logger';
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

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT ?? '9090', 10);

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

const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/lumina';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10);
const START_LEDGER = process.env.START_LEDGER ? parseInt(process.env.START_LEDGER, 10) : undefined;

// Soroban contract event indexing is opt-in — unset by default, the indexer
// behaves exactly as it did before these were introduced.
const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL;
const INDEXED_CONTRACT_IDS = (process.env.INDEXED_CONTRACT_IDS ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// Registry-based discovery is opt-in on top of the opt-in event indexing above —
// unset, the indexer relies solely on the static INDEXED_CONTRACT_IDS list.
const REGISTRY_CONTRACT_ID = process.env.REGISTRY_CONTRACT_ID;
const REGISTRY_READ_ACCOUNT = process.env.REGISTRY_READ_ACCOUNT;
const REGISTRY_NETWORK_PASSPHRASE = process.env.REGISTRY_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const REGISTRY_POLL_EVERY_N_TICKS = 12; // ~once/minute at the default 5s poll interval

const LEDGER_RETRY_ATTEMPTS = 3;
const LEDGER_RETRY_BASE_MS = 500;

// How long an account's Horizon data is considered fresh enough to skip
// re-fetching. Busy accounts (exchanges, bots) show up in most ledgers —
// without this, the indexer re-fetches the same accounts every ~5s and
// floods Horizon's per-IP rate limit, which then also breaks the GraphQL
// server's own account lookups sharing that limit.
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

const pool = createPool(DATABASE_URL);
let discoveredContractIds: string[] = [];
let loopTick = 0;
let eventsCursor = 0;
const accountCache = new Map<string, number>(); // address -> last-fetched-at

function pruneAccountCache(now: number): void {
  if (accountCache.size < ACCOUNT_CACHE_MAX_SIZE) return;
  for (const [address, fetchedAt] of accountCache) {
    if (now - fetchedAt > ACCOUNT_CACHE_TTL_MS) accountCache.delete(address);
  }
}

async function fetchAndIndexLedger(sequence: number): Promise<void> {
  log.debug({ ledger: sequence }, 'indexing ledger');
  const [ledger, transactions, operations] = await Promise.all([
    getLedger(HORIZON_URL, sequence),
    getLedgerTransactions(HORIZON_URL, sequence),
    getLedgerOperations(HORIZON_URL, sequence),
  ]);

  const addresses = new Set<string>();
  for (const tx of transactions) addresses.add(tx.source_account);
  for (const op of operations) addresses.add(op.source_account);

  const now = Date.now();
  pruneAccountCache(now);
  const addressesToFetch = [...addresses].filter(address => {
    const fetchedAt = accountCache.get(address);
    return fetchedAt === undefined || now - fetchedAt > ACCOUNT_CACHE_TTL_MS;
  });

  const accounts = (
    await Promise.all(addressesToFetch.map(address => getAccount(HORIZON_URL, address)))
  ).filter((a): a is HorizonAccount => a !== null);
  for (const address of addressesToFetch) accountCache.set(address, now);

  const stopTimer = ledgerIndexDuration.startTimer();
  await indexLedger(pool, ledger, transactions, operations, accounts);
  stopTimer();

  state.latestIndexedLedger = sequence;
  state.lastIndexedAt = Date.now();
  recordIndexedLedger(sequence, transactions.length, operations.length);
}

async function fetchAndIndexLedgerWithRetry(sequence: number): Promise<void> {
  for (let attempt = 1; attempt <= LEDGER_RETRY_ATTEMPTS; attempt++) {
    try {
      await fetchAndIndexLedger(sequence);
      return;
    } catch (err) {
      if (attempt === LEDGER_RETRY_ATTEMPTS) {
        indexingErrors.inc({ loop: 'ledger' });
        log.error({ ledger: sequence, attempts: attempt, err: message(err) }, 'giving up on ledger');
        return;
      }
      const delay = LEDGER_RETRY_BASE_MS * 2 ** (attempt - 1);
      log.warn(
        { ledger: sequence, attempt, maxAttempts: LEDGER_RETRY_ATTEMPTS, retryInMs: delay, err: message(err) },
        'ledger failed, retrying'
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
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
  if (!SOROBAN_RPC_URL || !REGISTRY_CONTRACT_ID || !REGISTRY_READ_ACCOUNT) return;
  try {
    const entries = await getActiveContracts(
      SOROBAN_RPC_URL,
      REGISTRY_CONTRACT_ID,
      REGISTRY_READ_ACCOUNT,
      REGISTRY_NETWORK_PASSPHRASE
    );
    const invalid = entries.filter(id => !isContractAddress(id));
    if (invalid.length > 0) {
      log.warn({ count: invalid.length, addresses: invalid }, 'registry discovery skipped non-contract addresses');
    }
    discoveredContractIds = entries.filter(isContractAddress);
    log.info({ contracts: discoveredContractIds.length }, 'registry discovery complete');
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
  const contractIds = [...new Set([...INDEXED_CONTRACT_IDS, ...discoveredContractIds])];
  if (!SOROBAN_RPC_URL || contractIds.length === 0) return;
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
        eventsCursor = await getLatestRpcLedgerSequence(SOROBAN_RPC_URL);
        log.info({ ledger: eventsCursor }, 'contract event indexing starting from latest RPC ledger');
      }
    }

    const { events, latestLedger } = await getEvents(SOROBAN_RPC_URL, contractIds, eventsCursor);
    if (events.length > 0) {
      log.info({ events: events.length, fromLedger: eventsCursor }, 'indexing contract events');
      contractEventsIndexed.inc(events.length);
      await insertContractEvents(pool, events);
      await indexCustomEvents(events);
    }
    eventsCursor = Math.max(eventsCursor, latestLedger - EVENTS_SAFETY_LAG_LEDGERS + 1);
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
      log.info({ decoded: decoded.length }, 'decoded events against custom schemas');
      customEventsDecoded.inc({ outcome: 'decoded' }, decoded.length);
      await insertCustomEvents(pool, decoded);
    }
  } catch (err) {
    indexingErrors.inc({ loop: 'custom-schema' });
    log.error({ err: message(err) }, 'custom schema indexing failed; generic indexing unaffected');
  }
}

async function run() {
  initErrorTracking();
  initTracing();
  log.info({ horizon: HORIZON_URL, database: redactUrl(DATABASE_URL), healthPort: HEALTH_PORT }, 'lumina indexer starting');
  startHealthServer({ port: HEALTH_PORT, getState: () => state, pool });

  let cursor = await getLatestIndexedLedger(pool);
  if (cursor === 0 && START_LEDGER !== undefined) {
    cursor = START_LEDGER - 1;
    log.info({ ledger: START_LEDGER }, 'starting from configured START_LEDGER');
  } else if (cursor === 0) {
    cursor = await getLatestLedgerSequence(HORIZON_URL);
    log.info({ ledger: cursor + 1 }, 'starting from latest ledger');
  } else {
    log.info({ ledger: cursor + 1 }, 'resuming from ledger');
  }

  while (true) {
    try {
      if (loopTick % REGISTRY_POLL_EVERY_N_TICKS === 0) {
        await pollRegistry();
      }
      loopTick++;

      const latest = await getLatestLedgerSequence(HORIZON_URL);
      state.latestHorizonLedger = latest;
      recordHorizonTip(latest, state.latestIndexedLedger || cursor);

      for (let seq = cursor + 1; seq <= latest; seq++) {
        await fetchAndIndexLedgerWithRetry(seq);
        cursor = seq;
        recordHorizonTip(latest, cursor);
      }

      await pollContractEvents();
    } catch (err) {
      indexingErrors.inc({ loop: 'main' });
      log.error({ err: message(err) }, 'indexer loop error');
      if (err instanceof Error) {
        captureException(err, { loop: 'main', ledger: cursor });
      }
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function shutdown() {
  log.info('shutting down indexer');
  await pool.end();
  await shutdownTracing();
  await shutdownErrorTracking();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run().catch(err => {
  log.fatal({ err: message(err) }, 'fatal indexer error');
  if (err instanceof Error) {
    captureException(err, { fatal: true });
  }
  process.exit(1);
});

/** Errors are logged as a field, not interpolated, so they stay queryable. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Never log a database URL with its password in it. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable)';
  }
}
