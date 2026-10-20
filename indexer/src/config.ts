/**
 * Centralized configuration parsing and validation.
 *
 * All environment variables are parsed and validated once at startup.
 * Invalid values cause the process to exit immediately with a clear error message.
 */

import { resolveDatabaseUrl } from '@lumina/shared';
import { subsystem } from './logger';
import { retentionWindowConflicts, RETENTION_TABLES, unlimitedRetentionWindows, type RetentionWindows } from './retention';

const log = subsystem('config');

/** Validated indexer settings resolved from environment variables and defaults. */
export interface Config {
  horizonUrl: string;
  horizonAuthToken: string | undefined;
  horizonMinRequestIntervalMs: number;
  horizonMaxRequestIntervalMs: number;
  horizonTipWeightFactor: number;
  databaseUrl: string;
  pollIntervalMs: number;
  startLedger: number | undefined;
  backfillStartLedger: number | undefined;
  backfillEndLedger: number | undefined;
  /**
   * Maximum connections in the write pool (ledger indexing, events, trades,
   * retries, retention). `DB_POOL_MAX` remains the shared fallback for both
   * pools; unset on either level falls through to pg's default of 10.
   */
  dbWritePoolMax: number | undefined;
  /** Maximum connections in the read pool (gap scans, cursor probes, schema loads). */
  dbReadPoolMax: number | undefined;
  dbPoolIdleTimeoutMs: number | undefined;
  dbPoolConnectionTimeoutMs: number | undefined;
  sorobanRpcUrl: string | undefined;
  indexedContractIds: string[];
  /** Seed LedgerKey XDRs (base64) to poll contract storage for, before any are discovered. */
  indexedContractStorageKeys: string[];
  /**
   * Flat default registry, inherited by every network that does not set its
   * own. The per-network resolution that consumes these lives in
   * `registry.ts` (`resolveRegistryConfigs`).
   */
  registryContractId: string | undefined;
  registryReadAccount: string | undefined;
  /**
   * Overrides the passphrase used for every registry read.
   *
   * Unset by default: the passphrase a simulated registry read needs is the one
   * of the network the registry is deployed on, so it comes from that network's
   * configuration. A value here is the exception — a deployment whose registry
   * does not live on the network it is registered under.
   */
  registryNetworkPassphrase: string | undefined;
  registryPollIntervalMs: number;
  healthPort: number;
  ledgerRetryAttempts: number;
  ledgerRetryBaseMs: number;
  /** Freshness window for a network's cached account data, reducing repeat Horizon requests. */
  accountCacheTtlMs: number;
  /** Hard cap on cached accounts, bounding memory use when many addresses are observed. */
  accountCacheMaxSize: number;
  /** Re-scan this many recent ledgers because event visibility can lag the reported RPC tip. */
  eventsSafetyLagLedgers: number;
  sorobanMinRequestIntervalMs: number;
  /** Bounds event-processing work per poll cycle so a busy range cannot monopolize the indexer loop. */
  sorobanMaxEventsPerCycle: number;
  /** How far back Soroban RPC event requests may look; distinct from database retention. */
  sorobanRetentionWindowLedgers: number;
  /**
   * Per-table retention windows in days of chain time; `0` keeps everything.
   * Defaults to unlimited for every table so nothing is deleted until an
   * operator opts in. Distinct from `sorobanRetentionWindowLedgers`, which is
   * how far back the Soroban RPC can still serve events, not how long we keep
   * what we already indexed.
   */
  retentionWindows: RetentionWindows;
  /** How often the pruning job runs. */
  retentionPruneIntervalMs: number;
  /** Rows deleted per batch, bounding how much work one prune statement does. */
  retentionPruneBatchSize: number;
}

/**
 * Parses an optional string environment variable.
 */
function optionalString(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return undefined;
  }
  return value;
}

/**
 * Parses an optional integer environment variable with validation.
 */
