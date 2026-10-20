#!/usr/bin/env node
/**
 * Assets index audit: load a real asset population, replay real mainnet traffic
 * through the indexer's own asset write path, then run the API's own asset
 * queries, and measure what every index on the table costs and what reads it.
 *
 * ## Why both a population and a replay
 *
 * `assets` is written and read by different code at very different rates. The
 * write side (processAssetOperation) touches a handful of popular rows over and
 * over: every credit payment rewrites last_activity_ledger on its asset. The
 * read side (getAssets, getAssetByKey) sorts and pages the whole table. A
 * replay alone leaves a few hundred rows, too few for any read plan to mean
 * anything; a population alone has no writes. So `run` seeds the asset sets
 * Horizon reports for mainnet and testnet (one deployment can hold both; see
 * docs/MULTI_NETWORK.md), replays the cached mainnet operations on top, and
 * then drives the real read functions from graphql-server/src/assets.ts.
 *
 * ## Usage
 *
 *   npm run audit:assets -- fetch [pages]          # cache mainnet operations (shared with audit:trustlines)
 *   npm run audit:assets -- fetch-assets [pages]   # cache asset populations, [pages] per code prefix
 *   npm run audit:assets -- run [label]            # seed, replay, read, report; scratch database only
 *   npm run audit:assets -- report                 # stats only, e.g. on a deployment
 *
 * `run` refuses a database whose `assets` table is not empty. Apply the index
 * variant under test to the scratch database before running it. `report` is
 * read-only and is the same SQL as db/audit/assets.sql.
 *
 * Reads AUDIT_DATABASE_URL, falling back to DATABASE_URL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { processAssetOperation } from '../../indexer/src/db';
import { getAssetByKey, getAssets } from '../../graphql-server/src/assets';
import { fetchOps, horizonGet, loadOps, opsByLedger } from './horizonOps';

const DATABASE_URL = process.env.AUDIT_DATABASE_URL ?? process.env.DATABASE_URL;
const CACHE_DIR = join(__dirname, '.cache');
const POPULATIONS: Record<string, string> = {
  mainnet: process.env.AUDIT_HORIZON_URL ?? 'https://horizon.stellar.org',
  testnet: process.env.AUDIT_TESTNET_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
};
// Horizon pages /assets in code order, so a straight walk from the start is
// all numeric codes. Starting one walk per leading character spreads the
// sample across the alphabet the way search terms are.
const PREFIXES = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'];
const MIN_ISSUER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

interface PopulationAsset { code: string; issuer: string; holders: number; }

function populationPath(network: string): string {
  return join(CACHE_DIR, `assets-${network}.json`);
}

async function fetchAssets(pagesPerPrefix: number): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const [network, horizon] of Object.entries(POPULATIONS)) {
    const seen = new Map<string, PopulationAsset>();
    const walk = async (prefix: string) => {
      // A cursor must be a whole paging token (code_issuer_type, with a valid
      // issuer); the all-zero key is the first possible issuer for the code.
      let cursor = encodeURIComponent(`${prefix}_${MIN_ISSUER}_credit_alphanum4`);
      for (let page = 0; page < pagesPerPrefix; page++) {
        const body = await horizonGet<{ _embedded: { records: {
          asset_code: string; asset_issuer: string; paging_token: string;
          accounts: { authorized: number; authorized_to_maintain_liabilities: number };
        }[] } }>(`${horizon}/assets?order=asc&limit=200&cursor=${cursor}`);
        const records = body._embedded.records;
        if (records.length === 0) return;
        for (const r of records) {
          // Horizon counts trustlines, including empty ones; holder_count counts
          // positive balances. Authorized trustlines are the closer of the two.
          const holders = r.accounts.authorized + r.accounts.authorized_to_maintain_liabilities;
          seen.set(`${r.asset_code}:${r.asset_issuer}`, { code: r.asset_code, issuer: r.asset_issuer, holders });
        }
        cursor = encodeURIComponent(records[records.length - 1].paging_token);
      }
    };
    // A few walks at a time keeps well inside Horizon's per-IP rate limit.
    for (let i = 0; i < PREFIXES.length; i += 6) {
      await Promise.all(PREFIXES.slice(i, i + 6).map(walk));
      process.stderr.write(`${network}: ${seen.size} assets after prefix ${PREFIXES[Math.min(i + 5, PREFIXES.length - 1)]}\n`);
    }
    writeFileSync(populationPath(network), JSON.stringify([...seen.values()]));
    console.log(`cached ${seen.size} ${network} assets to ${populationPath(network)}`);
  }
}

/** Deterministic PRNG so every variant seeds and samples the same rows. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-index and per-table counters, read on a fresh connection after a flush. */
async function counters(): Promise<{ table: Record<string, number>; indexes: Record<string, number> }> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows: [table] } = await client.query(
      `SELECT seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_hot_upd
         FROM pg_stat_user_tables WHERE relname = 'assets'`
    );
    const { rows } = await client.query(
      `SELECT indexrelname AS name, idx_scan FROM pg_stat_user_indexes WHERE relname = 'assets'`
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

async function seed(pool: Pool, fromLedger: number): Promise<Record<string, number>> {
  const random = mulberry32(1);
  const seeded: Record<string, number> = {};
  for (const network of Object.keys(POPULATIONS)) {
    if (!existsSync(populationPath(network))) throw new Error(`no ${network} population; run "fetch-assets" first`);
    const assets = JSON.parse(readFileSync(populationPath(network), 'utf8')) as PopulationAsset[];
    // Ledger columns are synthetic: Horizon does not report them, and no live
    // query filters or sorts on them. They only need to be valid and spread out.
    const last = assets.map(() => fromLedger - Math.floor(random() * 5_000_000));
    const first = last.map(l => Math.max(1, l - Math.floor(random() * 5_000_000)));
    for (let i = 0; i < assets.length; i += 10_000) {
      const chunk = assets.slice(i, i + 10_000);
      await pool.query(
        `INSERT INTO assets (asset_code, asset_issuer, holder_count, first_seen_ledger, last_activity_ledger, network)
         SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::bigint[], $5::bigint[], $6::text[])
         ON CONFLICT DO NOTHING`,
        [chunk.map(a => a.code), chunk.map(a => a.issuer), chunk.map(a => a.holders),
         first.slice(i, i + 10_000), last.slice(i, i + 10_000), chunk.map(() => network)]
      );
    }
    seeded[network] = assets.length;
  }
  await pool.query('VACUUM ANALYZE assets');
  return seeded;
}

async function replay(pool: Pool) {
  const cache = loadOps();
  const byLedger = opsByLedger(cache);
  // Start from a checkpoint so every variant pays the same full-page writes:
  // without it, WAL depends on where the last checkpoint happened to fall.
  await pool.query('CHECKPOINT').catch(() => process.stderr.write('CHECKPOINT not permitted; WAL will be noisier\n'));
  const { rows: [{ lsn: walBefore }] } = await pool.query<{ lsn: string }>('SELECT pg_current_wal_lsn() AS lsn');
  const client = await pool.connect();
  const started = process.hrtime.bigint();
  let failed = 0;
  try {
    for (const [ledger, ops] of byLedger) {
      await client.query('BEGIN');
      for (const op of ops) {
        await client.query('SAVEPOINT op');
        try {
          await processAssetOperation(client, 'mainnet', ledger, op);
          await client.query('RELEASE SAVEPOINT op');
        } catch {
          // Same as the trustlines replay: count a bad op, keep the ledger.
          failed++;
          await client.query('ROLLBACK TO SAVEPOINT op');
        }
      }
      await client.query('COMMIT');
    }
  } finally {
    client.release();
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const { rows: [{ bytes }] } = await pool.query<{ bytes: string }>(
    'SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1) AS bytes', [walBefore]
  );
  return {
    ledgers: `${cache.fromLedger}-${cache.toLedger}`,
    ledgersWithAssetOps: byLedger.size,
    assetOperations: cache.ops.length,
    failedOperations: failed,
    elapsedMs: Math.round(elapsedMs),
    walBytes: Number(bytes),
  };
}

interface Captured { label: string; text: string; values: unknown[]; }

/**
 * Drive the API's read functions with a fixed workload, capturing each
 * statement they send so it can be EXPLAINed exactly as sent.
 */
async function reads(pool: Pool): Promise<Captured[]> {
  const captured: Captured[] = [];
  let label = '';
  const capturing = {
    query: (text: string, values: unknown[]) => {
      captured.push({ label, text, values });
      return pool.query(text, values);
    },
  } as unknown as Pool;

  for (const network of Object.keys(POPULATIONS)) {
    // Point lookups: assetByKey on a deterministic sample of real keys.
    const random = mulberry32(2);
    const { rows: keys } = await pool.query<{ asset_code: string; asset_issuer: string }>(
      'SELECT asset_code, asset_issuer FROM assets WHERE network = $1 ORDER BY asset_code, asset_issuer', [network]
    );
    label = `${network} assetByKey`;
    for (let i = 0; i < 200; i++) {
      const k = keys[Math.floor(random() * keys.length)];
      await getAssetByKey(capturing, network, k.asset_code, k.asset_issuer);
    }

    // The default listing, then its keyset pages as a client scrolls.
    for (const sortBy of ['HOLDERS', 'VOLUME'] as const) {
      let cursor: string | null = null;
      for (let page = 1; page <= 10; page++) {
        label = `${network} assets ${sortBy} page ${page}`;
        const result = await getAssets(capturing, { network, sortBy, limit: 20, cursor });
        cursor = result.pageInfo.cursor;
        if (!cursor) break;
      }
    }

    // A keyset page from the middle of the network's assets, where most rows
    // have one or two holders: what a client scrolling far, or a crawler, sends.
    const { rows: [mid] } = await pool.query<{ holder_count: number; asset_code: string; asset_issuer: string }>(
      `SELECT holder_count, asset_code, asset_issuer FROM assets WHERE network = $1
        ORDER BY holder_count DESC, asset_code, asset_issuer
       OFFSET (SELECT count(*) / 2 FROM assets WHERE network = $1) LIMIT 1`, [network]
    );
    label = `${network} assets HOLDERS mid-table cursor`;
    await getAssets(capturing, {
      network, sortBy: 'HOLDERS', limit: 20, cursor: `${mid.holder_count}|${mid.asset_code}|${mid.asset_issuer}`,
    });

    // Search: common codes, a rare one, and one that matches nothing.
    for (const term of ['USD', 'BTC', 'AQUA', 'yUSDC', 'zzqx']) {
      label = `${network} assets HOLDERS search ${term}`;
      await getAssets(capturing, { network, sortBy: 'HOLDERS', search: term, limit: 20 });
    }
  }
  return captured;
}

interface PlanSummary {
  label: string;
  scans: string[];
  buffers: number;
  rowsRemovedByFilter: number;
  ms: number;
}

/** The scan nodes on `assets`, total shared buffers, and median execution time of 5 runs. */
async function explain(pool: Pool, statement: Captured): Promise<PlanSummary> {
  const times: number[] = [];
  let plan: any;
  for (let i = 0; i < 5; i++) {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, statement.values);
    plan = rows[0]['QUERY PLAN'][0];
    times.push(plan['Execution Time']);
  }
  const scans: string[] = [];
  let removed = 0;
  const visit = (node: any) => {
    if (node['Relation Name'] === 'assets') {
      scans.push(node['Index Name'] ? `${node['Node Type']} ${node['Index Name']}` : node['Node Type']);
      removed += (node['Rows Removed by Filter'] ?? 0) * (node['Actual Loops'] ?? 1);
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan.Plan);
  times.sort((a, b) => a - b);
  return {
    label: statement.label,
    scans,
    buffers: plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks'],
    rowsRemovedByFilter: removed,
    ms: Math.round(times[2] * 1000) / 1000,
  };
}

async function run(label: string): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const { rows: [{ n }] } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM assets');
  if (Number(n) !== 0) throw new Error('assets is not empty; run needs a scratch database');

  const seeded = await seed(pool, loadOps().fromLedger);
  await flush(pool);
  const c0 = await counters();
  const writes = await replay(pool);
  await flush(pool);
  const c1 = await counters();
  const statements = await reads(pool);
  await flush(pool);
  const c2 = await counters();

  // One plan per distinct label (the first statement sent under it): the 200
  // point lookups plan identically, and so does every getAssetByKey subquery.
  const plans: PlanSummary[] = [];
  const explained = new Set<string>();
  for (const s of statements) {
    if (explained.has(s.label)) continue;
    explained.add(s.label);
    plans.push(await explain(pool, s));
  }
  const { rows: [sizes] } = await pool.query(
    `SELECT pg_relation_size('assets') AS heap_bytes, pg_indexes_size('assets') AS index_bytes,
            (SELECT count(*) FROM assets) AS rows`
  );
  await pool.end();

  const result = {
    label,
    seeded,
    writes: { ...writes, ...delta(c0, c1) },
    reads: { statements: statements.length, ...delta(c1, c2) },
    sizes: Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, Number(v)])),
    plans,
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `assets-run-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, plans: undefined }, null, 2));
  console.table(plans);
  await report();
}

async function report(): Promise<void> {
  // A fresh connection: cumulative statistics are read at transaction start, and
  // a session that has been writing may not see its own counters flushed yet.
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const sql = readFileSync(join(__dirname, 'assets.sql'), 'utf8');
    // The file is a sequence of labelled statements: `-- name: <label>` above each.
    for (const chunk of sql.split(/^-- name: /m).slice(1)) {
      const [name, ...body] = chunk.split('\n');
      const { rows } = await client.query(body.join('\n'));
      console.log(`\n## ${name.trim()}`);
      console.table(rows);
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === 'fetch') return fetchOps(Number(arg ?? 500));
  if (command === 'fetch-assets') return fetchAssets(Number(arg ?? 4));
  if (!DATABASE_URL) throw new Error('set AUDIT_DATABASE_URL or DATABASE_URL');
  if (command === 'run') return run(arg ?? 'current');
  if (command === 'report') return report();
  console.error('Usage: assets <fetch [pages] | fetch-assets [pages] | run [label] | report>');
  process.exit(2);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
