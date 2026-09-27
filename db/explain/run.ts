#!/usr/bin/env node
/**
 * Query-plan audit: seed, capture, compare.
 *
 * ## Why the plans are captured by interception rather than transcribed
 *
 * The catalog below names the *application functions* it wants plans for, not
 * SQL. Each one is handed a pool that runs its statement under EXPLAIN and then
 * runs it for real, so the recorded plan is the plan for the query the server
 * actually sends. A hand-copied statement drifts from db.ts the first time
 * somebody edits a WHERE clause, and a stale copy of the SQL produces a plan
 * for a query nobody runs — the audit would keep passing while the real query
 * regressed.
 *
 * ## Why this never runs in CI
 *
 * The findings here only exist at scale: on a small table the sequential scan
 * is the *correct* plan, so a CI-sized dataset would report a clean bill of
 * health for exactly the queries this is meant to catch. CI can still catch an
 * index being dropped or renamed, which is why the baseline records the index
 * inventory alongside the plans — see docs/QUERY_PLANS.md.
 *
 * ## Usage
 *
 *   npm run explain:seed     # build the scratch database (slow, once)
 *   npm run explain          # capture plans and report against the baseline
 *   npm run explain:update   # re-capture and rewrite the baseline
 *   npm run explain:check    # compare only; non-zero exit on a regression
 *
 * Reads EXPLAIN_DATABASE_URL, falling back to DATABASE_URL.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const DATABASE_URL = process.env.EXPLAIN_DATABASE_URL ?? process.env.DATABASE_URL;
const ROOT = join(__dirname, '..', '..');

/**
 * The seed revision is a hash of the seed itself, not a constant somebody has
 * to remember to bump: edit seed.sql and the sentinel no longer matches, so the
 * next run re-seeds instead of comparing plans against a database that no
 * longer corresponds to the file.
 */
const SEED_VERSION = 'seed-' + createHash('sha256')
  .update(readFileSync(join(__dirname, 'seed.sql')))
  .digest('hex')
  .slice(0, 12);

function usage(): never {
  console.error(
    [
      'Usage: explain <command>',
      '',
      '  seed     Apply db/schema.sql + seed.sql + schema.sql, then VACUUM (ANALYZE).',
      '           Refuses to re-seed unless --force, because it truncates everything.',
      '  capture  Run every catalog query under EXPLAIN ANALYZE and report.',
      '  check    Same, but compare against baseline.json and exit non-zero on change.',
      '  update   Re-capture and rewrite baseline.json.',
      '',
      'Reads EXPLAIN_DATABASE_URL (or DATABASE_URL).',
    ].join('\n')
  );
  process.exit(1);
}

function connect(): Client {
  if (!DATABASE_URL) {
    console.error('EXPLAIN_DATABASE_URL (or DATABASE_URL) must be set.');
    process.exit(2);
  }
  return new Client({ connectionString: DATABASE_URL });
}

async function applyFile(client: Client, relative: string): Promise<void> {
  const sql = readFileSync(join(ROOT, relative), 'utf-8');
  await client.query(sql);
}

async function seed(force: boolean): Promise<void> {
  const client = connect();
  await client.connect();

  try {
    const existing = await client
      .query<{ value: string }>(`SELECT value FROM explain_fixtures WHERE name = 'seed.version'`)
      .catch(() => ({ rows: [] as { value: string }[] }));

    if (existing.rows[0]?.value === SEED_VERSION && !force) {
      console.log(`already seeded (${SEED_VERSION}); pass --force to rebuild`);
      return;
    }

    // schema.sql is not idempotent, so it is applied once, to an empty
    // database, and the seed rebuilds whatever it drops itself.
    const present = await client.query<{ t: string | null }>(`SELECT to_regclass('public.transactions')::text AS t`);
    if (present.rows[0].t) {
      console.log('schema already present; skipping db/schema.sql');
    } else {
      console.log('applying db/schema.sql...');
      await applyFile(client, 'db/schema.sql');
    }

    // The index builds at the end are the slow part of a re-seed; give them
    // memory rather than making them spill to disk.
    await client.query("SET maintenance_work_mem = '1GB'");
    await client.query('SET synchronous_commit = off');

    console.log('applying db/explain/seed.sql (this is the slow part)...');
    await applyFile(client, 'db/explain/seed.sql');

    // The contract schema is registered through the production path so the
    // validator, not the seed, decides whether it is well-formed. A malformed
    // schema would make every customEvents plan unreachable.
    const { upsertContractSchema } = require('../../indexer/src/db');
    const { parseContractSchema } = require('../../indexer/src/customSchema');
    const hot = (
      await client.query<{ value: string }>(`SELECT value FROM explain_fixtures WHERE name = 'custom.contract'`)
    ).rows[0].value;
    const definition = (
      await client.query<{ definition: unknown }>(`SELECT definition FROM contract_schemas WHERE contract_id = $1`, [hot])
    ).rows[0]?.definition;
    const parsed = parseContractSchema(definition);
    // A Client and a Pool are interchangeable for this call: it only uses
    // .query(), and going through the production helper means the stored
    // definition is the normalised one the validator produced.
    await upsertContractSchema(client as unknown as Parameters<typeof upsertContractSchema>[0], parsed);

    console.log('vacuuming...');
    for (const table of ['ledgers', 'transactions', 'operations', 'accounts', 'contract_events', 'custom_events', 'contract_schemas']) {
      await client.query(`VACUUM (ANALYZE) ${table}`);
      // Frozen statistics: a regression check that can be disturbed by an
      // autovacuum landing between two runs is a check nobody will trust.
      await client.query(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`);
    }

    await client.query(
      `INSERT INTO explain_fixtures (name, value, note) VALUES ('seed.version', $1, 'seed revision')
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      [SEED_VERSION]
    );

    const counts = await client.query<{ table: string; rows: string }>(
      `SELECT 'transactions' AS table, COUNT(*)::text AS rows FROM transactions
       UNION ALL SELECT 'operations', COUNT(*)::text FROM operations
       UNION ALL SELECT 'contract_events', COUNT(*)::text FROM contract_events
       UNION ALL SELECT 'custom_events', COUNT(*)::text FROM custom_events
       UNION ALL SELECT 'accounts', COUNT(*)::text FROM accounts
       UNION ALL SELECT 'ledgers', COUNT(*)::text FROM ledgers`
    );
    console.log('seeded:');
    for (const row of counts.rows) console.log(`  ${row.table.padEnd(16)} ${row.rows}`);
    console.log(`  fixtures         ${(await client.query('SELECT COUNT(*)::text AS n FROM explain_fixtures')).rows[0].n}`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const [command, ...flags] = process.argv.slice(2);
  const force = flags.includes('--force');

  switch (command) {
    case 'seed':
      await seed(force);
      break;
    case 'capture':
      await runCapture('report');
      break;
    case 'check':
      await runCapture('check');
      break;
    case 'update':
      await runCapture('update');
      break;
    default:
      usage();
  }
}

/** Loaded lazily so `seed` does not need the application code the capture pulls in. */
async function runCapture(mode: 'report' | 'check' | 'update'): Promise<void> {
  const { capture } = require('./capture') as typeof import('./capture');
  await capture({ mode });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
