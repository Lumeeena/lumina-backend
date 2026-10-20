#!/usr/bin/env node
/**
 * Operations index audit: replay a contiguous stretch of real mainnet ledgers
 * through the indexer's own write path, drive the API's own operation queries
 * against what landed, and measure what every index on `operations` costs and
 * what reads it.
 *
 * ## Why a replay, and why whole ledgers
 *
 * `operations` is the table the indexer writes most, and every index on it is
 * paid for on every one of those writes. The question the audit answers is
 * which of those indexes anything reads, so both sides have to be the real
 * code: `indexLedger` (indexer/src/db.ts) writes exactly what a deployment
 * writes — Horizon's payload in `details`, the GIN and expression indexes and
 * all — and the reads are the functions the resolvers call. Whole ledgers,
 * because `operations.transaction_hash` is a foreign key: an operation cannot
 * land without its transaction, and a sampled subset would have neither the
 * real per-ledger density nor the real mix of operation types.
 *
 * ## Usage
 *
 *   npm run audit:operations -- fetch [ledgers]   # cache mainnet ledgers, transactions, operations
 *   npm run audit:operations -- run [label]       # replay, read, report; scratch database only
 *   npm run audit:operations -- replay [label]    # replay only: write cost (WAL, time, sizes)
 *   npm run audit:operations -- report            # stats only, e.g. on a deployment
 *
 * `run` refuses a database whose `operations` table is not empty. Apply the
 * index variant under test to the scratch database before running it.
 * `report` is read-only and is the same SQL as db/audit/operations.sql.
 *
 * AUDIT_LEDGER_LIMIT replays only the first N cached ledgers;
 * AUDIT_REUSE_REPLAY=1 lets `run` measure reads on an already-replayed database.
 *
 * Reads AUDIT_DATABASE_URL, falling back to DATABASE_URL.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { Client, Pool } from 'pg';
import { indexLedger } from '../../indexer/src/db';
import { deleteExpiredBatch, RETENTION_SPECS } from '../../indexer/src/retention';
import type { HorizonLedger, HorizonOperation, HorizonTransaction } from '../../indexer/src/horizon';
import {
  getAccountLifecycle,
  getAccountOperations,
  getAccountOperationsInLedger,
  getOperations,
  getOperationsByTransactionHash,
  getOperationsByTransactionHashes,
} from '../../graphql-server/src/db';
import { getOperationsByAsset, parseAsset } from '../../graphql-server/src/search';
import { getAssetVolumeSeries } from '../../graphql-server/src/assets';
import { computeBalanceHistory } from '../../graphql-server/src/balanceHistory';
import { buildCsvExportStatement, writeDatabaseExport } from '../../graphql-server/src/export';
import { encodeCursor, KEYSETS } from '../../graphql-server/src/pagination';
import { HORIZON_URL, horizonGet } from './horizonOps';

const DATABASE_URL = process.env.AUDIT_DATABASE_URL ?? process.env.DATABASE_URL;
const CACHE_DIR = join(__dirname, '.cache');
// One JSON line per ledger: { ledger, transactions, operations }. Lines rather
// than one document because a thousand mainnet ledgers is ~0.5M operations,
// which is more than is comfortable to hold as one string.
const LEDGERS_CACHE = process.env.AUDIT_LEDGERS_CACHE ?? join(CACHE_DIR, 'mainnet-ledgers.jsonl');

interface Page<T> { _embedded: { records: T[] }; }
interface PagedRecord { paging_token: string; }

/** The ledger sequence a paging token belongs to: its high 32 bits. */
function ledgerOf(pagingToken: string): number {
  return Number(BigInt(pagingToken) >> 32n);
}

/**
 * Walk one Horizon collection forwards from `fromLedger`, handing each record to
 * `take`, until a record from `toLedger + 1` or later turns up.
 *
 * The three collections are walked rather than fetched per ledger because a
 * mainnet ledger is ~3 pages of operations and ~2 of transactions: paging the
 * collections costs about 60% of the per-ledger requests for the same records.
 * The records are the ones the indexer stores: `/operations` and
 * `/transactions` exclude failed transactions by default, exactly as the
 * per-ledger endpoints the indexer reads do.
 */
