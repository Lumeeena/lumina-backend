import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import {
  isMigrationIrreversible,
  loadDownMigrations,
  loadMigrations,
  migrationStatus,
  rollbackLastMigration,
  rollbackMigration,
  runMigrations,
  splitStatements,
  type Migration,
} from './migrations';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

// Existing versions are immutable because schema_migrations stores their full filename stem.
// New migrations must use a UTC timestamp prefix (YYYYMMDDHHMMSS) to avoid collisions.
const LEGACY_MIGRATIONS = [
  '001_init', '002_account_event_columns', '003_custom_event_schemas',
  '004_search_indexes', '005_api_keys', '006_autovacuum', '006_export_permissions',
  '006_partition_operations', '007_drop_redundant_api_key_index', '007_networks',
  '008_account_refresh_queue', '008_accounts_listing_index', '008_data_constraints',
  '008_retry_queue', '009_contract_storage_entries', '010_contract_storage_history',
  '010_retention_prune_indexes', '010_transaction_filters', '010_trustlines',
  '011_assets', '012_asset_volume_buckets', '013_backfill_progress', '013_export_jobs',
  '013_failed_ledgers', '013_trades', '013_trustline_changes', '014_pools_claims_paths_signers',
  '015_admin_operations', '015_asset_issuer_metadata', '015_drop_unused_trustline_indexes',
  '015_operation_decoding', '015_retry_queue_network_index', '015_transactions_listing_covering_index',
  '016_assets_index_review', '016_event_transaction_context', '017_account_state_history',
  '017_signers_sponsorship_contracts_rollups', '018_dead_letters_and_cursors',
  '019_operations_index_review', '020_claimable_balances_listing', '020_effects',
  '021_ledger_audit_window_index',
];

function assertMigrationPrefixPolicy(versions: string[]): void {
  const legacy = new Set(LEGACY_MIGRATIONS);
  const groups = new Map<string, string[]>();
  for (const version of versions) {
    const prefix = version.match(/^(\d+)_/)?.[1];
    assert.ok(prefix, `migration has a numeric prefix: ${version}`);
    groups.set(prefix, [...(groups.get(prefix) ?? []), version]);
  }
  for (const [prefix, group] of groups) {
    if (group.length > 1) {
      assert.ok(group.every(version => legacy.has(version)), `new migration reuses prefix ${prefix}: ${group.join(', ')}`);
    }
  }
  for (const version of versions.filter(version => !legacy.has(version))) {
    assert.match(version, /^\d{14}_[a-z0-9_-]+$/i, `${version} must use a UTC timestamp prefix`);
  }
}

test('loads migrations in order and expands initial schema include', () => {
  const migrations = loadMigrations(MIGRATIONS_DIR);
  assert.deepEqual(migrations.map(migration => migration.version), LEGACY_MIGRATIONS);
  assert.match(migrations[0].sql, /CREATE TABLE IF NOT EXISTS ledgers/);
  assert.match(migrations[0].sql, /PRIMARY KEY \(id, network\)/);
  assert.doesNotMatch(migrations[0].sql, /^\\ir/m);

  const networks = migrations.find(migration => migration.version === '007_networks');
  assert.ok(networks);
  assert.match(networks?.sql, /ALTER TABLE operations ADD PRIMARY KEY \(id, network\)/);
  assert.doesNotMatch(networks?.sql, /ADD PRIMARY KEY \(id, ledger, network\)/);
  assert.match(networks?.sql, /FOREIGN KEY \(transaction_hash, network\) REFERENCES transactions \(hash, network\)/);

  const placeholderCleanup = migrations.find(migration => migration.version === '023_remove_placeholder_contract_interfaces');
  assert.ok(placeholderCleanup);
  assert.match(placeholderCleanup?.sql ?? '', /DELETE FROM contract_interfaces/);
  assert.match(placeholderCleanup?.sql ?? '', /"placeholder"/);
  const idempotency = migrations.find(migration => migration.version === '024_operation_effect_idempotency');
  assert.ok(idempotency);
  assert.match(idempotency?.sql ?? '', /processed_operation_handlers/);
  assert.match(idempotency?.sql ?? '', /dead_letter_operations/);
});

