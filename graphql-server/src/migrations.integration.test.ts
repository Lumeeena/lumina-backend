/**
 * Apply the migration chain to a populated database and check the data is
 * still there afterwards, timing every step.
 *
 * ## Why this exists
 *
 * CI applies migrations to empty databases only. On an empty database every
 * migration is fast and every constraint is trivially satisfied, which means
 * the two things that actually go wrong in production are invisible:
 *
 * - a rule that existing rows violate — a NOT NULL with no default, a unique
 *   constraint the data does not satisfy, or, as here, a primary key that a
 *   partitioned table cannot have;
 * - a step that rewrites or re-indexes every row, whose duration is a function
 *   of table size and therefore cannot be learned from an empty table at all.
 *
 * ## How it works
 *
 * The chain is applied through the production runner, `runMigrations`, one
 * migration at a time — the runner is handed a prefix of the migration list so
 * each call applies exactly the next pending file, and the CONCURRENTLY special
 * case, the advisory lock and the history bookkeeping all stay in one place.
 *
 * Data is seeded after the last migration that does not touch existing rows
 * (SEED_AFTER below), which is the shape of a real deployment: tables that have
 * been accumulating since before the migrations under test existed. After every
 * subsequent migration the test re-reads each table's row count and a checksum
 * over its columns and asserts both are unchanged.
 *
 * ## Running it
 *
 *   MIGRATION_TEST_BASE_URL=postgresql://lumina:lumina_test@localhost:5432/postgres \
 *     npm run test:migrations --prefix graphql-server
 *
 * The base URL is a maintenance connection used to create the scratch database
 * (the same convention as db/check-schema-parity.sh's PARITY_BASE_URL). It is
 * never the database under test. Skipped when the variable is unset, like the
 * other integration tests. Nothing here touches production data: every row is
 * generated from md5 of a row index by db/migration-test-seed.sql.
 *
 * On success the scratch database is dropped. On failure it is left in place
 * and its name is printed, so a failing migration can be inspected.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, Pool } from 'pg';
import { loadMigrations, runMigrations, type Migration } from './migrations';

const BASE_URL =
  process.env.MIGRATION_TEST_BASE_URL ?? 'postgresql://lumina:lumina_test@localhost:5432/postgres';
const SCRATCH_DATABASE = 'lumina_migration_test';
const SEED_FILE = join(__dirname, '..', '..', 'db', 'migration-test-seed.sql');

/**
 * Data goes in after this migration, so everything that follows runs against
 * populated tables. Everything up to and including it only adds tables, columns
 * and indexes — a deployment applying the newer migrations already has all of
 * it.
 */
const SEED_AFTER = '005_api_keys';

const SEEDED_TABLES = [
  'ledgers',
  'transactions',
  'operations',
  'accounts',
  'contract_events',
  'contract_schemas',
  'custom_events',
];

/** Generous: a slow migration is the finding, not a reason to cut the run off. */
const TEST_TIMEOUT_MS = 15 * 60 * 1000;

const skip = process.env.MIGRATION_TEST_BASE_URL ? false : 'MIGRATION_TEST_BASE_URL is not set';

/** The base URL with its database replaced by the scratch database. */
function scratchUrl(): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${SCRATCH_DATABASE}`;
  return url.toString();
}

interface Step {
  version: string;
  ms: number;
  /** Row counts and checksums after this step, or the error that stopped it. */
  error?: string;
}

async function createScratchDatabase(): Promise<void> {
  const admin = new Client({ connectionString: BASE_URL });
  await admin.connect();
  try {
    // Drop rather than reuse: a leftover database from a failed run would
    // otherwise be migrated incrementally and report a false pass.
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DATABASE}`);
  } finally {
    await admin.end();
  }
}

/** Apply exactly one migration, by handing the runner its prefix. */
async function applyOne(pool: Pool, migrations: Migration[], index: number): Promise<Step> {
  const started = Date.now();
  try {
    await runMigrations(pool, migrations.slice(0, index + 1), true);
    return { version: migrations[index].version, ms: Date.now() - started };
  } catch (error) {
    return {
      version: migrations[index].version,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
    };
  }
}

/**
 * The columns to checksum, read from the catalog before any migration under
 * test runs. Captured rather than hardcoded so a migration that adds a column
 * does not change what is being compared — the point is to detect rows
 * changing, not to assert the shape of the schema.
 */
