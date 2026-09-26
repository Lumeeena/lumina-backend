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