function optionalInt(name: string, min?: number, max?: number): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    log.fatal({ envVar: name, value }, `Configuration error: ${name} must be a valid integer if set, got "${value}"`);
    process.exit(1);
  }
  if (min !== undefined && parsed < min) {
    log.fatal({ envVar: name, value: parsed, min }, `Configuration error: ${name} must be at least ${min} if set, got ${parsed}`);
    process.exit(1);
  }
  if (max !== undefined && parsed > max) {
    log.fatal({ envVar: name, value: parsed, max }, `Configuration error: ${name} must be at most ${max} if set, got ${parsed}`);
    process.exit(1);
  }
  return parsed;
}

/**
 * Parses an integer with a default value.
 */
function intWithDefault(name: string, defaultValue: number, min?: number, max?: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    log.fatal({ envVar: name, value }, `Configuration error: ${name} must be a valid integer, got "${value}"`);
    process.exit(1);
  }
  if (min !== undefined && parsed < min) {
    log.fatal({ envVar: name, value: parsed, min }, `Configuration error: ${name} must be at least ${min}, got ${parsed}`);
    process.exit(1);
  }
  if (max !== undefined && parsed > max) {
    log.fatal({ envVar: name, value: parsed, max }, `Configuration error: ${name} must be at most ${max}, got ${parsed}`);
    process.exit(1);
  }
  return parsed;
}

/**
 * Parses a string with a default value.
 */
function stringWithDefault(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value;
}

/**
 * The database URL from `DATABASE_URL_FILE`, `DATABASE_URL` and
 * `DATABASE_PASSWORD_FILE`; see docs/SECRETS.md.
 */
