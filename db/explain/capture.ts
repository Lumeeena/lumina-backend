/**
 * The capture harness: run every catalog query under EXPLAIN ANALYZE and turn
 * the results into comparable signatures.
 *
 * ## Interception, not transcription
 *
 * Each catalog entry names an application function. It is called with a pool
 * whose `query` runs the statement twice: once under EXPLAIN (ANALYZE, BUFFERS,
 * FORMAT JSON) to record the plan, once for real to produce the rows. So the
 * recorded statement is whatever the application sends, and the rows are real —
 * which matters more than it first appears, because the cursor for a keyset
 * page is derived from the previous page's last row. A harness that returned
 * empty rows would never be able to capture a cursor page at all, and a
 * hand-written cursor would be a lie about what the server does.
 *
 * ## Warm-up
 *
 * The plan that gets recorded should be the plan for a warm cache, the way it
 * is in production. So every entry runs once with no recording, then again with
 * it. The cost is roughly double; the alternative is a first-page plan that
 * says more about this machine's page cache than about the query.
 *
 * ## Sessions, not statements
 *
 * EXPLAIN ANALYZE executes the statement, so every catalog entry must be
 * read-only. That is asserted rather than assumed: a statement that is not a
 * SELECT or WITH throws, which also stops the harness being pointed at a write
 * path by a future edit to the catalog.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import {
  diffSignatures,
  planScans,
  planSignature,
  summarise,
  type Delta,
  type PlanSignature,
} from '../../graphql-server/src/explain';
import { CATALOG, type CatalogEntry } from './catalog';

const ROOT = join(__dirname, '..', '..');
const BASELINE_PATH = join(__dirname, 'baseline.json');
const PLANS_DIR = join(__dirname, 'plans');

export type FixtureLookup = (name: string) => string;

interface CapturedStatement extends PlanSignature {
  sql: string;
  planMs: number;
  execMs: number;
  plan: unknown;
}

interface CapturedEntry {
  entry: CatalogEntry;
  statements: CapturedStatement[];
  error?: string;
}

interface Baseline {
  environment: Record<string, string>;
  indexes: string[];
  entries: Record<string, PlanSignature[]>;
}

/**
 * GUCs pinned for the capture, and recorded in the baseline so a diff from
 * another environment is reported as such instead of as a regression.
 *
 * jit is off because JIT compilation above its cost threshold adds seconds of
 * noise to exactly the large scans this audit is about, and the threshold can
 * be crossed by an unrelated statistics change.
 */
const SESSION_SETTINGS: Record<string, string> = {
  jit: 'off',
  track_io_timing: 'off',
  statement_timeout: '180s',
  max_parallel_workers_per_gather: '2',
};

const SEEDED_TABLES = [
  'ledgers',
  'transactions',
  'operations',
  'accounts',
  'contract_events',
  'custom_events',
  'contract_schemas',
];

function connect(): Client {
  const url = process.env.EXPLAIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('EXPLAIN_DATABASE_URL (or DATABASE_URL) must be set.');
    process.exit(2);
  }
  return new Client({ connectionString: url });
}

/** Application functions, keyed by the name the catalog uses. */
function applicationFunctions(): Record<string, (pool: Pool, ...args: never[]) => Promise<unknown>> {
  const db = require('../../graphql-server/src/db');
  const search = require('../../graphql-server/src/search');
  const customEvents = require('../../graphql-server/src/customEvents');
  const indexer = require('../../indexer/src/db');

  return {
    getTransactions: db.getTransactions,
    getTransactionByHash: db.getTransactionByHash,
    getTransactionsByLedger: db.getTransactionsByLedger,
    getOperations: db.getOperations,
    getOperationsByTransactionHash: db.getOperationsByTransactionHash,
    getOperationsByAsset: search.getOperationsByAsset,
    getAccountOperationsInLedger: db.getAccountOperationsInLedger,
    getEventsByContract: db.getEventsByContract,
    searchTransactions: search.searchTransactions,
    getCustomEvents: customEvents.getCustomEvents,
    getLedgerBySequence: db.getLedgerBySequence,
    getLatestLedgerFromDb: db.getLatestLedgerFromDb,
    getAccountFromDb: db.getAccountFromDb,
    getAccountTransactions: db.getAccountTransactions,
    getAccountOperations: db.getAccountOperations,
    getLatestIndexedLedger: indexer.getLatestIndexedLedger,
    getLatestIndexedEventLedger: indexer.getLatestIndexedEventLedger,
    loadContractSchemas: indexer.loadContractSchemas,
  };
}

