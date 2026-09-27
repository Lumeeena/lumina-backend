import type { Pool } from 'pg';
import { hashApiKey } from './keys';

const WINDOW_MS = 60_000;
const EXPORT_TABLES: Array<{ name: string; order: string }> = [
  { name: 'ledgers', order: 'sequence' },
  { name: 'transactions', order: 'hash' },
  { name: 'operations', order: 'id' },
  { name: 'accounts', order: 'address' },
  { name: 'contract_events', order: 'id' },
  { name: 'contract_schemas', order: 'contract_id' },
  { name: 'custom_events', order: 'event_id, event_name' },
];

export class ExportLimiter {
  private readonly requests = new Map<string, number[]>();
  private active = 0;
  constructor(readonly perMinute = 2, readonly maxConcurrent = 2) {
    if (!Number.isInteger(perMinute) || perMinute < 1 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('Export limits must be positive integers');
    }
  }
  allow(key: string, now = Date.now()): boolean {
    const current = (this.requests.get(key) ?? []).filter(time => now - time < WINDOW_MS);
    if (current.length >= this.perMinute) { this.requests.set(key, current); return false; }
    current.push(now);
    this.requests.set(key, current);
    return true;
  }
  acquire(): (() => void) | null {
    if (this.active >= this.maxConcurrent) return null;
    this.active += 1;
    let released = false;
    return () => { if (!released) { released = true; this.active -= 1; } };
  }
  get activeCount(): number { return this.active; }
}

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

export interface ExportOptions {
  sinceLedger?: number | null;
}

export interface ExportResult {
  maxLedger: number | null;
}

const LEDGER_COLUMN_BY_TABLE: Record<string, string> = {
  ledgers: 'sequence',
  transactions: 'ledger',
  operations: 'ledger',
  accounts: 'last_modified_ledger',
  contract_events: 'ledger',
  custom_events: 'ledger',
};

export async function writeDatabaseExport(
  pool: Pool,
  write: (line: string) => Promise<boolean>,
  options?: ExportOptions
): Promise<ExportResult> {
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
