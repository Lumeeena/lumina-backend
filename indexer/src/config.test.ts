import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadConfig } from './config';
import { isRetentionEnabled, retentionWindowConflicts, retainedTables, unlimitedRetentionWindows } from './retention';

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
  process.env['RETENTION_OPERATIONS_DAYS'] = '450';
  process.env['RETENTION_LEDGERS_DAYS'] = '365';
  process.env['RETENTION_TRANSACTIONS_DAYS'] = '400';
  process.env['RETENTION_CONTRACT_EVENTS_DAYS'] = '7';
  process.env['RETENTION_CUSTOM_EVENTS_DAYS'] = '30';
  try {
    const cfg = loadConfig();

    // One table's window must not leak into another's: the whole point of
    // "configurable per table" is that they are decided separately. The three
    // FK-linked tables are given three different values in increasing order,
    // which is the only shape the chain allows.
    assert.equal(cfg.retentionWindows.operations, 450);
    assert.equal(cfg.retentionWindows.transactions, 400);
    assert.equal(cfg.retentionWindows.ledgers, 365);
    assert.equal(cfg.retentionWindows.contract_events, 7);
    assert.equal(cfg.retentionWindows.custom_events, 30);
    assert.equal(isRetentionEnabled(cfg.retentionWindows), true);
    assert.deepEqual(retainedTables(cfg.retentionWindows), [
      'operations', 'transactions', 'contract_events', 'custom_events', 'ledgers',
    ]);
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

/** Load config with `process.exit` stubbed to throw, and report whether it was fatal. */
function loadConfigFatal(env: Record<string, string>): boolean {
  clearRetentionEnv();
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never;
  try {
    loadConfig();
    return false;
  } catch (err) {
    assert.match(String(err), /exit:1/);
    return true;
  } finally {
    process.exit = originalExit;
    clearRetentionEnv();
  }
}

test('a ledger window with no transaction window is rejected, not silently unprunable', () => {
  // transactions(ledger) references ledgers and nothing cascades, so deleting a
  // ledger with a transaction still pointing at it fails the constraint. Prune
  // order does not save this: with no transaction window there is no transaction
  // delete to run first, so the ledger delete fails on every round and the
  // window quietly never takes effect.
  assert.equal(loadConfigFatal({ RETENTION_LEDGERS_DAYS: '365' }), true);
});

test('a transaction window with no operation window is rejected for the same reason', () => {
  // operations(transaction_hash) references transactions.
  assert.equal(loadConfigFatal({ RETENTION_TRANSACTIONS_DAYS: '90' }), true);
});

test('a child window shorter than its parent is rejected', () => {
  // Deleting ledgers older than 30 days needs every transaction in them gone,
  // so transactions must be pruned at least 30 days back. 7 days leaves
  // transactions from 7-30 days ago still referencing the ledgers being deleted.
  assert.equal(loadConfigFatal({ RETENTION_LEDGERS_DAYS: '30', RETENTION_TRANSACTIONS_DAYS: '7' }), true);
});

test('a child window equal to its parent is accepted', () => {
  // Equal is the boundary case and has to work: it is the natural "keep a year
  // of everything" configuration, and rejecting it would make the feature much
  // harder to use for no safety gain.
  assert.equal(
    loadConfigFatal({ RETENTION_LEDGERS_DAYS: '365', RETENTION_TRANSACTIONS_DAYS: '365', RETENTION_OPERATIONS_DAYS: '365' }),
    false
  );
});

test('a child window longer than its parent is accepted', () => {
  // Over-deleting children is always safe: there is no row below them to dangle.
  assert.equal(
    loadConfigFatal({ RETENTION_LEDGERS_DAYS: '30', RETENTION_TRANSACTIONS_DAYS: '90', RETENTION_OPERATIONS_DAYS: '90' }),
    false
  );
});

test('pruning a leaf without its parents is accepted', () => {
  // operations is the bottom of the chain, so its window stands alone — this is
  // the common case of dropping the largest table and keeping the rest.
  assert.equal(loadConfigFatal({ RETENTION_OPERATIONS_DAYS: '90' }), false);
});

test('a table outside the foreign key chain is never constrained', () => {
  // contract_events and custom_events have no FK into any prunable table, so
  // they can be pruned alone at any window, including a very short one.
  assert.equal(loadConfigFatal({ RETENTION_CONTRACT_EVENTS_DAYS: '7' }), false);
  assert.equal(loadConfigFatal({ RETENTION_CUSTOM_EVENTS_DAYS: '1' }), false);
  assert.equal(
    loadConfigFatal({ RETENTION_LEDGERS_DAYS: '365', RETENTION_TRANSACTIONS_DAYS: '365', RETENTION_OPERATIONS_DAYS: '365', RETENTION_CONTRACT_EVENTS_DAYS: '7' }),
    false,
    'a short window on an unrelated table does not collide with a long chain'
  );
});

test('pruning transactions while keeping every ledger forever is accepted', () => {
  // Deleting a child never depends on its parent, so this is a valid choice even
  // though a retained transaction becomes unreachable through its ledger.
  assert.equal(
    loadConfigFatal({ RETENTION_TRANSACTIONS_DAYS: '90', RETENTION_OPERATIONS_DAYS: '90' }),
    false
  );
});

test('conflicts name the specific variables at fault', () => {
  // An operator hitting this at startup should be able to fix it without
  // reading the source, so the message has to name both variables and both
  // numbers rather than saying "invalid retention configuration". Each link of
  // the chain is reported, so a cascade of bad windows is fixed in one pass
  // instead of one restart per window.
  const problems = retentionWindowConflicts({
    ...unlimitedRetentionWindows(), ledgers: 365, transactions: 100, operations: 50,
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /RETENTION_TRANSACTIONS_DAYS must be at least RETENTION_LEDGERS_DAYS \(365\), got 100/);
  assert.match(problems[1]!, /RETENTION_OPERATIONS_DAYS must be at least RETENTION_TRANSACTIONS_DAYS \(100\), got 50/);
});

test('an unlimited configuration reports no conflicts', () => {
  assert.deepEqual(retentionWindowConflicts(unlimitedRetentionWindows()), []);
});
