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
    return { rows: params[1] === 0 ? [{ id: 'sample' }] : [] };
  } } as unknown as Pool;
  const lines: string[] = [];
  await writeDatabaseExport(pool, async line => { lines.push(line); return true; });
  assert.equal(lines.length, 7);
  assert.match(lines[0], /"table":"ledgers"/);
  assert.ok(queries.every(query => /LIMIT \$1 OFFSET \$2/.test(query)));
  assert.ok(queries.every(query => !query.includes('api_keys')));
});