async function walk<T extends PagedRecord>(
  collection: string,
  fromLedger: number,
  toLedger: number,
  take: (record: T) => void
): Promise<number> {
  // Cursors are exclusive, and a ledger's own paging token is exactly
  // `sequence << 32`; one below it starts the walk at `fromLedger` itself.
  let cursor = ((BigInt(fromLedger) << 32n) - 1n).toString();
  let fetched = 0;
  for (;;) {
    const body = await horizonGet<Page<T>>(`${HORIZON_URL}/${collection}?order=asc&limit=200&cursor=${cursor}`);
    const records = body._embedded.records;
    if (records.length === 0) return fetched;
    for (const record of records) {
      const sequence = collection === 'ledgers'
        ? (record as unknown as { sequence: number }).sequence
        : ledgerOf(record.paging_token);
      if (sequence > toLedger) return fetched;
      take(record);
      fetched++;
    }
    cursor = records[records.length - 1].paging_token;
  }
}

/** The transaction fields indexLedger reads; the XDR envelopes are not stored, so not cached. */
const TRANSACTION_FIELDS = [
  'hash', 'ledger', 'created_at', 'source_account', 'fee_charged',
  'operation_count', 'successful', 'memo_type', 'memo',
] as const;

async function fetchLedgers(count: number): Promise<void> {
  // A fixed distance behind the tip, so the walk never chases a ledger that
  // has not closed yet.
  const tip = await horizonGet<Page<{ sequence: number }>>(`${HORIZON_URL}/ledgers?order=desc&limit=1`);
  const toLedger = tip._embedded.records[0].sequence - 100;
  const fromLedger = toLedger - count + 1;
  process.stderr.write(`fetching mainnet ledgers ${fromLedger}-${toLedger}\n`);

  const ledgers = new Map<number, unknown>();
  const transactions = new Map<number, Record<string, unknown>[]>();
  // Sequential, not concurrent: Horizon's anonymous rate limit is per IP, and
  // three walks at once trip it sooner than they finish.
  await walk<PagedRecord & { sequence: number }>('ledgers', fromLedger, toLedger, r => {
    ledgers.set(r.sequence, r);
  });
  await walk<PagedRecord & Record<string, unknown>>('transactions', fromLedger, toLedger, r => {
    const kept = Object.fromEntries(TRANSACTION_FIELDS.filter(k => k in r).map(k => [k, r[k]]));
    const list = transactions.get(r.ledger as number) ?? [];
    list.push(kept);
    transactions.set(r.ledger as number, list);
  });
  process.stderr.write(`  ${ledgers.size} ledgers, ${[...transactions.values()].reduce((n, l) => n + l.length, 0)} transactions\n`);

  // Operations arrive in ledger order, so each ledger's line is written as soon
  // as the walk moves past it, and at most one ledger is held in memory. They
  // are kept verbatim, `_links` included: indexLedger stores the record as-is,
  // and the replay has to store the same bytes a deployment does.
  mkdirSync(CACHE_DIR, { recursive: true });
  const out = createWriteStream(LEDGERS_CACHE);
  let next = fromLedger;
  let pending: unknown[] = [];
  let opCount = 0;
  const flushThrough = (sequence: number) => {
    for (; next <= sequence; next++) {
      const ledger = ledgers.get(next);
      if (!ledger) throw new Error(`Horizon returned no ledger ${next}`);
      out.write(`${JSON.stringify({ ledger, transactions: transactions.get(next) ?? [], operations: next === sequence ? pending : [] })}\n`);
    }
  };
  let current = fromLedger;
  await walk<PagedRecord>('operations', fromLedger, toLedger, r => {
    const sequence = ledgerOf(r.paging_token);
    if (sequence !== current) {
      flushThrough(current);
      pending = [];
      current = sequence;
    }
    pending.push(r);
    if (++opCount % 50_000 === 0) process.stderr.write(`  ${opCount} operations, ledger ${sequence}\n`);
  });
  flushThrough(current);
  pending = [];
  flushThrough(toLedger);
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  console.log(`cached ${count} ledgers (${fromLedger}-${toLedger}), ${opCount} operations, to ${LEDGERS_CACHE}`);
}