async function capturedColumns(client: Client): Promise<Map<string, string>> {
  const columns = new Map<string, string>();
  for (const table of SEEDED_TABLES) {
    const { rows } = await client.query<{ cols: string }>(
      `SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS cols
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table]
    );
    assert.ok(rows[0]?.cols, `no columns found for ${table} — did the seed run?`);
    columns.set(table, rows[0].cols);
  }
  return columns;
}

/**
 * Row count and a content checksum per table.
 *
 * The checksum is over the columns captured above, ordered by their own text so
 * it does not depend on a primary key that a migration may be rewriting. NULL
 * is rendered distinctly rather than skipped, so a row losing a value is a
 * mismatch rather than a coincidence.
 */
async function snapshot(client: Client, columns: Map<string, string>): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const [table, cols] of columns) {
    // The column list comes from information_schema and is already quoted with
    // quote_ident; no external input reaches this statement.
    const rendered = cols.split(', ').map(column => `coalesce(${column}::text, '<null>')`).join(', ');
    const { rows } = await client.query<{ n: string; checksum: string }>(
      `SELECT count(*)::text AS n,
              md5(coalesce(string_agg(row_text, '|' ORDER BY row_text), '')) AS checksum
         FROM (SELECT concat_ws('|', ${rendered}) AS row_text FROM ${table}) rows`
    );
    snapshot.set(table, `${rows[0].n} rows, checksum ${rows[0].checksum}`);
  }
  return snapshot;
}

function printReport(steps: Step[], counts: Map<string, string>): void {
  const width = Math.max(...steps.map(step => step.version.length)) + 2;
  console.log('\nmigration durations (populated where noted):');
  for (const step of steps) {
    const outcome = step.error ? `FAILED: ${step.error}` : `${step.ms}ms`;
    console.log(`  ${step.version.padEnd(width)}${outcome}`);
  }
  console.log('\nrows at seed time:');
  for (const [table, count] of counts) console.log(`  ${table.padEnd(width)}${count}`);
}

test(
  'the migration chain applies to a populated database and preserves its data',
  { skip, timeout: TEST_TIMEOUT_MS },
  async () => {
    const migrations = loadMigrations();
    const seedIndex = migrations.findIndex(migration => migration.version === SEED_AFTER);
    assert.ok(
      seedIndex >= 0,
      `no migration named ${SEED_AFTER} — the seed point in this test needs updating when the chain changes`
    );

    await createScratchDatabase();
    const pool = new Pool({ connectionString: scratchUrl() });
    const steps: Step[] = [];
    let counts = new Map<string, string>();
    let failure: Step | undefined;

    try {
      for (let index = 0; index <= seedIndex; index++) {
        const step = await applyOne(pool, migrations, index);
        steps.push(step);
        assert.ok(!step.error, `migration ${step.version} failed on an empty database: ${step.error}`);
      }

      const client = await pool.connect();
      let columns: Map<string, string>;
      let before: Map<string, string>;
      try {
        const started = Date.now();
        await client.query(readFileSync(SEED_FILE, 'utf8'));
        steps.push({ version: 'seed (db/migration-test-seed.sql)', ms: Date.now() - started });

        columns = await capturedColumns(client);
        before = await snapshot(client, columns);
        counts = before;
      } finally {
        client.release();
      }

      let previous = before;
      for (let index = seedIndex + 1; index < migrations.length; index++) {
        const step = await applyOne(pool, migrations, index);
        steps.push(step);

        if (step.error) {
          failure = step;
          break;
        }

        const client = await pool.connect();
        try {
          const after = await snapshot(client, columns);
          for (const table of SEEDED_TABLES) {
            assert.equal(
              after.get(table),
              previous.get(table),
              `${migrations[index].version} changed the contents of ${table}`
            );
          }
          previous = after;
        } finally {
          client.release();
        }
      }
    } finally {
      await pool.end();
    }

    printReport(steps, counts);

    if (failure) {
      // Leave the database for inspection; a dropped one cannot be looked at.
      assert.fail(
        `migration ${failure.version} failed on a populated database: ${failure.error}\n` +
          `The scratch database ${SCRATCH_DATABASE} has been left in place for inspection; ` +
          `connect with: psql ${scratchUrl()}`
      );
    }

    await dropScratchDatabase();
    console.log('\nscratch database dropped; every migration preserved the seeded data');
  }
);

async function dropScratchDatabase(): Promise<void> {
  const admin = new Client({ connectionString: BASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
  } finally {
    await admin.end();
  }
}