test('new migrations use unique UTC timestamp prefixes; legacy collisions stay grandfathered', () => {
  const versions = loadMigrations(MIGRATIONS_DIR).map(migration => migration.version);
  assert.doesNotThrow(() => assertMigrationPrefixPolicy(versions));
  assert.throws(
    () => assertMigrationPrefixPolicy([...versions, '008_new_retry_table']),
    /new migration reuses prefix 008/
  );
  const timestamped = '20261119120000_new_retry_table';
  assert.doesNotThrow(() => assertMigrationPrefixPolicy([...versions, timestamped]));
  assert.throws(
    () => assertMigrationPrefixPolicy([...versions, timestamped, '20261119120000_another_migration']),
    /new migration reuses prefix 20261119120000/
  );
});

test('concurrent migrations are sent one statement at a time', () => {
  // A multi-statement query string runs as one implicit transaction, which
  // CREATE INDEX CONCURRENTLY rejects just as it rejects BEGIN.
  const migration = loadMigrations(MIGRATIONS_DIR).find(m => m.version === '015_transactions_listing_covering_index');
  assert.ok(migration);
  const statements: string[] = splitStatements(migration.sql);
  assert.deepEqual(statements.map(s => s.split(/\s+/).slice(0, 3).join(' ')), [
    'CREATE INDEX CONCURRENTLY',
    'DROP INDEX CONCURRENTLY',
    'ALTER TABLE transactions',
    'INSERT INTO schema_migrations',
  ]);
  assert.ok(statements.every(s => !s.includes(';')));

  // The assets index review builds its replacement before dropping anything,
  // so the listing is never left without an index.
  const assets = loadMigrations(MIGRATIONS_DIR).find(m => m.version === '016_assets_index_review');
  assert.ok(assets);
  assert.deepEqual(splitStatements(assets.sql).map((s: string) => s.split(/\s+/).slice(0, 3).join(' ')), [
    'CREATE INDEX CONCURRENTLY',
    ...Array(5).fill('DROP INDEX CONCURRENTLY'),
    'INSERT INTO schema_migrations',
  ]);

  // So does the operations index review: all three replacements exist before
  // the first drop.
  const operations = loadMigrations(MIGRATIONS_DIR).find(m => m.version === '019_operations_index_review');
  assert.ok(operations);
  assert.deepEqual(splitStatements(operations.sql).map((s: string) => s.split(/\s+/).slice(0, 3).join(' ')), [
    ...Array(3).fill('CREATE INDEX CONCURRENTLY'),
    ...Array(5).fill('DROP INDEX CONCURRENTLY'),
    'INSERT INTO schema_migrations',
  ]);

  const ledgerAudit = loadMigrations(MIGRATIONS_DIR).find(m => m.version === '021_ledger_audit_window_index');
  assert.ok(ledgerAudit);
  assert.deepEqual(splitStatements(ledgerAudit.sql).map((s: string) => s.split(/\s+/).slice(0, 3).join(' ')), [
    'CREATE INDEX CONCURRENTLY',
    'INSERT INTO schema_migrations',
  ]);
});

test('splits the initial schema without breaking dollar-quoted functions', () => {
  const migration = loadMigrations(MIGRATIONS_DIR).find(item => item.version === '001_init');
  assert.ok(migration);

  const statements = splitStatements(migration.sql);
  const ensurePartitions = statements.find(statement =>
    statement.includes('CREATE OR REPLACE FUNCTION ensure_operations_partitions')
  );
  assert.ok(ensurePartitions);
  assert.match(ensurePartitions, /RETURNS void AS \$\$[\s\S]*END;\s*\$\$ LANGUAGE plpgsql/);
});

