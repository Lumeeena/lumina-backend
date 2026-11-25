/**
 * Export endpoints: the database dump and the CSV download.
 *
 * Four things live here: `ExportLimiter`, which caps how often and how many at
 * once a key can run an export; `hasExportPermission`, which checks a key is
 * allowed to export at all; `buildCsvExportStatement`, which builds the one
 * `COPY` statement in the codebase that is interpolated rather than bound; and
 * `writeDatabaseExport`, which streams every indexed table as JSON lines in
 * bounded batches and can resume from a ledger.
 */
import type { Pool } from 'pg';
import { hashApiKey } from './keys';

/**
 * Length of the sliding window used by `ExportLimiter.allow`, in milliseconds.
 *
 * One minute, to match the unit `perMinute` is expressed in. The same
 * requests-per-minute unit is used for API key rate limits (see `keys.ts`).
 */
const WINDOW_MS = 60_000;

/**
 * Tables that `writeDatabaseExport` streams, in the order they are written.
 *
 * `order` is the column each table is paged by. Paging requires a stable,
 * unique sort key; `custom_events` pages by a two-column key for that reason.
 */
const EXPORT_TABLES: Array<{ name: string; order: string }> = [
  { name: 'ledgers', order: 'sequence' },
  { name: 'transactions', order: 'hash' },
  { name: 'operations', order: 'id' },
  { name: 'accounts', order: 'address' },
  { name: 'contract_events', order: 'id' },
  { name: 'contract_schemas', order: 'contract_id' },
  { name: 'custom_events', order: 'event_id, event_name' },
];

/**
 * In-process limits on export requests: a per-key rate and a global concurrency cap.
 *
 * State lives in this process's memory, so each server instance enforces its
 * own limits and a key spread across instances can exceed `perMinute` in total.
 */
export class ExportLimiter {
  private readonly requests = new Map<string, number[]>();
  private active = 0;

  /**
   * @param perMinute Requests a single key may make in any `WINDOW_MS` window.
   *   Defaults to 2. The source does not record why this value was chosen.
   * @param maxConcurrent Exports that may run at once across all keys. Defaults
   *   to 2. The source does not record why this value was chosen.
   * @throws if either value is not a positive integer.
   */
  constructor(readonly perMinute = 2, readonly maxConcurrent = 2) {
    if (!Number.isInteger(perMinute) || perMinute < 1 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('Export limits must be positive integers');
    }
  }

  /**
   * Records a request for `key` if it is within the rate limit.
   *
   * This is a sliding window: a key may make `perMinute` requests in any
   * `WINDOW_MS` span, and each slot frees up one minute after its own request.
   * A refused request is not recorded, so refusals do not extend the window.
   *
   * @param key The key the request is charged to (the caller passes the key hash).
   * @param now Epoch milliseconds, injectable for tests. Defaults to `Date.now()`.
   * @returns `true` if the request was allowed and counted, `false` if refused.
   */
  allow(key: string, now = Date.now()): boolean {
    const current = (this.requests.get(key) ?? []).filter(time => now - time < WINDOW_MS);
    if (current.length >= this.perMinute) { this.requests.set(key, current); return false; }
    current.push(now);
    this.requests.set(key, current);
    return true;
  }

  /**
   * Takes one concurrency slot, if one is free.
   *
   * @returns A release function that frees the slot, or `null` when all
   *   `maxConcurrent` slots are taken (the caller should refuse the export).
   *   Calling the release function more than once frees the slot only once, so
   *   a `finally` block and an error handler can both call it safely.
   */
  acquire(): (() => void) | null {
    if (this.active >= this.maxConcurrent) return null;
    this.active += 1;
    let released = false;
    return () => { if (!released) { released = true; this.active -= 1; } };
  }

  /** Number of concurrency slots currently held. */
  get activeCount(): number { return this.active; }
}

