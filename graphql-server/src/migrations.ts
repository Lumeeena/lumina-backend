/**
 * Applies, reads and rolls back the SQL migrations in `db/migrations/`, and
 * records each applied one in `schema_migrations`.
 *
 * Two callers reach this module: `migrate.ts` for the command-line runner, and
 * the server's startup, which runs it only when `RUN_MIGRATIONS_ON_STARTUP` is
 * `true`. Both go through `runMigrations`, so the advisory lock, the
 * out-of-order check and the `CONCURRENTLY` handling apply to every path that
 * changes the schema.
 *
 * A forward migration is `<version>.sql`; an optional `<version>.down.sql`
 * reverses it. The version is the filename without its extension and is stored
 * verbatim in `schema_migrations`, so renaming a file that has already been
 * applied makes the runner report it as unknown.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import type { Pool, PoolClient } from 'pg';

/** One migration file: its version (the filename stem) and its SQL, with `\echo` lines removed. */
export interface Migration { version: string; sql: string; }

/**
 * Read every forward migration in `directory`, sorted by filename.
 *
 * `001_init.sql` pulls in the full schema with a psql `\ir` include. node-postgres
 * cannot follow that, so the include is replaced with the file's contents here,
 * and `\echo` lines are dropped because the server would reject them as SQL.
 *
 * With no `directory`, the first of two locations that exists is used, then
 * `db/migrations` under the working directory. The source does not record which
 * deployment each location serves.
 */
export function loadMigrations(directory?: string): Migration[] {
  directory ??= [resolve(__dirname, '../../db/migrations'), resolve(__dirname, '../db/migrations')].find(existsSync)
    ?? resolve(process.cwd(), 'db/migrations');
  return readdirSync(directory).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort().map(name => {
    let sql = readFileSync(join(directory, name), 'utf8');
    if (name === '001_init.sql') sql = sql.replace('\\ir ../schema.sql', readFileSync(resolve(directory, '../schema.sql'), 'utf8'));
    sql = sql.replace(/^\\echo.*$/gm, '');
    return { version: name.replace(/\.sql$/, ''), sql };
  });
}

/**
 * Compare the database's history with the files and say what is applied and
 * what is pending.
 *
 * Throws in two cases, and both are refused rather than worked around: the
 * database records a version no file provides (it was migrated by a newer build,
 * or a file was removed), or a pending migration sits before an applied one
 * (someone applied a later file out of order, so the earlier one would be
 * skipped by a plain "run what is pending" pass).
 */
export async function migrationStatus(pool: Pick<Pool, 'query'>, migrations: Migration[]) {
  const result = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
  const applied = new Set(result.rows.map(row => row.version));
  const known = new Set(migrations.map(migration => migration.version));
  const unknown = [...applied].filter(version => !known.has(version));
  if (unknown.length) throw new Error(`Database contains unknown migrations: ${unknown.join(', ')}`);
  const pending = migrations.filter(migration => !applied.has(migration.version));
  const firstPendingIndex = migrations.findIndex(migration => !applied.has(migration.version));
  if (firstPendingIndex >= 0) {
    const appliedOutOfOrder = migrations.slice(firstPendingIndex + 1).filter(migration => applied.has(migration.version));
    if (appliedOutOfOrder.length) throw new Error(`Migration history is out of order; pending ${migrations[firstPendingIndex].version} before applied ${appliedOutOfOrder.map(m => m.version).join(', ')}`);
  }
  return { applied: migrations.filter(migration => applied.has(migration.version)).map(migration => migration.version), pending: pending.map(migration => migration.version) };
}

/**
 * Apply every pending migration in filename order, unless `apply` is false, and
 * return the resulting status either way.
 *
 * Holds a Postgres advisory lock for the whole run, so two processes starting
 * at once (for example two replicas with `RUN_MIGRATIONS_ON_STARTUP=true`) queue
 * behind each other instead of interleaving. The lock is released and the client
 * returned to the pool even when a migration fails.
 *
 * The lock key, `74192061`, is shared with both rollback functions. It is a
 * fixed number, and the source does not record why this value was chosen.
 */
export async function runMigrations(pool: Pool, migrations: Migration[], apply = true): Promise<Awaited<ReturnType<typeof migrationStatus>>> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query('SELECT pg_advisory_lock($1)', [74192061]);
    let status = await migrationStatus(client, migrations);
    if (apply) {
      for (const version of status.pending) {
        const migration = migrations.find(item => item.version === version)!;
        await applyMigration(client, migration);
      }
      status = await migrationStatus(client, migrations);
    }
    return status;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [74192061]); }
    finally { client.release(); }
  }
}

