import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { ExportLimiter, hasExportPermission, writeDatabaseExport } from './export';
import { hashApiKey } from './keys';

test('export limiter enforces per-key windows and releases concurrency exactly once', () => {
  const limiter = new ExportLimiter(1, 1);
  assert.equal(limiter.allow('key', 1000), true);
  assert.equal(limiter.allow('key', 2000), false);
  assert.equal(limiter.allow('other', 2000), true);
  const release = limiter.acquire();
  assert.ok(release);
  assert.equal(limiter.acquire(), null);
  release(); release();
  assert.equal(limiter.activeCount, 0);
  assert.ok(limiter.acquire());
});

test('export permission hashes plaintext key and requires active permission', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = { query: async (sql: string, params: unknown[]) => {
    queries.push({ sql, params }); return { rowCount: 1, rows: [{}] };
  } } as unknown as Pool;
  const key = `lum_${'a'.repeat(64)}`;
  assert.equal(await hasExportPermission(pool, key), true);
  assert.deepEqual(queries[0].params, [hashApiKey(key)]);
  assert.match(queries[0].sql, /revoked_at IS NULL AND export_enabled = TRUE/);
});

test('database export streams bounded batches from allowlisted tables', async () => {
  const queries: string[] = [];
  const pool = { query: async (sql: string, params: unknown[]) => {
    queries.push(sql);
    return { rows: params[1] === 0 ? [{ id: 'sample', sequence: 100 }] : [] };
  } } as unknown as Pool;
  const lines: string[] = [];
  const result = await writeDatabaseExport(pool, async line => { lines.push(line); return true; });
  assert.equal(lines.length, 7);
  assert.match(lines[0], /"table":"ledgers"/);
  assert.equal(result.maxLedger, 100);
  assert.ok(queries.every(query => /LIMIT \$1 OFFSET \$2/.test(query)));
  assert.ok(queries.every(query => !query.includes('api_keys')));
});

test('incremental export filters rows after given ledger and returns max exported ledger', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = { query: async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes('ledgers')) {
      return { rows: params[1] === 0 ? [{ sequence: '105' }, { sequence: '110' }] : [] };
    }
    if (sql.includes('transactions')) {
      return { rows: params[1] === 0 ? [{ hash: 'tx1', ledger: '110' }] : [] };
    }
    if (sql.includes('operations')) {
      return { rows: params[1] === 0 ? [{ id: 'op1', ledger: '108' }] : [] };
    }
    if (sql.includes('accounts')) {
      return { rows: params[1] === 0 ? [{ address: 'acc1', last_modified_ledger: '109' }] : [] };
    }
    if (sql.includes('contract_events')) {
      return { rows: params[1] === 0 ? [{ id: 'ev1', ledger: '110' }] : [] };
    }
    if (sql.includes('custom_events')) {
      return { rows: params[1] === 0 ? [{ event_id: 'cev1', ledger: '107' }] : [] };
    }
    return { rows: [] };
  } } as unknown as Pool;

  const lines: string[] = [];
  const result = await writeDatabaseExport(pool, async line => { lines.push(line); return true; }, { sinceLedger: 100 });
  
  // 6 tables with ledger columns (contract_schemas has no ledger and is excluded in incremental sync)
  assert.equal(lines.length, 7);
  assert.equal(result.maxLedger, 110);
  assert.ok(queries.every(q => !q.sql.includes('contract_schemas')));
  assert.ok(queries.every(q => q.sql.includes('> $3') && q.params[2] === 100));
});

test('incremental export with early stop returns latest maxLedger seen so far', async () => {
  const pool = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('ledgers')) {
      return { rows: [{ sequence: '50' }, { sequence: '55' }] };
    }
    return { rows: [] };
  } } as unknown as Pool;

  let count = 0;
  const result = await writeDatabaseExport(pool, async () => {
    count++;
    return count < 1; // stop on first line
  }, { sinceLedger: 40 });

  assert.equal(result.maxLedger, 50);
});

