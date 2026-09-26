import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import {
  createPool,
  ensurePartitions,
  getLatestIndexedEventLedger,
  getLatestIndexedLedger,
  indexLedger,
  insertContractEvents,
  upsertAccount,
} from './db';
import { indexerPoolErrors } from './metrics';
import { makeAccount, makeContractEvent, makeLedger, makeOperation, makeTransaction } from '../../shared/test-factories';

test('createPool logs and counts idle client errors instead of leaving them unhandled', async () => {
  const pool = createPool('postgresql://localhost:5432/lumina');
  const before = (await indexerPoolErrors.get()).values[0]?.value ?? 0;
  pool.emit('error', new Error('simulated idle client error'));
  const after = (await indexerPoolErrors.get()).values[0]?.value ?? 0;
  assert.equal(after, before + 1);
  await pool.end();
});

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

const ledger = makeLedger();
const tx = makeTransaction();
const op = makeOperation();

test('indexLedger writes ledger, transactions, and operations inside one commit', async () => {
  const { client, calls } = makeFakeClient();
  await indexLedger(fakePool(client), 'mainnet', ledger, [tx], [op]);
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

test('indexLedger inserts every transaction before any operation (FK order)', async () => {
  const { client, calls } = makeFakeClient();
  const tx2 = { ...tx, hash: 'tx2' };
  const op2 = { ...op, id: 'op2', transaction_hash: 'tx2' };
  await indexLedger(fakePool(client), 'mainnet', ledger, [tx, tx2], [op, op2]);
  // operations.transaction_hash is an immediate FK to transactions(hash), so
  // every parent row must land before any child row within the transaction.
  const lastTx = calls.lastIndexOf('transactions');
  const firstOp = calls.indexOf('operations');
  assert.ok(lastTx !== -1 && firstOp !== -1);
  assert.ok(lastTx < firstOp, 'a write path that inserts operations first fails on the FK by design');
});

test('indexLedger rolls back and releases the client on failure', async () => {
  const { client, calls } = makeFakeClient({ failOn: 'INSERT INTO operations' });
  await assert.rejects(() => indexLedger(fakePool(client), 'mainnet', ledger, [tx], [op]));
  assert.deepEqual(calls, ['BEGIN', 'ledgers', 'transactions', 'operations', 'ROLLBACK', 'RELEASE']);
});

test('getLatestIndexedLedger returns 0 when the table is empty', async () => {
  const pool = { query: async () => ({ rows: [{ max: null }] }) } as unknown as Pool;
  assert.equal(await getLatestIndexedLedger(pool, 'mainnet'), 0);
});

test('getLatestIndexedLedger returns the numeric max sequence', async () => {
  const pool = { query: async () => ({ rows: [{ max: '4242' }] }) } as unknown as Pool;
  assert.equal(await getLatestIndexedLedger(pool, 'mainnet'), 4242);
});

test('a resume cursor is read for one network, never across all of them', async () => {
  // MAX(sequence) over every network returns the other chain's tip, which
  // makes a freshly declared network look like it had already indexed.
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [{ max: '100' }] };
    },
  } as unknown as Pool;

  await getLatestIndexedLedger(pool, 'testnet');
  await getLatestIndexedEventLedger(pool, 'testnet');

  assert.match(queries[0]!.sql, /WHERE network = \$1/);
  assert.deepEqual(queries[0]!.params, ['testnet']);
  assert.match(queries[1]!.sql, /WHERE network = \$1/);
  assert.deepEqual(queries[1]!.params, ['testnet']);
});

const account = makeAccount();

test('indexLedger writes accounts inside the same commit when provided', async () => {
  const { client, calls } = makeFakeClient();
  await indexLedger(fakePool(client), 'mainnet', ledger, [tx], [op], [account]);
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
  await upsertAccount(client, 'testnet', account);
  assert.match(queries[0]!, /INSERT INTO accounts/);
  // The same address exists on every chain it has funded; without the network
  // in the key, one chain's balances silently overwrite another's.
  assert.match(queries[0]!, /ON CONFLICT \(address, network\) DO UPDATE/);
  assert.match(queries[0]!, /network\)/);
});

const event = makeContractEvent();

test('insertContractEvents writes one row per event', async () => {
  const queries: string[] = [];
  const pool = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as unknown as Pool;
  await insertContractEvents(pool, 'testnet', [event, { ...event, id: 'evt2' }]);
  // Two inserts, then one notification announcing the batch.
  assert.equal(queries.length, 3);
  assert.match(queries[0]!, /INSERT INTO contract_events/);
  assert.match(queries[1]!, /INSERT INTO contract_events/);
  assert.match(queries[2]!, /pg_notify/);
});

test('insertContractEvents is a no-op for an empty list', async () => {
  let calls = 0;
  const pool = { query: async () => { calls++; return { rows: [] }; } } as unknown as Pool;
  await insertContractEvents(pool, 'mainnet', []);
  assert.equal(calls, 0);
});

test('getLatestIndexedEventLedger returns 0 when contract_events is empty', async () => {
  const pool = { query: async () => ({ rows: [{ max: null }] }) } as unknown as Pool;
  assert.equal(await getLatestIndexedEventLedger(pool, 'mainnet'), 0);
});

test('getLatestIndexedEventLedger returns the numeric max ledger', async () => {
  const pool = { query: async () => ({ rows: [{ max: '999' }] }) } as unknown as Pool;
  assert.equal(await getLatestIndexedEventLedger(pool, 'mainnet'), 999);
});

test('every insert conflicts on the composite key, so two chains can share a ledger', async () => {
  // The same ledger sequence, transaction hash and operation id exist on every
  // chain. A single-column conflict key would drop mainnet's rows the moment
  // testnet wrote the same numbers.
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;

  const eventPool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool;

  await indexLedger(fakePool(client), 'mainnet', ledger, [tx], [op], [account]);
  await insertContractEvents(eventPool, 'mainnet', [event]);

  const conflicts = queries.filter(q => q.includes('ON CONFLICT')).map(q => q.match(/ON CONFLICT \(([^)]+)\)/)?.[1]);
  assert.deepEqual(conflicts, [
    'sequence, network',
    'hash, network',
    'id, network',
    'address, network',
    'id, network',
  ]);
});

test('a ledger notification carries the network it was indexed on', async () => {
  const payloads: string[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_notify')) payloads.push(String(params?.[1]));
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;

  await indexLedger(fakePool(client), 'testnet', ledger, [tx], [op]);

  assert.equal(payloads.length, 1);
  assert.equal(JSON.parse(payloads[0]!).network, 'testnet');
});