function databaseUrlWithDefault(defaultValue: string): string {
  try {
    return resolveDatabaseUrl('DATABASE_URL') ?? defaultValue;
  } catch (err) {
    log.fatal(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Redacts the password from a database URL for logging.
 */
function redactDatabaseUrl(url: string): string {
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

/**
 * Derives the environment variable for a table's retention window, e.g.
 * `RETENTION_OPERATIONS_DAYS`. Deriving it from the table name ensures a newly
 * prunable table cannot be left without a corresponding setting.
 */
export function retentionEnvVar(table: string): string {
  return `RETENTION_${table.toUpperCase()}_DAYS`;
}

/**
 * Parses every `RETENTION_<TABLE>_DAYS` variable into a per-table window map.
 *
 * Every table defaults to 0 days (unlimited). A window is a number of days of
 * *chain* time, and 0 is the only value that means "keep everything" — there
 * is no separate "enabled" flag, because a flag that can disagree with a
 * window is one more thing to get wrong.
 */
export function parseRetentionWindows(): RetentionWindows {
  const windows = unlimitedRetentionWindows();
  for (const table of RETENTION_TABLES) {
    windows[table] = intWithDefault(retentionEnvVar(table), 0, 0);
  }
  return windows;
}

/**
 * Parses and validates all configuration.
 * Throws an error and exits if any configuration is invalid.
 */
export function loadConfig(): Config {
  // DB_POOL_MAX remains the shared fallback for both pools: a deployment that
  // sets only it keeps its existing sizing, while DB_WRITE_POOL_MAX and
  // DB_READ_POOL_MAX let each pool be sized on its own.
  const sharedPoolMax = optionalInt('DB_POOL_MAX', 1);
  const config: Config = {
    horizonUrl: stringWithDefault('HORIZON_URL', 'https://horizon.stellar.org'),
    horizonAuthToken: optionalString('HORIZON_AUTH_TOKEN'),
    horizonMinRequestIntervalMs: intWithDefault('HORIZON_MIN_REQUEST_INTERVAL_MS', 100, 1),
    horizonMaxRequestIntervalMs: intWithDefault('HORIZON_MAX_REQUEST_INTERVAL_MS', 10000, 1),
    horizonTipWeightFactor: intWithDefault('HORIZON_TIP_WEIGHT_FACTOR', 2, 1),
    databaseUrl: databaseUrlWithDefault('postgresql://localhost:5432/lumina'),
    pollIntervalMs: intWithDefault('POLL_INTERVAL_MS', 5000, 100),
    startLedger: optionalInt('START_LEDGER', 1),
    backfillStartLedger: optionalInt('BACKFILL_START_LEDGER', 1),
    backfillEndLedger: optionalInt('BACKFILL_END_LEDGER', 1),
    dbWritePoolMax: optionalInt('DB_WRITE_POOL_MAX', 1) ?? sharedPoolMax,
    dbReadPoolMax: optionalInt('DB_READ_POOL_MAX', 1) ?? sharedPoolMax,
    dbPoolIdleTimeoutMs: optionalInt('DB_POOL_IDLE_TIMEOUT', 1000),
    dbPoolConnectionTimeoutMs: optionalInt('DB_POOL_CONNECTION_TIMEOUT', 0),
    sorobanRpcUrl: optionalString('SOROBAN_RPC_URL'),
    indexedContractIds: (process.env['INDEXED_CONTRACT_IDS'] ?? '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean),
    indexedContractStorageKeys: (process.env['INDEXED_CONTRACT_STORAGE_KEYS'] ?? '')
      .split(',')
      .map(key => key.trim())
      .filter(Boolean),
    registryContractId: optionalString('REGISTRY_CONTRACT_ID'),
    registryReadAccount: optionalString('REGISTRY_READ_ACCOUNT'),
    registryNetworkPassphrase: optionalString('REGISTRY_NETWORK_PASSPHRASE'),
    // Registry reads are independent of the faster ledger poll; a minute keeps
    // discovery reasonably fresh without repeatedly querying registry state.
    registryPollIntervalMs: intWithDefault('REGISTRY_POLL_INTERVAL_MS', 60_000, 1000),
    healthPort: intWithDefault('HEALTH_PORT', 9090, 1, 65535),
    // Retry policy for a ledger whose fetch/index fails. More attempts ride
    // out longer Horizon outages but hold the cursor back while they retry;
    // the gap between attempts is LEDGER_RETRY_BASE_MS * 2^(attempt - 1), so
    // the base also sets the maximum wait. Both are deployment decisions —
    // see the indexer environment-variable table in the README.
    ledgerRetryAttempts: intWithDefault('LEDGER_RETRY_ATTEMPTS', 3, 1),
    ledgerRetryBaseMs: intWithDefault('LEDGER_RETRY_BASE_MS', 500, 1),
    // A five-minute freshness window avoids repeatedly fetching busy accounts
    // every poll; the per-network cache and size cap bound the stale-data cost.
    accountCacheTtlMs: intWithDefault('ACCOUNT_CACHE_TTL_MS', 5 * 60 * 1000, 1),
    // The hard cap complements the TTL: a long-running process cannot retain
    // an unbounded number of one-off addresses.
    accountCacheMaxSize: 50_000,
    // A short overlap is cheap to re-scan and avoids permanently skipping
    // events that become visible after the RPC has reported its latest ledger.
    eventsSafetyLagLedgers: 3,
    // Bound per-cycle work so a busy event range cannot stall other indexer work.
    sorobanMinRequestIntervalMs: intWithDefault('SOROBAN_MIN_REQUEST_INTERVAL_MS', 100, 1),
    sorobanMaxEventsPerCycle: intWithDefault('SOROBAN_MAX_EVENTS_PER_CYCLE', 5000, 100),
    // Provider event-history availability varies; keep the default request
    // window bounded and let operators widen it to match their provider.
    sorobanRetentionWindowLedgers: intWithDefault('SOROBAN_RETENTION_WINDOW_LEDGERS', 300_000, 1),
    retentionWindows: parseRetentionWindows(),
    // Once an hour by default: long enough that the pass is not itself a load
    // source, short enough that a window is honoured well within its own
    // resolution. Retention is a coarse control, not a latency-sensitive one.
    retentionPruneIntervalMs: intWithDefault('RETENTION_PRUNE_INTERVAL_MS', 60 * 60 * 1000, 1000),
    retentionPruneBatchSize: intWithDefault('RETENTION_PRUNE_BATCH_SIZE', 10_000, 1),
  };

  // A window that outruns the foreign keys pointing at it cannot be honoured:
  // the delete would fail on the constraint on every round, so the window would
  // look configured, log nothing, and never delete a row. Rejected at startup so
  // that is a visible misconfiguration rather than a mystery. (The other
  // direction is fine — deleting a child never depends on its parent, so a
  // transaction window with ledgers kept forever is a valid, useful choice.)
  const retentionConflicts = retentionWindowConflicts(config.retentionWindows);
  if (retentionConflicts.length > 0) {
    for (const problem of retentionConflicts) {
      log.fatal({ retentionWindows: config.retentionWindows }, `Configuration error: ${problem}`);
    }
    process.exit(1);
  }

  // Validate that if registry is configured, all required fields are present
  if (config.registryContractId && !config.sorobanRpcUrl) {
    log.fatal(
      { registryContractId: config.registryContractId },
      'Configuration error: REGISTRY_CONTRACT_ID is set but SOROBAN_RPC_URL is not'
    );
    process.exit(1);
  }
  if (config.registryContractId && !config.registryReadAccount) {
    log.fatal(
      { registryContractId: config.registryContractId },
      'Configuration error: REGISTRY_CONTRACT_ID is set but REGISTRY_READ_ACCOUNT is not'
    );
    process.exit(1);
  }

  // Validate that if contract IDs are specified, Soroban RPC is configured
  if (config.indexedContractIds.length > 0 && !config.sorobanRpcUrl) {
    log.fatal(
      { contractIds: config.indexedContractIds },
      'Configuration error: INDEXED_CONTRACT_IDS is set but SOROBAN_RPC_URL is not'
    );
    process.exit(1);
  }

  // Validate backfill range if configured
  if (config.backfillStartLedger !== undefined && config.backfillEndLedger !== undefined) {
    if (config.backfillStartLedger > config.backfillEndLedger) {
      log.fatal(
        { startLedger: config.backfillStartLedger, endLedger: config.backfillEndLedger },
        'Configuration error: BACKFILL_START_LEDGER must be <= BACKFILL_END_LEDGER'
      );
      process.exit(1);
    }
  }

  // Log the resolved configuration with sensitive data redacted
  log.info(
    {
      horizonUrl: config.horizonUrl,
      horizonAuthToken: config.horizonAuthToken ? '***' : undefined,
      horizonMinRequestIntervalMs: config.horizonMinRequestIntervalMs,
      horizonMaxRequestIntervalMs: config.horizonMaxRequestIntervalMs,
      horizonTipWeightFactor: config.horizonTipWeightFactor,
      databaseUrl: redactDatabaseUrl(config.databaseUrl),
      pollIntervalMs: config.pollIntervalMs,
      startLedger: config.startLedger,
      backfillStartLedger: config.backfillStartLedger,
      backfillEndLedger: config.backfillEndLedger,
      dbWritePoolMax: config.dbWritePoolMax,
      dbReadPoolMax: config.dbReadPoolMax,
      dbPoolIdleTimeoutMs: config.dbPoolIdleTimeoutMs,
      dbPoolConnectionTimeoutMs: config.dbPoolConnectionTimeoutMs,
      sorobanRpcUrl: config.sorobanRpcUrl,
      indexedContractIds: config.indexedContractIds,
      indexedContractStorageKeys: config.indexedContractStorageKeys,
      registryContractId: config.registryContractId,
      registryReadAccount: config.registryReadAccount,
      registryNetworkPassphrase: config.registryNetworkPassphrase,
      registryPollIntervalMs: config.registryPollIntervalMs,
      healthPort: config.healthPort,
      ledgerRetryAttempts: config.ledgerRetryAttempts,
      ledgerRetryBaseMs: config.ledgerRetryBaseMs,
      accountCacheTtlMs: config.accountCacheTtlMs,
      accountCacheMaxSize: config.accountCacheMaxSize,
      eventsSafetyLagLedgers: config.eventsSafetyLagLedgers,
      sorobanMinRequestIntervalMs: config.sorobanMinRequestIntervalMs,
      sorobanMaxEventsPerCycle: config.sorobanMaxEventsPerCycle,
      sorobanRetentionWindowLedgers: config.sorobanRetentionWindowLedgers,
      retentionWindows: config.retentionWindows,
      retentionPruneIntervalMs: config.retentionPruneIntervalMs,
      retentionPruneBatchSize: config.retentionPruneBatchSize,
    },
    'configuration loaded'
  );

  return config;
}