// ─── Replay: the indexer's write path ───────────────────────────────────────

interface CachedLedger {
  ledger: HorizonLedger;
  transactions: HorizonTransaction[];
  operations: HorizonOperation[];
}

async function* cachedLedgers(): AsyncGenerator<CachedLedger> {
  if (!existsSync(LEDGERS_CACHE)) throw new Error(`no cached ledgers at ${LEDGERS_CACHE}; run "fetch" first`);
  // AUDIT_LEDGER_LIMIT replays only the first N ledgers: the same input for
  // every variant, at a fraction of the time, for comparing write cost.
  const limit = Number(process.env.AUDIT_LEDGER_LIMIT ?? Infinity);
  let n = 0;
  for await (const line of createInterface({ input: createReadStream(LEDGERS_CACHE) })) {
    if (!line) continue;
    if (n++ >= limit) return;
    yield JSON.parse(line) as CachedLedger;
  }
}

/** Per-index and per-table counters for `operations`, read on a fresh connection after a flush. */
async function counters(): Promise<{ table: Record<string, number>; indexes: Record<string, number> }> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows: [table] } = await client.query(
      `SELECT seq_scan, seq_tup_read, idx_scan, n_tup_ins, n_tup_del FROM pg_stat_user_tables WHERE relname = 'operations'`
    );
    const { rows } = await client.query(
      `SELECT indexrelname AS name, idx_scan FROM pg_stat_user_indexes WHERE relname = 'operations'`
    );
    const indexes: Record<string, number> = {};
    for (const r of rows) indexes[r.name] = Number(r.idx_scan);
    return { table: Object.fromEntries(Object.entries(table).map(([k, v]) => [k, Number(v)])), indexes };
  } finally {
    await client.end();
  }
}

function delta(before: Awaited<ReturnType<typeof counters>>, after: Awaited<ReturnType<typeof counters>>) {
  const diff = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(Object.keys(b).map(k => [k, b[k] - (a[k] ?? 0)]));
  return { table: diff(before.table, after.table), indexes: diff(before.indexes, after.indexes) };
}

async function flush(pool: Pool): Promise<void> {
  await pool.query('SELECT pg_stat_force_next_flush()');
}

