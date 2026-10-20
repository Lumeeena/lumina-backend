#!/usr/bin/env node
/**
 * Trustlines index audit: replay real mainnet traffic through the indexer's own
 * trustline write path and measure what every index on the table costs and
 * whether anything reads it.
 *
 * ## Why replay rather than synthesise
 *
 * Index cost on `trustlines` is decided by the *shape* of the traffic: how many
 * writes are first sightings of an (account, asset) pair (an INSERT, which
 * touches every index) versus repeat payments on a pair already present (an
 * UPDATE, which may or may not be HOT). A synthetic generator would encode a
 * guess about that ratio and then measure the guess. Mainnet operations from
 * Horizon carry the real ratio, and `processAssetOperation` is the function the
 * indexer calls, so the statements are the ones production sends.
 *
 * ## Usage
 *
 *   npm run audit:trustlines -- fetch  [pages] # cache mainnet operations (once)
 *   npm run audit:trustlines -- replay        # apply the cached ops, report stats
 *   npm run audit:trustlines -- report        # stats only, e.g. on a deployment
 *
 * `replay` refuses to run against a database whose `trustlines` table is not
 * empty: it is a scratch-database tool, and the measurement is only meaningful
 * from a known starting point. `report` is read-only and is the one to run
 * against a real deployment — it is the same SQL as db/audit/trustlines.sql.
 *
 * Reads AUDIT_DATABASE_URL, falling back to DATABASE_URL.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { processAssetOperation } from '../../indexer/src/db';
import { fetchOps, loadOps, opsByLedger } from './horizonOps';

const DATABASE_URL = process.env.AUDIT_DATABASE_URL ?? process.env.DATABASE_URL;
const NETWORK = 'mainnet';

async function replay(): Promise<void> {
  const cache = loadOps();
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });

  const { rows: [{ n }] } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM trustlines');
  if (Number(n) !== 0) throw new Error('trustlines is not empty; replay needs a scratch database');

  const { rows: [{ lsn: walBefore }] } = await pool.query<{ lsn: string }>('SELECT pg_current_wal_lsn() AS lsn');

  // One transaction per ledger, as indexLedger does.
  const byLedger = opsByLedger(cache);

  const client = await pool.connect();
  const started = process.hrtime.bigint();
  let failed = 0;
  try {
    for (const [ledger, ops] of byLedger) {
      await client.query('BEGIN');
      for (const op of ops) {
        await client.query('SAVEPOINT op');
        try {
          await processAssetOperation(client, NETWORK, ledger, op);
          await client.query('RELEASE SAVEPOINT op');
        } catch {
          // A malformed amount or constraint failure on one op should not throw
          // away the ledger; the indexer would retry the ledger, which a replay
          // cannot usefully do. Counted and reported instead.
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
  await pool.query('SELECT pg_stat_force_next_flush()');
  await pool.end();

  console.log(JSON.stringify({
    ledgers: `${cache.fromLedger}-${cache.toLedger}`,
    ledgersWithAssetOps: byLedger.size,
    operationsScanned: cache.scanned,
    assetOperations: cache.ops.length,
    failedOperations: failed,
    elapsedMs: Math.round(elapsedMs),
    walBytes: Number(bytes),
  }, null, 2));
  await report();
}

async function report(): Promise<void> {
  // A fresh connection: cumulative statistics are read at transaction start, and
  // a session that has been writing may not see its own counters flushed yet.
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const sql = readFileSync(join(__dirname, 'trustlines.sql'), 'utf8');
    // The file is a sequence of labelled statements: `-- name: <label>` above each.
    for (const chunk of sql.split(/^-- name: /m).slice(1)) {
      const [label, ...body] = chunk.split('\n');
      const { rows } = await client.query(body.join('\n'));
      console.log(`\n## ${label.trim()}`);
      console.table(rows);
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === 'fetch') return fetchOps(Number(arg ?? 500));
  if (!DATABASE_URL) throw new Error('set AUDIT_DATABASE_URL or DATABASE_URL');
  if (command === 'replay') return replay();
  if (command === 'report') return report();
  console.error('Usage: trustlines <fetch [pages] | replay | report>');
  process.exit(2);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