/**
 * A pool that records the plan for every read it is asked to run, then runs it.
 */
function capturingPool(real: Client, sink: CapturedStatement[]): Pool {
  return {
    query: async (text: unknown, params?: unknown[]) => {
      const sql = typeof text === 'string' ? text : String((text as { text: string }).text);

      if (!/^\s*(select|with)\b/i.test(sql)) {
        throw new Error(
          `refusing to EXPLAIN a statement that is not a read: ${sql.slice(0, 120)}`
        );
      }

      const explainStarted = Date.now();
      const explained = await real.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params as never[]);
      const planMs = Date.now() - explainStarted;
      const plan = Object.values(explained.rows[0] as Record<string, unknown>)[0];

      // The rows are the point: cursor pages are built from the previous page's
      // last row, and a query that returns nothing has no cursor to continue from.
      const execStarted = Date.now();
      const result = await real.query(sql, params as never[]);
      const execMs = Date.now() - execStarted;

      sink.push({
        ...planSignature({ sql, plan, rowsReturned: result.rows.length }),
        sql,
        planMs,
        execMs,
        plan,
      });

      return result;
    },
  } as unknown as Pool;
}

/** A pool that runs the statements without recording anything, for the warm-up pass. */
function plainPool(real: Client): Pool {
  return { query: (text: unknown, params?: unknown[]) => real.query(text as string, params as never[]) } as unknown as Pool;
}

async function loadFixtures(client: Client): Promise<FixtureLookup> {
  let rows: { name: string; value: string }[];
  try {
    ({ rows } = await client.query<{ name: string; value: string }>('SELECT name, value FROM explain_fixtures'));
  } catch {
    throw new Error('the database has no explain_fixtures table — run `npm run explain:seed` first');
  }
  const fixtures = new Map(rows.map(row => [row.name, row.value]));
  if (fixtures.size === 0) throw new Error('explain_fixtures is empty — re-run `npm run explain:seed`');

  return (name: string) => {
    const value = fixtures.get(name);
    if (value === undefined) throw new Error(`no fixture named "${name}" — re-run \`npm run explain:seed\``);
    return value;
  };
}