async function replay(pool: Pool) {
  // A checkpoint first, so every variant pays the same full-page writes:
  // without it, WAL depends on where the previous checkpoint happened to fall.
  await pool.query('CHECKPOINT').catch(() => process.stderr.write('CHECKPOINT not permitted; WAL will be noisier\n'));
  const { rows: [{ lsn: walBefore }] } = await pool.query<{ lsn: string }>('SELECT pg_current_wal_lsn() AS lsn');
  const started = process.hrtime.bigint();
  let ledgers = 0;
  let operations = 0;
  let first = 0;
  let last = 0;
  for await (const cached of cachedLedgers()) {
    await indexLedger(pool, 'mainnet', cached.ledger, cached.transactions, cached.operations);
    if (ledgers === 0) first = cached.ledger.sequence;
    last = cached.ledger.sequence;
    ledgers++;
    operations += cached.operations.length;
    if (ledgers % 250 === 0) process.stderr.write(`  replayed ${ledgers} ledgers, ${operations} operations\n`);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const { rows: [{ bytes }] } = await pool.query<{ bytes: string }>(
    'SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1) AS bytes', [walBefore]
  );
  return { ledgers: `${first}-${last}`, ledgerCount: ledgers, operations, elapsedMs: Math.round(elapsedMs), walBytes: Number(bytes) };
}

// ─── Reads: the API's own functions ──────────────────────────────────────────

interface Captured { label: string; text: string; values: unknown[]; }

/** A deterministic pick from a list, so every variant reads the same rows. */
function pick<T>(list: T[], i: number): T {
  return list[(i * 2_654_435_761) % list.length]!;
}

/**
 * The workload: each read function the API exposes over `operations`, driven
 * with arguments drawn from what landed — the busiest account and a quiet
 * one, a common type and a rare one, a hot asset and a cold one — and every
 * statement captured as sent, so it can be EXPLAINed exactly.
 */
async function reads(pool: Pool): Promise<Captured[]> {
  const captured: Captured[] = [];
  let label = '';
  const capturing = {
    query: (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const statement = typeof text === 'string' ? { text, values: values ?? [] } : { text: text.text, values: text.values ?? [] };
      captured.push({ label, ...statement });
      return pool.query(statement.text, statement.values);
    },
  } as unknown as Pool;
  const network = 'mainnet';

  // Parameters, chosen from the data rather than guessed.
  const { rows: accounts } = await pool.query<{ source_account: string; n: string }>(
    `SELECT source_account, count(*) AS n FROM operations GROUP BY source_account ORDER BY count(*) DESC, source_account`
  );
  const hot = accounts[0]!.source_account;
  const warm = accounts[Math.floor(accounts.length * 0.01)]!.source_account;
  const cold = accounts[accounts.length - 1]!.source_account;
  const { rows: types } = await pool.query<{ type: string; n: string }>(
    'SELECT type, count(*) AS n FROM operations GROUP BY type ORDER BY count(*) DESC'
  );
  const { rows: assets } = await pool.query<{ asset: string; n: string }>(
    `SELECT (details->>'asset_code') || ':' || (details->>'asset_issuer') AS asset, count(*) AS n FROM operations
      WHERE type = 'payment' AND details->>'asset_code' IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC`
  );
  const { rows: hashes } = await pool.query<{ transaction_hash: string }>(
    'SELECT DISTINCT transaction_hash FROM operations ORDER BY transaction_hash LIMIT 5000'
  );
  const { rows: created } = await pool.query<{ account: string }>(
    `SELECT details->>'account' AS account FROM operations WHERE type = 'create_account' ORDER BY id LIMIT 200`
  );
  const { rows: touched } = await pool.query<{ ledger: string; address: string }>(
    `SELECT ledger, details->>'to' AS address FROM operations WHERE type = 'payment' ORDER BY id LIMIT 2000`
  );
  const { rows: [range] } = await pool.query<{ min: Date; max: Date }>('SELECT min(created_at) AS min, max(created_at) AS max FROM operations');

  const walk = async (name: string, opts: Omit<Parameters<typeof getOperations>[1], 'network' | 'limit' | 'cursor'>, pages: number) => {
    let cursor: string | null = null;
    for (let page = 1; page <= pages; page++) {
      label = `${name} page ${page === 1 ? 1 : 'n'}`;
      const items = await getOperations(capturing, { network, limit: 20, cursor, ...opts });
      const lastItem = items[items.length - 1];
      if (!lastItem) break;
      cursor = encodeCursor(KEYSETS.operations.query, [lastItem.ledger, lastItem.id]);
    }
  };

  await walk('operations()', {}, 10);
  await walk('operations(account: hot)', { account: hot }, 5);
  await walk('operations(account: warm)', { account: warm }, 5);
  await walk('operations(account: cold)', { account: cold }, 2);
  await walk(`operations(type: ${types[0]!.type})`, { type: types[0]!.type }, 5);
  await walk(`operations(type: ${types[types.length - 1]!.type})`, { type: types[types.length - 1]!.type }, 2);

  label = 'Transaction.operations';
  for (let i = 0; i < 200; i++) await getOperationsByTransactionHash(capturing, network, pick(hashes, i).transaction_hash);
  label = 'Transaction.operations (batched)';
  for (let i = 0; i < 20; i++) {
    await getOperationsByTransactionHashes(capturing, network, Array.from({ length: 20 }, (_, j) => pick(hashes, i * 20 + j).transaction_hash));
  }
  for (const [name, address] of [['hot', hot], ['warm', warm], ['cold', cold]] as const) {
    label = `Account.operations (${name})`;
    await getAccountOperations(capturing, network, address, 10);
  }
  label = 'accountLifecycle';
  for (let i = 0; i < 50; i++) await getAccountLifecycle(capturing, network, pick(created, i).account, 20);
  label = 'accountActivity replay';
  for (let i = 0; i < 100; i++) {
    const t = pick(touched, i);
    await getAccountOperationsInLedger(capturing, network, Number(t.ledger), t.address);
  }
  for (const [name, asset] of [['hot', assets[0]!.asset], ['cold', assets[assets.length - 1]!.asset], ['native', 'XLM']] as const) {
    label = `operations(asset: ${name})`;
    await getOperationsByAsset(capturing, { network, asset, limit: 20 });
  }
  label = 'asset volume series (hot)';
  await getAssetVolumeSeries(capturing, network, parseAsset(assets[0]!.asset), { start: range!.min, end: range!.max, bucketSeconds: 900 });
  label = 'accountBalanceHistory (warm)';
  await computeBalanceHistory(capturing, network, warm, 'XLM', range!.min.toISOString(), range!.max.toISOString());

  // Exports. The CSV export is a COPY, which cannot be EXPLAINed, so its inner
  // SELECT — the part that reads the table — is what is run and captured.
  const { rows: [tip] } = await pool.query<{ max: string }>('SELECT max(ledger) AS max FROM operations');
  for (const [name, bounds] of [
    ['ledger range', { minLedger: Number(tip!.max) - 10, maxLedger: Number(tip!.max) }],
    ['date range', { minDate: new Date(range!.max.getTime() - 60_000).toISOString(), maxDate: range!.max.toISOString() }],
  ] as const) {
    label = `CSV export (${name})`;
    const copy = buildCsvExportStatement('operations', bounds)!;
    await capturing.query(copy.replace(/^COPY \((.*)\) TO STDOUT WITH CSV HEADER$/, '$1'));
  }
  label = 'incremental export (since ledger)';
  await writeDatabaseExport(capturing, async line => !line.startsWith('{"table":"operations"'), { sinceLedger: Number(tip!.max) - 10 });
  captured.splice(0, captured.length, ...captured.filter(c => !c.label.startsWith('incremental') || /FROM operations/.test(c.text)));
  return captured;
}

/**
 * The retention prune, for real, inside a transaction that is rolled back:
 * `operations` first, then `transactions`, whose delete checks the foreign key
 * from `operations` once per row. The statistics counters are not
 * transactional, so the index scans the prune and those checks made survive
 * the rollback, and the rows do not.
 */
async function prune(pool: Pool): Promise<{ operations: number; transactions: number; ms: number }> {
  const client = await pool.connect();
  try {
    // A cutoff a few batches deep, so the prune does what one round does: every
    // expired operation goes before any transaction can (the foreign key
    // refuses a transaction whose operations remain).
    const { rows: [{ cutoff }] } = await client.query<{ cutoff: Date }>(
      'SELECT created_at AS cutoff FROM operations ORDER BY created_at OFFSET 25000 LIMIT 1'
    );
    const started = Date.now();
    await client.query('BEGIN');
    let operations = 0;
    for (let n = -1; n !== 0;) {
      n = await deleteExpiredBatch(client, RETENTION_SPECS.find(s => s.table === 'operations')!, cutoff, 10_000);
      operations += n;
    }
    const transactions = await deleteExpiredBatch(client, RETENTION_SPECS.find(s => s.table === 'transactions')!, cutoff, 10_000);
    const ms = Date.now() - started;
    await client.query('ROLLBACK');
    return { operations, transactions, ms };
  } finally {
    client.release();
  }
}

interface PlanSummary {
  label: string;
  scans: string[];
  buffers: number;
  rowsRemovedByFilter: number;
  ms: number;
}

/** The scan nodes on `operations`, total shared buffers, and median execution time of 3 runs. */
async function explain(pool: Pool, statement: Captured): Promise<PlanSummary> {
  const times: number[] = [];
  let plan: any;
  for (let i = 0; i < 3; i++) {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, statement.values);
    plan = rows[0]['QUERY PLAN'][0];
    times.push(plan['Execution Time']);
  }
  const scans: string[] = [];
  let removed = 0;
  const visit = (node: any) => {
    if (node['Relation Name'] === 'operations') {
      scans.push(node['Index Name'] ? `${node['Node Type']} ${node['Index Name']}` : node['Node Type']);
      removed += (node['Rows Removed by Filter'] ?? 0) * (node['Actual Loops'] ?? 1);
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan.Plan);
  times.sort((a, b) => a - b);
  return {
    label: statement.label,
    scans: [...new Set(scans)],
    buffers: plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks'],
    rowsRemovedByFilter: removed,
    ms: Math.round(times[1] * 1000) / 1000,
  };
}

async function sizes(pool: Pool) {
  const { rows: [table] } = await pool.query(
    `SELECT (SELECT count(*) FROM operations) AS rows,
            pg_relation_size('operations') AS heap_bytes,
            pg_total_relation_size('operations') - pg_relation_size('operations') - pg_indexes_size('operations') AS toast_bytes,
            pg_indexes_size('operations') AS index_bytes`
  );
  const { rows: indexes } = await pool.query<{ name: string; bytes: string }>(
    `SELECT indexrelname AS name, pg_relation_size(indexrelid) AS bytes FROM pg_stat_user_indexes
      WHERE relname = 'operations' ORDER BY pg_relation_size(indexrelid) DESC`
  );
  return {
    ...Object.fromEntries(Object.entries(table).map(([k, v]) => [k, Number(v)])),
    indexes: Object.fromEntries(indexes.map(r => [r.name, Number(r.bytes)])),
  };
}

/** Replay only, into an empty scratch database: the write cost of a variant. */
async function replayOnly(label: string): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const { rows: [{ n }] } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM operations');
  if (Number(n) !== 0) throw new Error('operations is not empty; replay needs a scratch database');
  const writes = await replay(pool);
  const measured = await sizes(pool);
  await pool.end();
  const result = { label, writes, sizes: measured };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `operations-replay-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

async function run(label: string): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const { rows: [{ n }] } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM operations');
  // AUDIT_REUSE_REPLAY=1 measures the reads against a database an earlier run
  // already replayed into, without replaying again.
  const reuse = process.env.AUDIT_REUSE_REPLAY === '1' && Number(n) > 0;
  if (Number(n) !== 0 && !reuse) throw new Error('operations is not empty; run needs a scratch database');

  await flush(pool);
  const c0 = await counters();
  const writes = reuse ? null : await replay(pool);
  await pool.query('VACUUM (ANALYZE) operations');
  await pool.query('VACUUM (ANALYZE) transactions');
  await flush(pool);
  const c1 = await counters();
  const statements = await reads(pool);
  await flush(pool);
  const c2 = await counters();
  const pruned = await prune(pool);
  await flush(pool);
  const c3 = await counters();

  // One plan per distinct label: every point lookup under a label plans alike.
  const plans: PlanSummary[] = [];
  const explained = new Set<string>();
  for (const statement of statements) {
    if (explained.has(statement.label)) continue;
    explained.add(statement.label);
    plans.push(await explain(pool, statement));
  }
  const measured = await sizes(pool);
  await pool.end();

  const result = {
    label,
    writes: writes ? { ...writes, ...delta(c0, c1) } : null,
    reads: { statements: statements.length, ...delta(c1, c2) },
    prune: { ...pruned, ...delta(c2, c3) },
    sizes: measured,
    plans,
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `operations-run-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, plans: undefined }, null, 2));
  console.table(plans);
}

async function report(): Promise<void> {
  // A fresh connection: cumulative statistics are read at transaction start.
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const sql = readFileSync(join(__dirname, 'operations.sql'), 'utf8');
    // The file is a sequence of labelled statements: `-- name: <label>` above each.
    for (const chunk of sql.split(/^-- name: /m).slice(1)) {
      const [name, ...body] = chunk.split('\n');
      console.log(`\n## ${name.trim()}`);
      try {
        const { rows } = await client.query(body.join('\n'));
        console.table(rows);
      } catch (err) {
        // pg_stat_statements is optional; one missing view should not hide the rest.
        console.log(`(not available: ${err instanceof Error ? err.message : err})`);
      }
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === 'fetch') return fetchLedgers(Number(arg ?? 1000));
  if (!DATABASE_URL) throw new Error('set AUDIT_DATABASE_URL or DATABASE_URL');
  if (command === 'run') return run(arg ?? 'current');
  if (command === 'replay') return replayOnly(arg ?? 'current');
  if (command === 'report') return report();
  console.error('Usage: operations <fetch [ledgers] | run [label] | replay [label] | report>');
  process.exit(2);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
