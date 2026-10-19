import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { loadMigrations, migrationStatus } from './migrations';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

test('loads migrations in order and expands initial schema include', () => {
  const migrations = loadMigrations();
  assert.deepEqual(migrations.map(migration => migration.version), [
    '001_init', '002_account_event_columns', '003_custom_event_schemas',
    '004_search_indexes', '005_api_keys', '006_autovacuum', '006_export_permissions',
    '006_partition_operations', '007_drop_redundant_api_key_index', '007_networks',
    '008_account_refresh_queue', '008_accounts_listing_index', '008_data_constraints',
    '008_retry_queue', '009_contract_storage_entries', '010_contract_storage_history',
    '010_retention_prune_indexes', '010_transaction_filters', '010_trustlines',
    '011_assets', '012_asset_volume_buckets', '013_backfill_progress', '013_export_jobs',
    '013_failed_ledgers', '013_trades', '013_trustline_changes', '014_pools_claims_paths_signers',
    '015_drop_unused_trustline_indexes',
  ]);
  assert.match(migrations[0].sql, /CREATE TABLE IF NOT EXISTS ledgers/);
  assert.match(migrations[0].sql, /PRIMARY KEY \(id, network\)/);
  assert.doesNotMatch(migrations[0].sql, /^\\ir/m);

  const networks = migrations.find(migration => migration.version === '007_networks');
  assert.ok(networks);
  assert.match(networks?.sql, /ALTER TABLE operations ADD PRIMARY KEY \(id, network\)/);
  assert.doesNotMatch(networks?.sql, /ADD PRIMARY KEY \(id, ledger, network\)/);
  assert.match(networks?.sql, /FOREIGN KEY \(transaction_hash, network\) REFERENCES transactions \(hash, network\)/);
});

test('migration status refuses a later migration when an earlier one is pending', async () => {
  const pool = { query: async () => ({ rows: [{ version: '002_account_event_columns' }] }) } as unknown as Pool;
  await assert.rejects(() => migrationStatus(pool, [
    { version: '001_init', sql: '' }, { version: '002_account_event_columns', sql: '' },
  ]), /out of order/);
});

test('loadDownMigrations loads all down migration scripts', () => {
  const { loadDownMigrations } = require('./migrations');
  const downMigrations = loadDownMigrations();
  assert.ok(downMigrations.size > 0);
  assert.ok(downMigrations.has('002_account_event_columns'));
  assert.ok(downMigrations.has('012_asset_volume_buckets'));

  const m002Down = downMigrations.get('002_account_event_columns')!;
  assert.match(m002Down.sql, /ALTER TABLE accounts DROP COLUMN IF EXISTS num_sponsored/);
  assert.match(m002Down.sql, /DELETE FROM schema_migrations/);
});

test('isMigrationIrreversible identifies irreversible migrations', () => {
  const { isMigrationIrreversible } = require('./migrations');
  assert.equal(isMigrationIrreversible('001_init'), true);
  assert.equal(isMigrationIrreversible('006_partition_operations'), true);
  assert.equal(isMigrationIrreversible('007_networks'), true);
  assert.equal(isMigrationIrreversible('002_account_event_columns'), false);
  assert.equal(isMigrationIrreversible('012_asset_volume_buckets'), false);
});

test('rollbackMigration rejects irreversible migrations', async () => {
  const { rollbackMigration } = require('./migrations');
  const fakePool = {} as unknown as Pool;
  await assert.rejects(
    () => rollbackMigration(fakePool, '001_init'),
    /irreversible and cannot be rolled back/
  );
});
