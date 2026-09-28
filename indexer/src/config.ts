/**
 * Centralized configuration parsing and validation.
 *
 * All environment variables are parsed and validated once at startup.
 * Invalid values cause the process to exit immediately with a clear error message.
 */

import { Networks } from '@stellar/stellar-sdk';
import { subsystem } from './logger';
import { RETENTION_TABLES, unlimitedRetentionWindows, type RetentionWindows } from './retention';

const log = subsystem('config');

export interface Config {
  horizonUrl: string;
  horizonAuthToken: string | undefined;
  horizonMinRequestIntervalMs: number;
  horizonMaxRequestIntervalMs: number;
  horizonTipWeightFactor: number;
  databaseUrl: string;
  pollIntervalMs: number;
  startLedger: number | undefined;
  dbPoolMax: number | undefined;
  dbPoolIdleTimeoutMs: number | undefined;
  dbPoolConnectionTimeoutMs: number | undefined;
  sorobanRpcUrl: string | undefined;
  indexedContractIds: string[];
  /** Seed LedgerKey XDRs (base64) to poll contract storage for, before any are discovered. */
  indexedContractStorageKeys: string[];
  registryContractId: string | undefined;
  registryReadAccount: string | undefined;
  registryNetworkPassphrase: string;
  registryPollIntervalMs: number;
  healthPort: number;
  ledgerRetryAttempts: number;
  ledgerRetryBaseMs: number;
  accountCacheTtlMs: number;
  accountCacheMaxSize: number;
  eventsSafetyLagLedgers: number;
  sorobanMinRequestIntervalMs: number;
  sorobanMaxEventsPerCycle: number;
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
 * Env var holding a table's retention window, e.g. `RETENTION_OPERATIONS_DAYS`.
 * Derived from the table name rather than repeated, so adding a prunable table
 * to retention.ts cannot leave it without a way to configure.
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
  const config: Config = {
    horizonUrl: stringWithDefault('HORIZON_URL', 'https://horizon.stellar.org'),
    horizonAuthToken: optionalString('HORIZON_AUTH_TOKEN'),
    horizonMinRequestIntervalMs: intWithDefault('HORIZON_MIN_REQUEST_INTERVAL_MS', 100, 1),
    horizonMaxRequestIntervalMs: intWithDefault('HORIZON_MAX_REQUEST_INTERVAL_MS', 10000, 1),
    horizonTipWeightFactor: intWithDefault('HORIZON_TIP_WEIGHT_FACTOR', 2, 1),
    databaseUrl: stringWithDefault('DATABASE_URL', 'postgresql://localhost:5432/lumina'),
    pollIntervalMs: intWithDefault('POLL_INTERVAL_MS', 5000, 100),
    startLedger: optionalInt('START_LEDGER', 1),
    dbPoolMax: optionalInt('DB_POOL_MAX', 1),
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
    registryNetworkPassphrase: stringWithDefault('REGISTRY_NETWORK_PASSPHRASE', Networks.TESTNET),
    registryPollIntervalMs: intWithDefault('REGISTRY_POLL_INTERVAL_MS', 60_000, 1000),
    healthPort: intWithDefault('HEALTH_PORT', 9090, 1, 65535),
    // Retry policy for a ledger whose fetch/index fails. More attempts ride
    // out longer Horizon outages but hold the cursor back while they retry;
    // the gap between attempts is LEDGER_RETRY_BASE_MS * 2^(attempt - 1), so
    // the base also sets the maximum wait. Both are deployment decisions —
    // see the indexer environment-variable table in the README.
    ledgerRetryAttempts: intWithDefault('LEDGER_RETRY_ATTEMPTS', 3, 1),
    ledgerRetryBaseMs: intWithDefault('LEDGER_RETRY_BASE_MS', 500, 1),
    accountCacheTtlMs: intWithDefault('ACCOUNT_CACHE_TTL_MS', 5 * 60 * 1000, 1),
    accountCacheMaxSize: 50_000,
    eventsSafetyLagLedgers: 3,
    sorobanMinRequestIntervalMs: intWithDefault('SOROBAN_MIN_REQUEST_INTERVAL_MS', 100, 1),
    sorobanMaxEventsPerCycle: intWithDefault('SOROBAN_MAX_EVENTS_PER_CYCLE', 5000, 100),
    sorobanRetentionWindowLedgers: intWithDefault('SOROBAN_RETENTION_WINDOW_LEDGERS', 300_000, 1),
    retentionWindows: parseRetentionWindows(),
    // Once an hour by default: long enough that the pass is not itself a load
    // source, short enough that a window is honoured well within its own
    // resolution. Retention is a coarse control, not a latency-sensitive one.
    retentionPruneIntervalMs: intWithDefault('RETENTION_PRUNE_INTERVAL_MS', 60 * 60 * 1000, 1000),
    retentionPruneBatchSize: intWithDefault('RETENTION_PRUNE_BATCH_SIZE', 10_000, 1),
  };

  // A transaction retained but not its ledger is a row the API can no longer
  // reach (a transaction query walks to its ledger), and the reverse — a
  // ledger retained with no transactions — is harmless. So `transactions`
  // cannot outlive `ledgers`: a longer window on the child is silently
  // narrowed to the parent's, and saying so at startup beats discovering it
  // from an unexplained row count.
  if (config.retentionWindows.transactions > 0 && config.retentionWindows.ledgers === 0) {
    log.warn(
      { transactions: config.retentionWindows.transactions, ledgers: 0 },
      'RETENTION_TRANSACTIONS_DAYS is set but RETENTION_LEDGERS_DAYS is not; ledgers are kept forever, so the transaction window only takes effect once a ledger window is also set'
    );
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
      dbPoolMax: config.dbPoolMax,
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
