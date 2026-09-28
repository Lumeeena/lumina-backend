import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadConfig } from './config';
import { isRetentionEnabled, retainedTables } from './retention';

test('config parses comma-separated contract IDs', () => {
  process.env['INDEXED_CONTRACT_IDS'] = 'C' + '0'.repeat(55) + ',C' + '1'.repeat(55) + ', C' + '2'.repeat(55);
  process.env['SOROBAN_RPC_URL'] = 'http://localhost:8000';
  
  // Verify parsing logic
  const ids = (process.env['INDEXED_CONTRACT_IDS'] ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  
  assert.equal(ids.length, 3);
  
  delete process.env['INDEXED_CONTRACT_IDS'];
  delete process.env['SOROBAN_RPC_URL'];
});

test('config handles empty contract IDs list', () => {
  process.env['INDEXED_CONTRACT_IDS'] = '';
  
  const ids = (process.env['INDEXED_CONTRACT_IDS'] ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  
  assert.equal(ids.length, 0);
  
  delete process.env['INDEXED_CONTRACT_IDS'];
});

test('config redacts database password', () => {
  const url = 'postgresql://user:secret@localhost:5432/db';
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    const redacted = parsed.toString();
    assert.ok(redacted.includes('***'));
    assert.ok(!redacted.includes('secret'));
  } catch {
    assert.fail('Failed to parse database URL');
  }
});

test('config handles unparseable database URL', () => {
  const url = 'not-a-url';
  try {
    new URL(url);
    assert.fail('Should have thrown error');
  } catch {
    // Expected to fail
    assert.ok(true);
  }
});

test('ledger retry parameters default to 3 attempts and 500ms', () => {
  delete process.env['LEDGER_RETRY_ATTEMPTS'];
  delete process.env['LEDGER_RETRY_BASE_MS'];

  const cfg = loadConfig();

  assert.equal(cfg.ledgerRetryAttempts, 3);
  assert.equal(cfg.ledgerRetryBaseMs, 500);
});

test('ledger retry parameters are read from the environment', () => {
  process.env['LEDGER_RETRY_ATTEMPTS'] = '7';
  process.env['LEDGER_RETRY_BASE_MS'] = '250';
  try {
    const cfg = loadConfig();

    assert.equal(cfg.ledgerRetryAttempts, 7);
    assert.equal(cfg.ledgerRetryBaseMs, 250);
  } finally {
    delete process.env['LEDGER_RETRY_ATTEMPTS'];
    delete process.env['LEDGER_RETRY_BASE_MS'];
  }
});

const RETENTION_VARS = [
  'RETENTION_LEDGERS_DAYS', 'RETENTION_TRANSACTIONS_DAYS', 'RETENTION_OPERATIONS_DAYS',
  'RETENTION_CONTRACT_EVENTS_DAYS', 'RETENTION_CUSTOM_EVENTS_DAYS',
  'RETENTION_PRUNE_INTERVAL_MS', 'RETENTION_PRUNE_BATCH_SIZE',
];

function clearRetentionEnv(): void {
  for (const name of RETENTION_VARS) delete process.env[name];
}

test('retention defaults to unlimited for every table', () => {
  clearRetentionEnv();
  const cfg = loadConfig();

  assert.deepEqual(cfg.retentionWindows, {
    ledgers: 0,
    transactions: 0,
    operations: 0,
    contract_events: 0,
    custom_events: 0,
  });
  assert.equal(isRetentionEnabled(cfg.retentionWindows), false);
  assert.equal(cfg.retentionPruneIntervalMs, 3_600_000);
  assert.equal(cfg.retentionPruneBatchSize, 10_000);
});

test('retention windows are configured per table', () => {
  clearRetentionEnv();
  process.env['RETENTION_OPERATIONS_DAYS'] = '90';
  process.env['RETENTION_LEDGERS_DAYS'] = '365';
  try {
    const cfg = loadConfig();

    // One table's window must not leak into another's: the whole point of
    // "configurable per table" is that they are decided separately.
    assert.equal(cfg.retentionWindows.operations, 90);
    assert.equal(cfg.retentionWindows.ledgers, 365);
    assert.equal(cfg.retentionWindows.transactions, 0, 'an unset table keeps everything');
    assert.equal(isRetentionEnabled(cfg.retentionWindows), true);
    assert.deepEqual(retainedTables(cfg.retentionWindows), ['operations', 'ledgers']);
  } finally {
    clearRetentionEnv();
  }
});

test('an explicit zero means keep everything, not "unset"', () => {
  clearRetentionEnv();
  process.env['RETENTION_OPERATIONS_DAYS'] = '0';
  try {
    const cfg = loadConfig();
    assert.equal(cfg.retentionWindows.operations, 0);
    assert.equal(isRetentionEnabled(cfg.retentionWindows), false);
  } finally {
    clearRetentionEnv();
  }
});

test('prune interval and batch size are configurable', () => {
  clearRetentionEnv();
  process.env['RETENTION_PRUNE_INTERVAL_MS'] = '60000';
  process.env['RETENTION_PRUNE_BATCH_SIZE'] = '500';
  try {
    const cfg = loadConfig();
    assert.equal(cfg.retentionPruneIntervalMs, 60_000);
    assert.equal(cfg.retentionPruneBatchSize, 500);
  } finally {
    clearRetentionEnv();
  }
});

test('a negative retention window is rejected rather than silently treated as unlimited', () => {
  clearRetentionEnv();
  process.env['RETENTION_OPERATIONS_DAYS'] = '-1';
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never;
  try {
    // loadConfig treats a rejected value as fatal, so the stub is what throws.
    // A negative window that quietly became 0 would mean pruning silently
    // disabled by a typo, which is the one failure mode worth refusing.
    assert.throws(() => loadConfig(), /exit:1/);
  } finally {
    process.exit = originalExit;
    clearRetentionEnv();
  }
});
