/**
 * Centralized configuration parsing and validation.
 *
 * All environment variables are parsed and validated once at startup.
 * Invalid values cause the process to exit immediately with a clear error message.
 */

import { Networks } from '@stellar/stellar-sdk';
import { subsystem } from './logger';

const log = subsystem('config');

export interface Config {
  horizonUrl: string;
  databaseUrl: string;
  pollIntervalMs: number;
  startLedger: number | undefined;
  dbPoolMax: number | undefined;
  dbPoolIdleTimeoutMs: number | undefined;
  dbPoolConnectionTimeoutMs: number | undefined;
  sorobanRpcUrl: string | undefined;
  indexedContractIds: string[];
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
 * Parses and validates all configuration.
 * Throws an error and exits if any configuration is invalid.
 */
export function loadConfig(): Config {
  const config: Config = {
    horizonUrl: stringWithDefault('HORIZON_URL', 'https://horizon.stellar.org'),
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
    registryContractId: optionalString('REGISTRY_CONTRACT_ID'),
    registryReadAccount: optionalString('REGISTRY_READ_ACCOUNT'),
    registryNetworkPassphrase: stringWithDefault('REGISTRY_NETWORK_PASSPHRASE', Networks.TESTNET),
    registryPollIntervalMs: intWithDefault('REGISTRY_POLL_INTERVAL_MS', 60_000, 1000),
    healthPort: intWithDefault('HEALTH_PORT', 9090, 1, 65535),
    ledgerRetryAttempts: 3,
    ledgerRetryBaseMs: 500,
    accountCacheTtlMs: 5 * 60 * 1000,
    accountCacheMaxSize: 50_000,
    eventsSafetyLagLedgers: 3,
  };

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
      databaseUrl: redactDatabaseUrl(config.databaseUrl),
      pollIntervalMs: config.pollIntervalMs,
      startLedger: config.startLedger,
      dbPoolMax: config.dbPoolMax,
      dbPoolIdleTimeoutMs: config.dbPoolIdleTimeoutMs,
      dbPoolConnectionTimeoutMs: config.dbPoolConnectionTimeoutMs,
      sorobanRpcUrl: config.sorobanRpcUrl,
      indexedContractIds: config.indexedContractIds,
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
    },
    'configuration loaded'
  );

  return config;
}
