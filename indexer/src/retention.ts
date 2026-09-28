/**
 * Retention policy for indexed history.
 *
 * Every row the indexer writes is kept forever by default, which is a decision
 * nobody has made deliberately: a deployment indexing mainnet accumulates
 * without bound and the first conversation about it happens when the disk
 * fills. This module makes that decision configurable per table, and defaults
 * every window to "unlimited" so an existing deployment changes nothing until
 * an operator opts in.
 *
 * ## What is and is not prunable
 *
 * Only the tables that record *history* are prunable. The tables holding
 * current state are deliberately excluded, and the reason is in the schema
 * rather than in this file:
 *
 *   - `contract_storage_entries` keeps archived entries as rows with
 *     `state = 'archived'` precisely so a client can tell "archived" apart from
 *     "absent" (no row at all). Pruning them would collapse that distinction.
 *   - `accounts`, `contract_schemas`, `api_keys` and `exports` are current state
 *     or configuration, not a log.
 *   - `account_refresh_queue` and `retry_queue` are work queues that drain
 *     themselves; a retention window would only delete pending work.
 *
 * ## Chain time, not index time
 *
 * Cutoffs compare against each table's chain-time column (`created_at`, and
 * `closed_at` for `ledgers`) rather than `indexed_at`. An indexer that fell
 * behind for a day and caught up would have written a week of chain history in
 * a single `indexed_at` window, and a policy expressed in "days indexed" would
 * delete it immediately. "Keep 30 days" has to mean 30 days of the chain.
 *
 * ## Not blocking indexing
 *
 * Three things keep the prune off the indexing path:
 *
 *   1. It runs on its own timer (`runRetentionLoop` in index.ts), never inside
 *      the ledger loop, so a slow prune cannot delay a ledger write.
 *   2. It takes a dedicated pool client with a `lock_timeout`, so if the
 *      indexer is holding locks on the rows being pruned the prune gives way
 *      and retries next round rather than making the indexer wait behind it.
 *   3. Row deletion is batched with a bounded batch size, so no single
 *      transaction grows large enough to bloat WAL or hold a long snapshot.
 *
 * ## Why there is no partition-drop fast path
 *
 * `operations` is the table worth expiring most, and dropping a partition costs
 * the same whether it holds a thousand rows or a billion, where the equivalent
 * DELETE costs time and WAL proportional to what it removes. It was range-
 * partitioned by ledger for exactly that reason, and the partitioning was
 * reverted when `network` had to be added to the primary key — see the note on
 * the table in db/schema.sql.
 *
 * So the prune is a batched DELETE against a plain table. It is deliberately
 * not written to also handle the partitioned case: code for a schema that
 * nothing has is code nothing exercises, and the DELETE is correct for the
 * schema that is actually deployed. If the partitioning comes back, the fast
 * path belongs in `pruneTable` and the ordering below already puts it in the
 * right place.
 */

import type { Pool, PoolClient } from 'pg';
import { subsystem } from './logger';
import { retentionPrunedRows } from './metrics';

const log = subsystem('retention');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How long a prune statement may wait for a lock before yielding to the indexer. */
const PRUNE_LOCK_TIMEOUT_MS = 3_000;

/**
 * Upper bound on batches per table per round. A round that hits the cap leaves
 * the rest for the next interval, which is what "does not block indexing"
 * means in practice: the prune converges over several rounds instead of
 * monopolising the database on the first one.
 */
const MAX_BATCHES_PER_ROUND = 20;

export type RetentionTable =
  | 'operations'
  | 'transactions'
  | 'contract_events'
  | 'custom_events'
  | 'ledgers';

export interface RetentionSpec {
  table: RetentionTable;
  /** Chain-time column the cutoff is compared against. */
  timeColumn: string;
}

/**
 * Prune order. Children before parents, because `operations` and `transactions`
 * carry foreign keys into each other and `transactions` into `ledgers`:
 * deleting a parent row first fails the FK. `contract_events` and
 * `custom_events` are independent leaves.
 */
export const RETENTION_SPECS: readonly RetentionSpec[] = [
  { table: 'operations', timeColumn: 'created_at' },
  { table: 'transactions', timeColumn: 'created_at' },
  { table: 'contract_events', timeColumn: 'created_at' },
  { table: 'custom_events', timeColumn: 'created_at' },
  { table: 'ledgers', timeColumn: 'closed_at' },
];

export const RETENTION_TABLES: readonly RetentionTable[] = RETENTION_SPECS.map(spec => spec.table);

/** Window lengths in days. `0` means "keep everything" — the default for all. */
export type RetentionWindows = Record<RetentionTable, number>;

export interface RetentionReport {
  table: RetentionTable;
  days: number;
  cutoff: Date;
  rowsPruned: number;
  /** True when the table was given no window and so was left alone. */
  skipped: boolean;
}

/** The window that keeps everything, used as the default for every table. */
export function unlimitedRetentionWindows(): RetentionWindows {
  return {
    operations: 0,
    transactions: 0,
    contract_events: 0,
    custom_events: 0,
    ledgers: 0,
  };
}

