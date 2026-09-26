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

export async function writeDatabaseExport(pool: Pool, write: (line: string) => Promise<boolean>): Promise<void> {
  const batchSize = 500;
  for (const table of EXPORT_TABLES) {
    let offset = 0;
    while (true) {
      const result = await pool.query(
        `SELECT * FROM ${table.name} ORDER BY ${table.order} LIMIT $1 OFFSET $2`,
        [batchSize, offset]
      );
      for (const row of result.rows) {
        if (!await write(`${JSON.stringify({ table: table.name, record: row })}\n`)) return;
      }
      if (result.rows.length < batchSize) break;
      offset += batchSize;
    }
  }
}
