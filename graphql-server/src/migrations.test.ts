import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { loadMigrations, migrationStatus } from './migrations';

test('loads migrations in order and expands initial schema include', () => {
  const migrations = loadMigrations();
  assert.deepEqual(migrations.map(migration => migration.version), [
    '001_init', '002_account_event_columns', '003_custom_event_schemas',
    '004_search_indexes', '005_api_keys', '006_autovacuum', '006_export_permissions',
    '006_partition_operations', '007_drop_redundant_api_key_index', '007_networks',
    '008_account_refresh_queue',
  ]);
  assert.match(migrations[0].sql, /CREATE TABLE IF NOT EXISTS ledgers/);
  assert.match(migrations[0].sql, /PRIMARY KEY \(id, ledger, network\)/);
  assert.doesNotMatch(migrations[0].sql, /^\\ir/m);

  const networks = migrations.find(migration => migration.version === '007_networks');
  assert.ok(networks);
  assert.match(networks?.sql, /ALTER TABLE operations ADD PRIMARY KEY \(id, ledger, network\)/);
  assert.match(networks?.sql, /FOREIGN KEY \(transaction_hash, network\) REFERENCES transactions \(hash, network\)/);
});

test('migration status refuses a later migration when an earlier one is pending', async () => {
  const pool = { query: async () => ({ rows: [{ version: '002_account_event_columns' }] }) } as unknown as Pool;
  await assert.rejects(() => migrationStatus(pool, [
    { version: '001_init', sql: '' }, { version: '002_account_event_columns', sql: '' },
  ]), /out of order/);
});