/** True when at least one table has a window, i.e. there is anything to prune. */
export function isRetentionEnabled(windows: RetentionWindows): boolean {
  return RETENTION_TABLES.some(table => windows[table] > 0);
}

/** Tables with a window, in prune order. */
export function retainedTables(windows: RetentionWindows): RetentionTable[] {
  return RETENTION_TABLES.filter(table => windows[table] > 0);
}

/** The instant before which data is outside the window. */
export function retentionCutoff(days: number, now: number = Date.now()): Date {
  return new Date(now - days * MS_PER_DAY);
}

/**
 * Catalog names are not user input, but they still reach SQL as identifiers
 * because `DROP TABLE` cannot be parameterised. Anything that is not a plain
 * unquoted identifier is refused rather than escaped, so a surprising catalog
 * value fails loudly instead of being interpolated.
 */
function isPlainIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function assertPlainIdentifier(name: string, what: string): string {
  if (!isPlainIdentifier(name)) {
    throw new Error(`Refusing to use ${what} as a SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Delete one batch of expired rows. Returns how many went.
 *
 * `ctid` is used as the batch key rather than the table's primary key because
 * that keeps one statement working for every table in RETENTION_SPECS, whose
 * keys differ (`(id, network)`, `(hash, network)`, `(event_id, event_name,
 * network)`, `(sequence, network)`). Under a concurrent update a row's ctid can
 * change between the scan and the delete, in which case it is simply left for
 * the next round — the alternative, re-checking each row, costs more than the
 * occasional repeat is worth.
 */
export async function deleteExpiredBatch(
  client: Pick<PoolClient, 'query'>,
  spec: RetentionSpec,
  cutoff: Date,
  batchSize: number
): Promise<number> {
  const table = assertPlainIdentifier(spec.table, 'a table name');
  const column = assertPlainIdentifier(spec.timeColumn, 'a column name');
  const result = await client.query<{ count: string }>(
    `DELETE FROM ${table}
      WHERE ctid IN (
        SELECT ctid FROM ${table} WHERE ${column} < $1 LIMIT $2
      )`,
    [cutoff, batchSize]
  );
  return Number(result.rowCount ?? 0);
}

/**
 * Prune one table: batched row deletes until the table is clean or the
 * per-round batch cap is reached.
 */
async function pruneTable(
  client: PoolClient,
  spec: RetentionSpec,
  days: number,
  batchSize: number,
  now: number
): Promise<RetentionReport> {
  const cutoff = retentionCutoff(days, now);
  const report: RetentionReport = {
    table: spec.table,
    days,
    cutoff,
    rowsPruned: 0,
    skipped: false,
  };

  for (let batch = 0; batch < MAX_BATCHES_PER_ROUND; batch += 1) {
    const deleted = await deleteExpiredBatch(client, spec, cutoff, batchSize);
    if (deleted === 0) break;
    report.rowsPruned += deleted;
    retentionPrunedRows.inc({ table: spec.table }, deleted);
    // The cap stops a huge backlog from monopolising the database in one
    // round; whatever is left is picked up by the next interval.
    if (batch === MAX_BATCHES_PER_ROUND - 1) {
      log.info({ table: spec.table, rowsPruned: report.rowsPruned }, 'retention batch cap reached; continuing next round');
    }
  }

  return report;
}

/**
 * Run one full retention pass over every table with a configured window.
 *
 * The pool client is taken for the duration of the pass and configured with a
 * `lock_timeout` so that a prune contending with the indexer is the thing that
 * waits. Without it the direction of the wait is decided by whichever
 * statement PostgreSQL happened to start first, and a large DELETE holding
 * `ROW EXCLUSIVE` would make ledger writes queue behind it — pruning would
 * then be the thing blocking indexing, which is the one outcome the issue
 * rules out.
 */
export async function pruneExpiredData(
  pool: Pool,
  windows: RetentionWindows,
  options: { batchSize?: number; now?: number } = {}
): Promise<RetentionReport[]> {
  const batchSize = options.batchSize ?? 10_000;
  const now = options.now ?? Date.now();
  const client = await pool.connect();
  try {
    await client.query(`SET lock_timeout = '${PRUNE_LOCK_TIMEOUT_MS}ms'`);
    const reports: RetentionReport[] = [];
    for (const spec of RETENTION_SPECS) {
      const days = windows[spec.table] ?? 0;
      if (days <= 0) {
        reports.push({
          table: spec.table, days, cutoff: retentionCutoff(0, now),
          rowsPruned: 0, skipped: true,
        });
        continue;
      }
      const report = await pruneTable(client, spec, days, batchSize, now);
      reports.push(report);
      if (report.rowsPruned > 0) {
        log.info(
          { table: report.table, days, cutoff: report.cutoff, rowsPruned: report.rowsPruned },
          'retention prune removed expired data'
        );
      }
    }
    return reports;
  } finally {
    client.release();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