async function runCatalog(
  client: Client,
  fixtures: FixtureLookup,
  record: boolean
): Promise<CapturedEntry[]> {
  const functions = applicationFunctions();
  const captured: CapturedEntry[] = [];
  const results = new Map<string, unknown>();

  for (const entry of CATALOG) {
    const statements: CapturedStatement[] = [];
    const pool = record ? capturingPool(client, statements) : plainPool(client);

    try {
      let cursor: string | undefined;
      if (entry.cursorFrom) {
        const parent = results.get(entry.cursorFrom.entry);
        cursor = entry.cursorFrom.pick(parent) ?? undefined;
        if (!cursor) throw new Error(`no cursor from ${entry.cursorFrom.entry} (empty page?)`);
      }

      const args = entry.args(fixtures, cursor);
      const fn = functions[entry.fn];
      if (!fn) throw new Error(`catalog names an unknown function: ${entry.fn}`);

      results.set(entry.name, await fn(pool, ...(args as never[])));
      captured.push({ entry, statements });
    } catch (err) {
      captured.push({
        entry,
        statements,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return captured;
}

async function environmentFingerprint(client: Client): Promise<Record<string, string>> {
  const { rows } = await client.query<{ key: string; value: string }>(
    `SELECT 'server_version' AS key, current_setting('server_version') AS value
     UNION ALL SELECT 'max_parallel_workers_per_gather', current_setting('max_parallel_workers_per_gather')
     UNION ALL SELECT 'random_page_cost', current_setting('random_page_cost')
     UNION ALL SELECT 'work_mem', current_setting('work_mem')
     UNION ALL SELECT 'shared_buffers', current_setting('shared_buffers')
     UNION ALL SELECT 'effective_cache_size', current_setting('effective_cache_size')
     UNION ALL SELECT 'pg_trgm.similarity_threshold', current_setting('pg_trgm.similarity_threshold')`
  );
  const fingerprint: Record<string, string> = {};
  for (const row of rows) fingerprint[row.key] = row.value;

  const seed = await client.query<{ value: string }>(`SELECT value FROM explain_fixtures WHERE name = 'seed.version'`);
  fingerprint['seed.version'] = seed.rows[0]?.value ?? 'unknown';
  return fingerprint;
}

/** The index inventory: the one regression a CI-sized database can also catch. */
async function indexInventory(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = ANY($1) ORDER BY indexname`,
    [SEEDED_TABLES]
  );
  return rows.map(row => row.indexname);
}

function printTable(captured: CapturedEntry[]): void {
  const nameWidth = Math.max(...CATALOG.map(entry => entry.name.length)) + 2;

  console.log('');
  console.log(
    'verdict'.padEnd(18) +
    'query'.padEnd(nameWidth) +
    'rows'.padStart(6) +
    'plan ms'.padStart(9) +
    '  plan'
  );
  console.log('-'.repeat(18 + nameWidth + 6 + 9 + 40));

  for (const item of captured) {
    const { entry, statements } = item;
    if (item.error) {
      console.log('ERROR'.padEnd(18) + entry.name.padEnd(nameWidth) + '  ' + item.error);
      continue;
    }

    const primary = statements[statements.length - 1];
    if (!primary) {
      console.log('NO STATEMENT'.padEnd(18) + entry.name.padEnd(nameWidth) + '  (the function ran no query)');
      continue;
    }

    const seqScans = primary.seqScans;
    const verdict = item.entry.expectSeqScan === true
      ? seqScans.length > 0 ? 'seq (expected)' : 'NO SEQ, PREDICTED'
      : seqScans.length > 0 ? 'UNEXPECTED SEQ' : 'ok';

    console.log(
      verdict.padEnd(18) +
      entry.name.padEnd(nameWidth) +
      String(primary.rowsReturned).padStart(6) +
      String(primary.planMs).padStart(9) +
      '  ' +
      summarise(primary)
    );
  }
  console.log('');
}

function writePlans(captured: CapturedEntry[]): void {
  rmSync(PLANS_DIR, { recursive: true, force: true });
  mkdirSync(PLANS_DIR, { recursive: true });

  for (const item of captured) {
    if (item.statements.length === 0) continue;
    const document = item.statements.map((statement, index) => ({
      statement: index,
      sql: statement.sql,
      planMs: statement.planMs,
      execMs: statement.execMs,
      rowsReturned: statement.rowsReturned,
      // The compared signature, plus the full node list, which is what somebody
      // investigating a diff actually wants to read.
      signature: { indexes: statement.indexes, seqScans: statement.seqScans, sorts: statement.sorts },
      scans: planScans(statement.plan),
      plan: statement.plan,
    }));
    writeFileSync(join(PLANS_DIR, `${item.entry.name}.json`), JSON.stringify(document, null, 2));
  }
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
}

function signatureMap(captured: CapturedEntry[]): Record<string, PlanSignature[]> {
  const signatures: Record<string, PlanSignature[]> = {};
  for (const item of captured) {
    if (item.statements.length === 0) continue;
    signatures[item.entry.name] = item.statements.map(({ sql: _sql, planMs: _p, execMs: _e, plan: _j, ...signature }) => signature);
  }
  return signatures;
}

export async function capture(options: { mode: 'report' | 'check' | 'update' }): Promise<void> {
  const client = connect();
  await client.connect();

  try {
    for (const [name, value] of Object.entries(SESSION_SETTINGS)) {
      await client.query(`SET ${name} = '${value}'`);
    }

    const fixtures = await loadFixtures(client);

    // Fresh statistics before every capture: the plan for a table whose stats
    // were gathered before the last load is a plan for a different table.
    console.log('analyzing...');
    for (const table of SEEDED_TABLES) await client.query(`ANALYZE ${table}`);

    console.log('warm-up pass...');
    await runCatalog(client, fixtures, false);

    console.log('capturing...');
    const captured = await runCatalog(client, fixtures, true);

    writePlans(captured);
    printTable(captured);

    const environment = await environmentFingerprint(client);
    const indexes = await indexInventory(client);

    if (options.mode === 'update' || options.mode === 'report') {
      if (options.mode === 'update') {
        const baseline: Baseline = { environment, indexes, entries: signatureMap(captured) };
        writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
        console.log(`baseline written to ${BASELINE_PATH} (${Object.keys(baseline.entries).length} entries)`);
      }
    }

    if (options.mode !== 'update') {
      const baseline = loadBaseline();
      if (!baseline) {
        // A check that cannot check is not a pass. `npm run explain` is the
        // mode to use before a baseline exists.
        console.log('no baseline yet — run `npm run explain:update` to record one');
        if (options.mode === 'check') process.exit(2);
        return;
      }

      if (baseline.environment['seed.version'] !== environment['seed.version']) {
        console.error(
          `\nbaseline was captured against ${baseline.environment['seed.version']}, database is ${environment['seed.version']}.`
        );
        console.error('re-run `npm run explain:seed` and `npm run explain:update`; a diff here means nothing.');
        process.exit(2);
      }

      const current = signatureMap(captured);
      const removedIndexes = baseline.indexes.filter(name => !indexes.includes(name));
      const addedIndexes = indexes.filter(name => !baseline.indexes.includes(name));

      let failures = 0;

      for (const [name, baselineSignatures] of Object.entries(baseline.entries)) {
        const currentSignatures = current[name];
        if (!currentSignatures) {
          console.log(`MISSING   ${name} — in the baseline but not captured`);
          failures++;
          continue;
        }

        const deltas: Delta[] = [];
        for (let i = 0; i < Math.max(baselineSignatures.length, currentSignatures.length); i++) {
          const before = baselineSignatures[i];
          const now = currentSignatures[i];
          if (!before || !now) {
            deltas.push({ kind: 'sql-changed', detail: 'statement count changed' });
            continue;
          }
          deltas.push(...diffSignatures(before, now));
        }

        if (deltas.length > 0) {
          failures++;
          console.log(`CHANGED   ${name}`);
          for (const delta of deltas) console.log(`            ${delta.kind}: ${delta.detail}`);
        }
      }

      for (const name of Object.keys(current)) {
        if (!baseline.entries[name]) {
          failures++;
          console.log(`NEW       ${name} — captured but not in the baseline`);
        }
      }

      for (const index of removedIndexes) {
        failures++;
        console.log(`INDEX DROPPED  ${index} — present in the baseline, missing now`);
      }
      for (const index of addedIndexes) {
        failures++;
        console.log(`INDEX ADDED    ${index} — new since the baseline`);
      }

      if (failures === 0) {
        console.log(`clean: ${Object.keys(current).length} entries match the baseline`);
        return;
      }

      if (options.mode === 'check') {
        console.error(`\n${failures} regression(s) against the baseline`);
        process.exit(1);
      }
    }
  } finally {
    await client.end();
  }
}