test('migration status refuses a later migration when an earlier one is pending', async () => {
  const pool = { query: async () => ({ rows: [{ version: '002_account_event_columns' }] }) } as unknown as Pool;
  await assert.rejects(() => migrationStatus(pool, [
    { version: '001_init', sql: '' }, { version: '002_account_event_columns', sql: '' },
  ]), /out of order/);
});

test('runMigrations records history for scripts without a history insert', async () => {
  const recorded: string[] = [];
  const statements: string[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push(sql);
      if (sql.startsWith('SELECT version FROM schema_migrations')) {
        return { rows: recorded.map(version => ({ version })) };
      }
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        const version = values?.[0];
        assert.equal(typeof version, 'string');
        if (typeof version === 'string') recorded.push(version);
      }
      return { rows: [] };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const version = '20261124120000_test_migration_history';

  const status = await runMigrations(pool, [{ version, sql: 'CREATE TABLE example (id INTEGER);' }]);

  assert.deepEqual(status.applied, [version]);
  assert.deepEqual(recorded, [version]);
  assert.ok(statements.includes('BEGIN'));
  assert.ok(statements.includes('COMMIT'));
});

test('loadDownMigrations loads all down migration scripts', () => {
  const downMigrations = loadDownMigrations(MIGRATIONS_DIR);
  assert.ok(downMigrations.size > 0);
  assert.ok(downMigrations.has('002_account_event_columns'));
  assert.ok(downMigrations.has('012_asset_volume_buckets'));
  assert.ok(downMigrations.has('013_failed_ledgers'));
  assert.ok(downMigrations.has('013_trades'));
  assert.ok(downMigrations.has('013_trustline_changes'));
  assert.ok(downMigrations.has('015_admin_operations'));

  const m002Down = downMigrations.get('002_account_event_columns')!;
  assert.match(m002Down.sql, /ALTER TABLE accounts DROP COLUMN IF EXISTS num_sponsored/);
  assert.match(m002Down.sql, /DELETE FROM schema_migrations/);

  const partitioningDown = downMigrations.get('006_partition_operations');
  assert.ok(partitioningDown, 'irreversibility is visible beside the migration');
  assert.match(partitioningDown.sql, /IRREVERSIBLE/i);
  assert.match(partitioningDown.sql, /RAISE EXCEPTION/);
});

test('isMigrationIrreversible identifies irreversible migrations', () => {
  assert.equal(isMigrationIrreversible('001_init'), true);
  assert.equal(isMigrationIrreversible('006_partition_operations'), true);
  assert.equal(isMigrationIrreversible('007_networks'), true);
  assert.equal(isMigrationIrreversible('023_remove_placeholder_contract_interfaces'), true);
  assert.equal(isMigrationIrreversible('002_account_event_columns'), false);
  assert.equal(isMigrationIrreversible('012_asset_volume_buckets'), false);
  assert.equal(isMigrationIrreversible('022_asset_lookalike_reason'), false);
});

test('rollbackMigration rejects irreversible migrations', async () => {
  const fakePool = {} as unknown as Pool;
  await assert.rejects(
    () => rollbackMigration(fakePool, '001_init'),
    /irreversible and cannot be rolled back/
  );
  await assert.rejects(
    () => rollbackMigration(fakePool, '006_partition_operations'),
    /irreversible and cannot be rolled back/
  );
});

/**
 * A pool whose one client records each statement under a short label, so a
 * test can assert the order of a whole run without matching the SQL text.
 * `applied` is what the history table reports; `failOn` makes that statement throw.
 */