/**
 * Migrations that build or drop indexes CONCURRENTLY, which cannot run inside a transaction.
 *
 * Membership is by hand: a new migration that uses CONCURRENTLY must be added
 * here, or it runs inside BEGIN/COMMIT and Postgres rejects it.
 */
const CONCURRENT_MIGRATIONS = new Set([
  '004_search_indexes',
  '008_accounts_listing_index',
  '010_transaction_filters',
  '015_transactions_listing_covering_index',
  '016_assets_index_review',
  '019_operations_index_review',
  '020_claimable_balances_listing',
  '021_ledger_audit_window_index',
]);

/**
 * One statement per element, comments dropped.
 *
 * Postgres runs a multi-statement query string as one implicit transaction, so
 * sending a concurrent migration whole fails exactly as BEGIN would. The split
 * is on a `;` that ends a line, which is safe for these files because none of
 * them contains a function body.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
}

async function applyMigration(client: PoolClient, migration: Migration): Promise<void> {
  // These migrations are idempotent and write their history row last, so a
  // failure part-way is safe to re-run.
  if (CONCURRENT_MIGRATIONS.has(migration.version)) {
    for (const statement of splitStatements(migration.sql)) await client.query(statement);
    return;
  }
  await client.query('BEGIN');
  try { await client.query(migration.sql); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}

/** Migrations that restructure underlying tables, partitions, or primary keys and cannot be reverted in-place. */
export const IRREVERSIBLE_MIGRATIONS = [
  '001_init',
  '006_partition_operations',
  '007_networks',
  '023_remove_placeholder_contract_interfaces',
] as const;

/** Whether `version` is listed in {@link IRREVERSIBLE_MIGRATIONS}. `rollbackMigration` checks this before reading any file. */
export function isMigrationIrreversible(version: string): boolean {
  return (IRREVERSIBLE_MIGRATIONS as readonly string[]).includes(version);
}

/**
 * Load all `.down.sql` migrations from the migrations directory.
 * Keyed by the migration version string (e.g. `002_account_event_columns`).
 */
export function loadDownMigrations(directory?: string): Map<string, Migration> {
  directory ??= [resolve(__dirname, '../../db/migrations'), resolve(__dirname, '../db/migrations')].find(existsSync)
    ?? resolve(process.cwd(), 'db/migrations');
  const downMigrations = new Map<string, Migration>();
  for (const name of readdirSync(directory)) {
    if (!/^\d+_[a-z0-9_-]+\.down\.sql$/i.test(name)) continue;
    const version = name.replace(/\.down\.sql$/, '');
    let sql = readFileSync(join(directory, name), 'utf8');
    sql = sql.replace(/^\\echo.*$/gm, '');
    downMigrations.set(version, { version, sql });
  }
  return downMigrations;
}

/**
 * Roll back one applied migration: run its `.down.sql` and delete its history row, in one transaction.
 *
 * Refuses an irreversible migration before touching the database, and refuses
 * one that is not applied, so a rollback cannot run a down script for a
 * migration that never ran. The applied check runs under the advisory lock, so
 * a concurrent rollback of the same version fails instead of running twice.
 */
export async function rollbackMigration(pool: Pool, targetVersion: string, directory?: string): Promise<void> {
  if (isMigrationIrreversible(targetVersion)) {
    throw new Error(`Migration ${targetVersion} is irreversible and cannot be rolled back.`);
  }

  const downMigrations = loadDownMigrations(directory);
  const downMigration = downMigrations.get(targetVersion);
  if (!downMigration) {
    throw new Error(`No down migration found for version: ${targetVersion}`);
  }

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [74192061]);

    const result = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [targetVersion]
    );
    if (result.rows.length === 0) {
      throw new Error(`Migration ${targetVersion} has not been applied.`);
    }

    await client.query('BEGIN');
    try {
      await client.query(downMigration.sql);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [targetVersion]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [74192061]);
    } finally {
      client.release();
    }
  }
}

/**
 * Roll back the most recently applied migration and return its version, or `null` if none is applied.
 *
 * "Most recent" means latest `applied_at`, with the version as the tie-breaker.
 * The lock is taken twice, once to read the latest row and once inside
 * `rollbackMigration`, so the read is not held across the rollback itself.
 */
export async function rollbackLastMigration(pool: Pool, directory?: string): Promise<string | null> {
  const client = await pool.connect();
  let lastApplied: string | null = null;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [74192061]);
    const result = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1'
    );
    lastApplied = result.rows[0]?.version ?? null;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [74192061]);
    } finally {
      client.release();
    }
  }

  if (!lastApplied) return null;
  await rollbackMigration(pool, lastApplied, directory);
  return lastApplied;
}
