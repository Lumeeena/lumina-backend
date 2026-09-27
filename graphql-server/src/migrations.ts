import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import type { Pool, PoolClient } from 'pg';

export interface Migration { version: string; sql: string; }

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

async function applyMigration(client: PoolClient, migration: Migration): Promise<void> {
  // Migration 004 uses CREATE INDEX CONCURRENTLY, which PostgreSQL forbids in
  // a transaction. Its statements are idempotent and its history insert is last.
  if (migration.version === '004_search_indexes') {
    await client.query(migration.sql);
    return;
  }
  await client.query('BEGIN');
  try { await client.query(migration.sql); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
