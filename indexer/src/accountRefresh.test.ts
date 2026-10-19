import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { makeAccount } from '../../shared/test-factories';
import { refreshAccountQueueBatch } from './accountRefresh';


function fakePool(batches: Array<Array<Record<string, string | null>>>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const clientQueries: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('FROM account_refresh_queue q')) return { rows: batches.shift() ?? [] };
      return { rows: [] };
    },
    connect: async () => ({
      // Parameterised statements arrive as `{ text, values }`; record the text.
      query: async (sql: string | { text: string }) => {
        clientQueries.push(typeof sql === 'string' ? sql : sql.text);
        return { rows: [] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  return { pool, queries, clientQueries };
}

const network = 'testnet';
const horizonUrl = 'https://horizon.example.com';

test('refreshAccountQueueBatch fetches stale accounts and commits state with queue removal', async () => {
  const { pool, clientQueries } = fakePool([[
    { address: 'G-stale', last_requested_ledger: '100', last_modified_ledger: '99' },
  ]]);
  let fetchedAddress = '';

  const result = await refreshAccountQueueBatch(
    pool,
    network,
    horizonUrl,
    async (_url, address) => {
      fetchedAddress = address;
      return makeAccount({ account_id: address });
    },
    10
  );

  assert.equal(fetchedAddress, 'G-stale');
  assert.equal(result.requested, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.failures.length, 0);
  assert.ok(clientQueries.some(sql => sql.includes('INSERT INTO accounts')));
  assert.ok(clientQueries.some(sql => sql.includes('DELETE FROM account_refresh_queue')));
  assert.equal(clientQueries.at(-1), 'COMMIT');
});

test('refreshAccountQueueBatch stores account history inside the same transaction as the upsert', async () => {
  const { pool, clientQueries } = fakePool([[
    { address: 'G-history', last_requested_ledger: '100', last_modified_ledger: '99' },
  ]]);

  await refreshAccountQueueBatch(
    pool,
    network,
    horizonUrl,
    async (_url, address) => makeAccount({ account_id: address }),
    10
  );

  const upsert = clientQueries.findIndex(sql => sql.includes('INSERT INTO accounts'));
  const history = clientQueries.findIndex(sql => sql.includes('INSERT INTO account_state_history'));
  const commit = clientQueries.indexOf('COMMIT');
  assert.ok(upsert >= 0 && history > upsert, 'history is written after the accounts upsert');
  assert.ok(history < commit, 'history is written before COMMIT, so a rollback removes both');
});

test('refreshAccountQueueBatch skips a snapshot that already covers its request', async () => {
  const { pool, clientQueries } = fakePool([[
    { address: 'G-current', last_requested_ledger: '100', last_modified_ledger: '100' },
  ]]);
  let fetches = 0;

  const result = await refreshAccountQueueBatch(
    pool,
    network,
    horizonUrl,
    async () => {
      fetches++;
      return null;
    },
    10
  );

  assert.equal(fetches, 0);
  assert.equal(result.skipped, 1);
  assert.ok(clientQueries.some(sql => sql.includes('DELETE FROM account_refresh_queue')));
});

test('refreshAccountQueueBatch retains transient failures for a later retry', async () => {
  const { pool, queries, clientQueries } = fakePool([[
    { address: 'G-retry', last_requested_ledger: '100', last_modified_ledger: null },
  ]]);

  const result = await refreshAccountQueueBatch(
    pool,
    network,
    horizonUrl,
    async () => { throw new Error('temporary Horizon failure'); },
    10
  );

  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.address, 'G-retry');
  assert.ok(queries.some(query => query.sql.includes('UPDATE account_refresh_queue')));
  assert.deepEqual(clientQueries, []);
});
