import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import { ensurePartitions, getLatestIndexedEventLedger, getLatestIndexedLedger, indexLedger, insertContractEvents, upsertAccount } from './db';
import type { HorizonAccount, HorizonLedger, HorizonOperation, HorizonTransaction } from './horizon';
import type { ContractEvent } from './soroban';

function makeFakeClient(opts: { failOn?: string } = {}) {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      const trimmed = sql.trim();
      if (trimmed.startsWith('BEGIN') || trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK')) {
        calls.push(trimmed);
      } else {
        calls.push(trimmed.match(/INSERT INTO (\w+)/)?.[1] ?? trimmed);
      }
      if (opts.failOn && trimmed.includes(opts.failOn)) {
        throw new Error(`simulated failure: ${opts.failOn}`);
      }
      return { rows: [] };
    },
    release: () => {
      calls.push('RELEASE');
    },
  };
  return { client, calls };
}

function fakePool(client: unknown): Pool {
  return { connect: async () => client } as unknown as Pool;
}

const ledger: HorizonLedger = {
  sequence: 100,
  closed_at: '2026-01-01T00:00:00Z',
  successful_transaction_count: 1,
  failed_transaction_count: 0,
  operation_count: 1,
  base_fee_in_stroops: 100,
  base_reserve_in_stroops: 5000000,
};

const tx: HorizonTransaction = {
  hash: 'tx1',
  ledger: 100,
  created_at: '2026-01-01T00:00:00Z',
  source_account: 'GABC',
  fee_charged: '100',
  operation_count: 1,
  successful: true,
  memo_type: 'none',
};

const op: HorizonOperation = {
  id: 'op1',
  type: 'payment',
  transaction_hash: 'tx1',
  created_at: '2026-01-01T00:00:00Z',
  source_account: 'GABC',
};

test('indexLedger writes ledger, transactions, and operations inside one commit', async () => {
  const { client, calls } = makeFakeClient();
  await indexLedger(fakePool(client), ledger, [tx], [op]);
  // The notification is queued *inside* the transaction: Postgres delivers it
  // at commit, so a rolled-back ledger announces nothing.
  assert.deepEqual(calls, [
    'BEGIN',
    'ledgers',
    'transactions',
    'operations',
    'SELECT pg_notify($1, $2)',
    'COMMIT',
    'RELEASE',
  ]);
});

test('indexLedger rolls back and releases the client on failure', async () => {
  const { client, calls } = makeFakeClient({ failOn: 'INSERT INTO operations' });
  await assert.rejects(() => indexLedger(fakePool(client), ledger, [tx], [op]));
  assert.deepEqual(calls, ['BEGIN', 'ledgers', 'transactions', 'operations', 'ROLLBACK', 'RELEASE']);
});

test('getLatestIndexedLedger returns 0 when the table is empty', async () => {
  const pool = { query: async () => ({ rows: [{ max: null }] }) } as unknown as Pool;
  assert.equal(await getLatestIndexedLedger(pool), 0);
});

test('getLatestIndexedLedger returns the numeric max sequence', async () => {
  const pool = { query: async () => ({ rows: [{ max: '4242' }] }) } as unknown as Pool;
  assert.equal(await getLatestIndexedLedger(pool), 4242);
});

const account: HorizonAccount = {
  account_id: 'GABC',
  sequence: '1',
  subentry_count: 0,
  last_modified_ledger: 100,
  num_sponsored: 0,
  num_sponsoring: 0,
  balances: [],
  flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
  thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
};

test('indexLedger writes accounts inside the same commit when provided', async () => {
  const { client, calls } = makeFakeClient();
  await indexLedger(fakePool(client), ledger, [tx], [op], [account]);
  assert.deepEqual(calls, [
    'BEGIN',
    'ledgers',
    'transactions',
    'operations',
    'accounts',
    'SELECT pg_notify($1, $2)',
    'COMMIT',
    'RELEASE',
  ]);
});

test('ensurePartitions calls the partition-maintenance function with the requested lookahead', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as Pool;

  await ensurePartitions(pool, 7);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.match(call.sql, /SELECT ensure_operations_partitions\(\$1\)/);
  assert.deepEqual(call.params, [7]);
});

test('ensurePartitions defaults the lookahead to 5 partitions', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as Pool;

  await ensurePartitions(pool);

  const call = calls[0];
  assert.ok(call);
  assert.deepEqual(call.params, [5]);
});

test('upsertAccount inserts with an ON CONFLICT upsert', async () => {
  const queries: string[] = [];
  const client = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as unknown as PoolClient;
  await upsertAccount(client, account);
  assert.match(queries[0], /INSERT INTO accounts/);
  assert.match(queries[0], /ON CONFLICT \(address\) DO UPDATE/);
});

const event: ContractEvent = {
  id: 'evt1',
  type: 'contract',
  contractId: 'CABC',
  ledger: 100,
  createdAt: '2026-01-01T00:00:00Z',
  pagingToken: 'token1',
  topics: ['"swap"'],
  value: { amount: '10' },
};

test('insertContractEvents writes one row per event', async () => {
  const queries: string[] = [];
  const pool = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as unknown as Pool;
  await insertContractEvents(pool, [event, { ...event, id: 'evt2' }]);
  // Two inserts, then one notification announcing the batch.
  assert.equal(queries.length, 3);
  assert.match(queries[0], /INSERT INTO contract_events/);
  assert.match(queries[1], /INSERT INTO contract_events/);
  assert.match(queries[2], /pg_notify/);
});

test('insertContractEvents is a no-op for an empty list', async () => {
  let calls = 0;
  const pool = { query: async () => { calls++; return { rows: [] }; } } as unknown as Pool;
  await insertContractEvents(pool, []);
  assert.equal(calls, 0);
});

test('getLatestIndexedEventLedger returns 0 when contract_events is empty', async () => {
  const pool = { query: async () => ({ rows: [{ max: null }] }) } as unknown as Pool;
  assert.equal(await getLatestIndexedEventLedger(pool), 0);
});

test('getLatestIndexedEventLedger returns the numeric max ledger', async () => {
  const pool = { query: async () => ({ rows: [{ max: '999' }] }) } as unknown as Pool;
  assert.equal(await getLatestIndexedEventLedger(pool), 999);
});