/**
 * Whether the key's hash matches an active row with export enabled.
 *
 * The lookup is by SHA-256 of the plaintext key (see `hashApiKey`), so the
 * plaintext is never sent to the database. A key is refused when it is revoked
 * (`revoked_at` is set) or when `export_enabled` is false.
 *
 * @returns `true` only when exactly one row matches.
 */
export async function hasExportPermission(pool: Pool, plaintextKey: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL AND export_enabled = TRUE',
    [hashApiKey(plaintextKey)]
  );
  return result.rowCount === 1;
}

/**
 * Tables the CSV endpoint exports, each with the columns it can be filtered on.
 *
 * A map rather than a list because the statement builder interpolates these
 * values as *identifiers*: `COPY` cannot take bind parameters, so the only
 * thing standing between a request and the statement is this table. Keying by
 * table name means the two identifiers written into the statement are always
 * values that live here, never strings that arrived from a request.
 */
const CSV_EXPORT_TABLES: Record<string, { ledger: string; date: string }> = {
  ledgers: { ledger: 'sequence', date: 'closed_at' },
  transactions: { ledger: 'ledger', date: 'created_at' },
  operations: { ledger: 'ledger', date: 'created_at' },
};

/**
 * Optional bounds for a CSV export. Every field is `unknown` because the values
 * come straight from request parameters, and are canonicalised by
 * `buildCsvExportStatement` before use. A falsy value (absent, `''`, `0`) means
 * "no bound on this side".
 */
export interface CsvExportRange {
  minLedger?: unknown;
  maxLedger?: unknown;
  minDate?: unknown;
  maxDate?: unknown;
}

/**
 * The `COPY … TO STDOUT` statement for a CSV export, or null for a table that
 * is not on the allow-list.
 *
 * ## Why the values are interpolated rather than bound
 *
 * `COPY` is a utility statement and cannot take bind parameters — there is no
 * `COPY … WHERE x > $1` to write. So the values have to reach the statement as
 * text, and the safety argument is that they are canonicalised first: a ledger
 * bound becomes an integer through `parseInt` and can carry no quote or
 * semicolon, and a date becomes `Date.toISOString()` output, whose alphabet is
 * fixed. Anything that does not survive that (`NaN`, an invalid date) is
 * dropped rather than written.
 *
 * The identifiers are not canonicalised, they are looked up: the table name
 * indexes `CSV_EXPORT_TABLES`, and both column names are read out of the entry
 * it finds. Nothing from a request reaches the statement except through those
 * two normalisation steps, which is what makes this the one statement in the
 * codebase where interpolation is allowed — see docs/SQL_CONSTRUCTION.md.
 */