function recordingPool(applied: string[], failOn?: string): { pool: Pool; sent: string[] } {
  const sent: string[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const label = /CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql) ? 'create history table'
        : /pg_advisory_unlock/.test(sql) ? 'unlock'
        : /pg_advisory_lock/.test(sql) ? 'lock'
        : /^SELECT version FROM schema_migrations ORDER BY version$/.test(sql) ? 'read history'
        : /^INSERT INTO schema_migrations \(version\) VALUES \(\$1\)/.test(sql) ? 'record migration'
        : /ORDER BY applied_at DESC/.test(sql) ? 'read latest'
        : /^SELECT version FROM schema_migrations WHERE version = \$1$/.test(sql) ? 'check applied'
        : sql.replace(/\s+/g, ' ').trim();
      sent.push(label);
      if (failOn !== undefined && sql === failOn) throw new Error('syntax error at or near "BOOM"');
      if (label === 'read history') return { rows: applied.map(version => ({ version })) };
      if (label === 'record migration') {
        const version = params?.[0];
        if (typeof version === 'string' && !applied.includes(version)) applied.push(version);
      }
      if (label === 'read latest') return { rows: applied.slice(0, 1).map(version => ({ version })) };
      if (label === 'check applied') return { rows: applied.filter(version => version === params?.[0]).map(version => ({ version })) };
      return { rows: [] };
    },
    release: () => { sent.push('RELEASE'); },
  };
  return { pool: { connect: async () => client } as unknown as Pool, sent };
}

test('runMigrations applies pending migrations in order, each in its own transaction, under the advisory lock', async () => {
  const { pool, sent } = recordingPool(['001_init']);
  const migrations: Migration[] = [
    { version: '001_init', sql: 'CREATE TABLE a ()' },
    { version: '002_b', sql: 'CREATE TABLE b ()' },
    // Concurrent builds are sent one statement at a time, never inside BEGIN.
    { version: '004_search_indexes', sql: 'CREATE INDEX CONCURRENTLY x ON t (c);\nCREATE INDEX CONCURRENTLY y ON t (d);' },
  ];

  await runMigrations(pool, migrations);

  assert.deepEqual(sent, [
    'create history table',
    'lock',
    'read history',
    'BEGIN',
    'CREATE TABLE b ()',
    'record migration',
    'COMMIT',
    'CREATE INDEX CONCURRENTLY x ON t (c)',
    'CREATE INDEX CONCURRENTLY y ON t (d)',
    'record migration',
    'read history',
    'unlock',
    'RELEASE',
  ]);
});

test('a failing migration rolls back, releases the lock and the client, and rethrows', async () => {
  const { pool, sent } = recordingPool([], 'BOOM');

  await assert.rejects(() => runMigrations(pool, [{ version: '002_b', sql: 'BOOM' }]), /syntax error/);

  assert.equal(sent.includes('COMMIT'), false, 'a failed migration must never commit');
  assert.deepEqual(sent.slice(-3), ['ROLLBACK', 'unlock', 'RELEASE']);
});

test('rollbackLastMigration returns null and changes nothing when no migration is applied', async () => {
  const { pool, sent } = recordingPool([]);

  assert.equal(await rollbackLastMigration(pool, MIGRATIONS_DIR), null);
  assert.deepEqual(sent, ['lock', 'read latest', 'unlock', 'RELEASE']);
});

test('rollbackLastMigration runs the latest migration\'s down script and removes its history row', async () => {
  const { pool, sent } = recordingPool(['002_account_event_columns']);

  assert.equal(await rollbackLastMigration(pool, MIGRATIONS_DIR), '002_account_event_columns');

  // The lookup and the rollback each take the lock; the rollback re-checks it.
  assert.deepEqual(sent.slice(0, 4), ['lock', 'read latest', 'unlock', 'RELEASE']);
  assert.deepEqual(sent.slice(4, 7), ['lock', 'check applied', 'BEGIN']);
  assert.match(sent[7], /DROP COLUMN IF EXISTS num_sponsored/);
  assert.equal(sent[8], 'DELETE FROM schema_migrations WHERE version = $1');
  assert.deepEqual(sent.slice(9), ['COMMIT', 'unlock', 'RELEASE']);
});

test('rollbackMigration refuses a version that was never applied, before running any SQL', async () => {
  const { pool, sent } = recordingPool([]);

  await assert.rejects(
    () => rollbackMigration(pool, '002_account_event_columns', MIGRATIONS_DIR),
    /has not been applied/
  );
  assert.equal(sent.includes('BEGIN'), false);
});
