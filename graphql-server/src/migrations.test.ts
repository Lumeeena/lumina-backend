import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { loadMigrations, migrationStatus } from './migrations';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

test('loads migrations in order and expands initial schema include', () => {
  const migrations = loadMigrations();

  // Derived from the directory rather than written out here, because a
  // hard-coded list silently rots: every migration added since the list was
  // last updated made this test fail without changing anything about the
  // loader. If a migration is ever not loaded, that is a loader bug and the
  // name/shape assertions below are where it should surface.
  const onDisk = readdirSync(MIGRATIONS_DIR)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => file.replace(/\.sql$/, ''));
  assert.deepEqual(migrations.map(migration => migration.version), onDisk);
  assert.ok(migrations.length > 0, 'the migrations directory is not empty');

  // Ordering is what the runner relies on to decide an out-of-order history,
  // so assert it is the plain lexicographic order the loader promises.
  assert.deepEqual(migrations.map(m => m.version), [...migrations.map(m => m.version)].sort());

  assert.match(migrations[0].sql, /CREATE TABLE IF NOT EXISTS ledgers/);
  // `operations` is keyed (id, network): `network` has to be in the key or
  // mainnet ledger 42 and testnet ledger 42 collide, and `ledger` must NOT be,
  // because that combination is only expressible on a partitioned table and
  // 006 no longer partitions. db/schema.sql and 007_networks both land on this
  // shape, and db/check-schema-parity.sh diffs them.
  assert.match(migrations[0].sql, /PRIMARY KEY \(id, network\)/);
  assert.doesNotMatch(migrations[0].sql, /PRIMARY KEY \(id, ledger, network\)/);
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