export function buildCsvExportStatement(table: string, range: CsvExportRange = {}): string | null {
  const columns = CSV_EXPORT_TABLES[table];
  if (!columns) return null;

  const clauses: string[] = [];
  for (const [value, operator, column] of [
    [range.minLedger, '>=', columns.ledger],
    [range.maxLedger, '<=', columns.ledger],
  ] as const) {
    // Falsy values are skipped, matching the endpoint's original guard: an
    // absent parameter and an empty string are both "no filter".
    if (!value) continue;
    const parsed = parseInt(String(value), 10);
    if (!isNaN(parsed)) clauses.push(`${column} ${operator} ${parsed}`);
  }
  for (const [value, operator, column] of [
    [range.minDate, '>=', columns.date],
    [range.maxDate, '<=', columns.date],
  ] as const) {
    // Falsy values are skipped, matching the endpoint's original guard: an
    // absent parameter and an empty string are both "no filter".
    if (!value) continue;
    const parsed = new Date(String(value));
    if (!isNaN(parsed.getTime())) clauses.push(`${column} ${operator} '${parsed.toISOString()}'`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return `COPY (SELECT * FROM ${table} ${where}) TO STDOUT WITH CSV HEADER`;
}

/**
 * Options for `writeDatabaseExport`.
 */
export interface ExportOptions {
  /**
   * Incremental mode: write only rows whose ledger is strictly greater than this
   * value. `null`, `undefined` and `NaN` all mean a full export. When set, a
   * table with no ledger column (`contract_schemas`) is skipped entirely, since
   * there is nothing to filter it on.
   */
  sinceLedger?: number | null;
}

/**
 * What `writeDatabaseExport` reports back once it has finished or stopped.
 */
export interface ExportResult {
  /**
   * The highest ledger value among the rows passed to `write`, or `null` if no
   * row carried one. The row whose `write` call returned `false` is included,
   * because the ledger is recorded before the write. Use this value as the next
   * `sinceLedger`, not as proof that every row up to it was delivered.
   */
  maxLedger: number | null;
}

/**
 * Ledger column used for the incremental filter, keyed by table name.
 *
 * `accounts` filters on `last_modified_ledger`, not on a ledger it was created in,
 * so an account is re-exported whenever it changes after the cursor.
 */
const LEDGER_COLUMN_BY_TABLE: Record<string, string> = {
  ledgers: 'sequence',
  transactions: 'ledger',
  operations: 'ledger',
  accounts: 'last_modified_ledger',
  contract_events: 'ledger',
  custom_events: 'ledger',
};

/**
 * Streams every allow-listed table to `write` as JSON lines, one row per line.
 *
 * Each line is `{"table": <name>, "record": <row>}` followed by `\n`. Tables are
 * written in `EXPORT_TABLES` order. Within a table, rows are read in pages of
 * `batchSize` ordered by the table's sort key, so memory use is bounded by one
 * page rather than the whole table.
 *
 * `write` is awaited for every line. Returning `false` stops the export at once:
 * no further rows are read and no further tables are started. The function then
 * resolves normally with the ledger reached so far. It does not reject.
 *
 * Failures from `pool.query` are not caught here and reject the returned promise.
 *
 * @param write Receives one line at a time. Return `false` to stop.
 * @param options Incremental-sync options. See `ExportOptions`.
 */
export async function writeDatabaseExport(
  pool: Pool,
  write: (line: string) => Promise<boolean>,
  options?: ExportOptions
): Promise<ExportResult> {
  // Page size for the LIMIT/OFFSET loop. Each page is one query and one result
  // set held in memory, so memory use is bounded by this number. A table of
  // 1,000,000 rows takes 2,000 queries at this size. The source does not record
  // why 500 was chosen.
  const batchSize = 500;
  const sinceLedger = options?.sinceLedger != null && !Number.isNaN(options.sinceLedger)
    ? options.sinceLedger
    : null;
  let maxLedger: number | null = null;

  for (const table of EXPORT_TABLES) {
    const ledgerCol = LEDGER_COLUMN_BY_TABLE[table.name];
    if (sinceLedger !== null && !ledgerCol) {
      continue;
    }

    let offset = 0;
    let hasMoreRows = true;
    while (hasMoreRows) {
      const query = sinceLedger !== null && ledgerCol
        ? `SELECT * FROM ${table.name} WHERE ${ledgerCol} > $3 ORDER BY ${table.order} LIMIT $1 OFFSET $2`
        : `SELECT * FROM ${table.name} ORDER BY ${table.order} LIMIT $1 OFFSET $2`;
      const params = sinceLedger !== null && ledgerCol
        ? [batchSize, offset, sinceLedger]
        : [batchSize, offset];

      const result = await pool.query(query, params);
      for (const row of result.rows) {
        if (ledgerCol && row[ledgerCol] != null) {
          const rowLedger = Number(row[ledgerCol]);
          if (!Number.isNaN(rowLedger)) {
            maxLedger = maxLedger === null ? rowLedger : Math.max(maxLedger, rowLedger);
          }
        }
        if (!await write(`${JSON.stringify({ table: table.name, record: row })}\n`)) {
          return { maxLedger };
        }
      }
      hasMoreRows = result.rows.length === batchSize;
      offset += batchSize;
    }
  }

  return { maxLedger };
}
