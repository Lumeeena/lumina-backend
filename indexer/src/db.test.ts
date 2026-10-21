import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import {
  createPool,
  ensurePartitions,
  getAccountsNeedingRefresh,
  getLatestIndexedEventLedger,
  getLatestIndexedLedger,
  getNextLedgerForAudit,
  getLedgerRowCounts,
  getTrackedContractStorageKeys,
  indexLedger,
  insertContractEvents,
  isCheckViolation,
  markContractStorageEntriesArchived,
  insertAccountStateHistory,
  upsertAccount,
  upsertContractStorageEntries,
  processLiquidityPoolOperation,
  getLiquidityPool,
  getAccountPoolShares,
  processClaimableBalanceOperation,
  getClaimableBalance,
  getClaimableBalancesForAccount,
  processPathPaymentOperation,
  getPathPayment,
  findPathPaymentsByAsset,
  processSetOptionsOperation,
  getSignerChangesForAccount,
  getThresholdChangesForAccount,
  samplePoolSaturation,
} from './db';
import type { ContractStorageEntry } from './soroban';
import { indexerPoolErrors, registry } from './metrics';
import { makeAccount, makeContractEvent, makeLedger, makeOperation, makeTransaction } from '../../shared/test-factories';

type SqlInput = string | { text: string; values?: unknown[] };

/** The pg driver accepts either a SQL string or a prepared-statement config. */
function sqlText(sql: SqlInput): string {
  return typeof sql === 'string' ? sql : sql.text;
}

function sqlParams(sql: SqlInput, params?: unknown[]): unknown[] {
  return typeof sql === 'string' ? (params ?? []) : (sql.values ?? []);
}

test('createPool logs and counts idle client errors instead of leaving them unhandled', async () => {
  const pool = createPool('postgresql://localhost:5432/lumina');
  const before = (await indexerPoolErrors.get()).values.find(v => v.labels['pool'] === 'write')?.value ?? 0;
  pool.emit('error', new Error('simulated idle client error'));
  const after = (await indexerPoolErrors.get()).values.find(v => v.labels['pool'] === 'write')?.value ?? 0;
  assert.equal(after, before + 1);
  await pool.end();
});

test('pool errors are labelled by pool, so read-pool failures are distinguishable', async () => {
  const pool = createPool('postgresql://localhost:5432/lumina', undefined, 'read');
  const before = (await indexerPoolErrors.get()).values.find(v => v.labels['pool'] === 'read')?.value ?? 0;
  pool.emit('error', new Error('simulated idle client error'));
  const after = (await indexerPoolErrors.get()).values.find(v => v.labels['pool'] === 'read')?.value ?? 0;
  assert.equal(after, before + 1);
  await pool.end();
});

test('samplePoolSaturation publishes per-pool totals, idles and waiters', async () => {
  const poolOf = (total: number, idle: number, waiting: number) =>
    ({ totalCount: total, idleCount: idle, waitingCount: waiting }) as unknown as Pool;

  samplePoolSaturation({ write: poolOf(5, 2, 0), read: poolOf(3, 0, 2) });

  const valueFor = async (name: string, pool: string): Promise<number> => {
    const metric = await registry.getSingleMetric(name)?.get();
    return metric?.values.find(v => v.labels['pool'] === pool)?.value ?? 0;
  };

  assert.equal(await valueFor('lumina_indexer_db_pool_connections_total', 'write'), 5);
  assert.equal(await valueFor('lumina_indexer_db_pool_connections_total', 'read'), 3);
  assert.equal(await valueFor('lumina_indexer_db_pool_connections_idle', 'write'), 2);
  assert.equal(await valueFor('lumina_indexer_db_pool_waiting', 'read'), 2);
});

test('a pooled connection dying while checked out does not raise an unhandled error', async () => {
  // pg-pool drops its own listener while a client is checked out, so without
  // one of ours a backend killed mid-transaction crashed the indexer.
  const pool = createPool('postgresql://localhost:5432/lumina');
  const client = new EventEmitter();
  pool.emit('connect', client);
  assert.doesNotThrow(() => client.emit('error', new Error('Connection terminated unexpectedly')));
  await pool.end();
});

function makeFakeClient(opts: { failOn?: string } = {}) {
  const calls: string[] = [];
  const client = {
    query: async (sql: SqlInput) => {
      const trimmed = sqlText(sql).trim();
      if (trimmed.startsWith('BEGIN') || trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK')) {
        calls.push(trimmed);
      } else {
        calls.push(trimmed.match(/(?:INSERT INTO|DELETE FROM) (\w+)/)?.[1] ?? trimmed);
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
    'SAVEPOINT operation_processing',
    'RELEASE SAVEPOINT operation_processing',
    'failed_ledgers',
    'indexer_cursors',
    'SELECT pg_notify($1, $2)',
    'COMMIT',
    'RELEASE',
  ]);
});

test('indexLedger clears the ledger from failed_ledgers and ledger_retry_queue in one statement', async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params: params ?? [] });
      return { rows: [] };
    },
    release: () => {},
  };
  await indexLedger(fakePool(client), 'testnet', ledger, [tx], [op]);
  // The forward loop, backfill and gap repair all retry a failed ledger
  // themselves, so the ledger usually lands here rather than through the retry
  // worker. A queue row left behind would be re-indexed for nothing, or, once
  // permanently_failed, never deleted at all.
  const clears = statements.filter(s => /DELETE FROM (failed_ledgers|ledger_retry_queue)/.test(s.sql));
  assert.equal(clears.length, 1, 'both deletes should share one round trip');
  assert.match(clears[0]!.sql, /DELETE FROM failed_ledgers WHERE sequence = \$1 AND network = \$2/);
  assert.match(clears[0]!.sql, /DELETE FROM ledger_retry_queue WHERE ledger = \$1 AND network = \$2/);
  assert.deepEqual(clears[0]!.params, [ledger.sequence, 'testnet']);
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

// A Postgres CHECK-constraint violation: SQLSTATE 23514, with the constraint
// name attached the way pg attaches it.
function checkViolation(constraint: string): Error & { code: string; constraint: string } {
  const err = new Error(`new row for relation "ledgers" violates check constraint "${constraint}"`) as Error & {
    code: string;
    constraint: string;
  };
  err.code = '23514';
  err.constraint = constraint;
  return err;
}

test('isCheckViolation recognises a Postgres check violation by SQLSTATE', () => {
  assert.equal(isCheckViolation(checkViolation('ledgers_sequence_check')), true);
  assert.equal(isCheckViolation(Object.assign(new Error('boom'), { code: '23503' })), false); // FK violation
  assert.equal(isCheckViolation(Object.assign(new Error('boom'), { code: '23505' })), false); // unique violation
  assert.equal(isCheckViolation(new Error('no code')), false);
  assert.equal(isCheckViolation(null), false);
  assert.equal(isCheckViolation(undefined), false);
  assert.equal(isCheckViolation('23514'), false); // the code alone is not the error
});

test('indexLedger surfaces a check violation as a failed write', async () => {
  // A check constraint on the ledger insert rejects the row: the write fails,
  // rolls back, and the violation propagates so the retry loop in index.ts can
  // classify it (a check violation is not transient, so retrying is pointless).
  const client = {
    query: async (sql: SqlInput) => {
      if (sqlText(sql).includes('INSERT INTO ledgers')) throw checkViolation('ledgers_transaction_count_check');
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;

  await assert.rejects(
    () => indexLedger(fakePool(client), 'mainnet', ledger, [tx], [op]),
    (err: unknown) => err instanceof Error && isCheckViolation(err)
  );
});

test('insertContractEvents surfaces a check violation as a failed write', async () => {
  const pool = {
    query: async (sql: SqlInput) => {
      if (sqlText(sql).includes('INSERT INTO contract_events')) throw checkViolation('contract_events_id_check');
      return { rows: [] };
    },
  } as unknown as Pool;

  await assert.rejects(
    () => insertContractEvents(pool, 'mainnet', [event]),
    (err: unknown) => err instanceof Error && isCheckViolation(err)
  );
});

test('getLatestIndexedLedger returns 0 when the table is empty', async () => {
  const pool = { query: async () => ({ rows: [{ max: null }] }) } as unknown as Pool;
  assert.equal(await getLatestIndexedLedger(pool, 'mainnet'), 0);
});

test('getLatestIndexedLedger returns the numeric max sequence', async () => {
  const pool = { query: async () => ({ rows: [{ max: '4242' }] }) } as unknown as Pool;
  assert.equal(await getLatestIndexedLedger(pool, 'mainnet'), 4242);
});

test('getNextLedgerForAudit advances by indexed sequence and wraps to the first ledger', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: queries.length === 1 ? [] : [{ sequence: '100' }] };
    },
  } as unknown as Pool;

  assert.equal(await getNextLedgerForAudit(pool, 'testnet', 900), 100);
  assert.equal(queries.length, 2);
  assert.match(queries[0]!.sql, /ORDER BY sequence DESC LIMIT \$2/);
  assert.match(queries[0]!.sql, /sequence > \$3 ORDER BY sequence ASC LIMIT 1/);
  assert.deepEqual(queries[0]!.params, ['testnet', 100, 900]);
  assert.match(queries[1]!.sql, /ORDER BY sequence DESC LIMIT \$2/);
  assert.deepEqual(queries[1]!.params, ['testnet', 100]);
});

test('getLedgerRowCounts counts rows for one network and ledger', async () => {
  let queryText = '';
  let queryParams: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      queryText = sql;
      queryParams = params;
      return { rows: [{ transactions: '2', operations: '7' }] };
    },
  } as unknown as Pool;

  assert.deepEqual(await getLedgerRowCounts(pool, 'testnet', 4242), { transactions: 2, operations: 7 });
  assert.match(queryText, /FROM transactions WHERE network = \$1 AND ledger = \$2/);
  assert.match(queryText, /FROM operations WHERE network = \$1 AND ledger = \$2/);
  assert.deepEqual(queryParams, ['testnet', 4242]);
});

test('getAccountsNeedingRefresh skips snapshots that already include the ledger', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [
        { address: 'current', last_modified_ledger: '200' },
        { address: 'stale', last_modified_ledger: '199' },
      ] };
    },
  } as unknown as Pool;

  const candidates = await getAccountsNeedingRefresh(
    pool,
    'testnet',
    ['current', 'stale', 'missing'],
    200
  );

  assert.deepEqual(candidates, ['stale', 'missing']);
  assert.match(queries[0]!.sql, /network = \$1 AND address = ANY\(\$2\)/);
  assert.deepEqual(queries[0]!.params, ['testnet', ['current', 'stale', 'missing']]);
});

test('getAccountsNeedingRefresh avoids a database round trip for no addresses', async () => {
  const pool = { query: async () => { throw new Error('unexpected query'); } } as unknown as Pool;
  assert.deepEqual(await getAccountsNeedingRefresh(pool, 'mainnet', [], 200), []);
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

test('indexLedger queues account refreshes in the ledger transaction', async () => {
  const { client, calls } = makeFakeClient();
  await indexLedger(fakePool(client), 'mainnet', ledger, [tx], [op], [account.account_id]);
  assert.deepEqual(calls, [
    'BEGIN',
    'ledgers',
    'transactions',
    'operations',
    'SAVEPOINT operation_processing',
    'RELEASE SAVEPOINT operation_processing',
    'account_refresh_queue',
    'failed_ledgers',
    'indexer_cursors',
    'SELECT pg_notify($1, $2)',
    'COMMIT',
    'RELEASE',
  ]);
});

test('a failed refresh enqueue rolls the ledger transaction back for restart recovery', async () => {
  const { client, calls } = makeFakeClient({ failOn: 'INSERT INTO account_refresh_queue' });
  await assert.rejects(() => indexLedger(
    fakePool(client),
    'mainnet',
    ledger,
    [tx],
    [op],
    [account.account_id]
  ));
  assert.deepEqual(calls, [
    'BEGIN',
    'ledgers',
    'transactions',
    'operations',
    'SAVEPOINT operation_processing',
    'RELEASE SAVEPOINT operation_processing',
    'account_refresh_queue',
    'ROLLBACK',
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
  const client = { query: async (sql: SqlInput) => { queries.push(sqlText(sql)); return { rows: [] }; } } as unknown as PoolClient;
  await upsertAccount(client, 'testnet', account);
  assert.match(queries[0]!, /INSERT INTO accounts/);
  // The same address exists on every chain it has funded; without the network
  // in the key, one chain's balances silently overwrite another's.
  assert.match(queries[0]!, /ON CONFLICT \(address, network\) DO UPDATE/);
  assert.match(queries[0]!, /network\)/);
});

test('insertAccountStateHistory stores the state under its own ledger, and only once', async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: async (q: { text: string; values: unknown[] }) => {
      calls.push(q);
      return { rows: [] };
    },
  } as unknown as PoolClient;

  await insertAccountStateHistory(client, 'testnet', account);

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /INSERT INTO account_state_history/);
  // Keyed by the state's own last-modified ledger: seeing the same state on a
  // second refresh must not add a row.
  assert.match(calls[0]!.text, /ON CONFLICT \(address, network, last_modified_ledger\) DO NOTHING/);
  assert.equal(calls[0]!.values[0], account.account_id);
  assert.equal(calls[0]!.values[1], 'testnet');
  assert.equal(calls[0]!.values[2], account.last_modified_ledger);
});

const event = makeContractEvent();

test('insertContractEvents writes one row per event', async () => {
  const queries: string[] = [];
  const pool = { query: async (sql: SqlInput) => { queries.push(sqlText(sql)); return { rows: [] }; } } as unknown as Pool;
  await insertContractEvents(pool, 'testnet', [event, { ...event, id: 'evt2' }]);
  // Two inserts, then one notification announcing the batch.
  assert.equal(queries.length, 3);
  assert.match(queries[0]!, /INSERT INTO contract_events/);
  assert.match(queries[1]!, /INSERT INTO contract_events/);
  assert.match(queries[2]!, /pg_notify/);
});

test('insertContractEvents stores an i128 amount as decimal text rather than failing the batch', async () => {
  // scValToNative decodes an i128 as a bigint. JSON.stringify throws on one, so
  // a single token transfer used to fail every poll and pin the event cursor.
  const values: unknown[][] = [];
  const pool = {
    query: async (sql: SqlInput) => {
      if (typeof sql === 'object' && 'values' in sql && sql.values) values.push(sql.values);
      return { rows: [] };
    },
  } as unknown as Pool;
  await insertContractEvents(pool, 'mainnet', [{ ...event, value: { amount: 170141183460469231731687303715884105727n } }]);
  assert.equal(values[0]![7], '{"amount":"170141183460469231731687303715884105727"}');
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
    query: async (sql: SqlInput) => {
      queries.push(sqlText(sql));
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;

  const eventPool = {
    query: async (sql: SqlInput) => {
      queries.push(sqlText(sql));
      return { rows: [] };
    },
  } as unknown as Pool;

  await indexLedger(fakePool(client), 'mainnet', ledger, [tx], [op], [account.account_id]);
  await insertContractEvents(eventPool, 'mainnet', [event]);

  const conflicts = queries.filter(q => q.includes('ON CONFLICT')).map(q => q.match(/ON CONFLICT \(([^)]+)\)/)?.[1]);
  assert.deepEqual(conflicts, [
    'sequence, network',
    'hash, network',
    // operations, on purpose: see the comment in db.ts. The third insert has
    // no inference clause at all, so its entry is undefined rather than a key.
    undefined,
    'network, address',
    'network, purpose',
    'id, network',
  ]);

  // Belt and braces on the one insert that is not explicit: it must not name a
  // conflict target, because the only two shapes that target could name are
  // (id, network) on the plain table and (id, ledger, network) on a deployment
  // that still has the reverted partitioning.
  const operationsInsert = queries.find(q => q.includes('INSERT INTO operations'));
  assert.ok(operationsInsert);
  assert.match(operationsInsert, /ON CONFLICT DO NOTHING\s*`?$/);
  assert.doesNotMatch(operationsInsert, /ON CONFLICT \(/);
});

test('a ledger notification carries the network it was indexed on', async () => {
  const payloads: string[] = [];
  const client = {
    query: async (sql: SqlInput, params?: unknown[]) => {
      if (sqlText(sql).includes('pg_notify')) payloads.push(String(sqlParams(sql, params)[1]));
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;

  await indexLedger(fakePool(client), 'testnet', ledger, [tx], [op]);

  assert.equal(payloads.length, 1);
  assert.equal(JSON.parse(payloads[0]!).network, 'testnet');
});

// ─── Contract storage entries ──────────────────────────────────────────────

const STORAGE_KEY = 'AAAAZAAAAGQAAAA==';

function storageEntry(overrides: Partial<ContractStorageEntry> = {}): ContractStorageEntry {
  return {
    contractId: 'CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ',
    key: STORAGE_KEY,
    durability: 'persistent',
    value: { count: '42' },
    valueXdr: 'AAAAEQAAAAE',
    liveUntilLedgerSeq: 900,
    lastModifiedLedgerSeq: 500,
    ...overrides,
  };
}

test('upsertContractStorageEntries writes a row per entry as active', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return { rows: [] }; },
  } as unknown as Pool;

  await upsertContractStorageEntries(pool, 'mainnet', [storageEntry(), storageEntry({ key: 'other' })]);

  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.match(query.sql, /INSERT INTO contract_storage_entries/);
    assert.match(query.sql, /'active'/);
  }
  assert.equal(queries[0]?.params[0], storageEntry().contractId);
  assert.equal(queries[0]?.params[1], STORAGE_KEY);
  assert.equal(queries[0]?.params[2], 'persistent');
  assert.equal(queries[0]?.params[6], 500);
  assert.equal(queries[0]?.params[7], 'mainnet');
});

test('upsertContractStorageEntries is a no-op for an empty list', async () => {
  let calls = 0;
  const pool = { query: async () => { calls++; return { rows: [] }; } } as unknown as Pool;
  await upsertContractStorageEntries(pool, 'mainnet', []);
  assert.equal(calls, 0);
});

test('a bigint storage value is stored as canonical decimal text, not a float', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return { rows: [] }; },
  } as unknown as Pool;

  // An i128 token amount does not fit a JSON number; JSON.stringify would throw
  // on a bare bigint, and a float would silently round it.
  await upsertContractStorageEntries(pool, 'mainnet', [
    storageEntry({ value: { amount: 1208925819614629174706176n } }),
  ]);

  assert.equal(queries[0]?.params[3], '{"amount":"1208925819614629174706176"}');
});

test('a null storage value is stored as SQL NULL', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (querySql: string, params: unknown[] = []) => { queries.push({ sql: querySql, params }); return { rows: [] }; },
  } as unknown as Pool;

  await upsertContractStorageEntries(pool, 'mainnet', [storageEntry({ value: null })]);
  assert.equal(queries[0]?.params[3], null);
});

test('re-fetching a live entry updates it and can flip an archived entry back to active', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => { queries.push(sql); return { rows: [] }; },
  } as unknown as Pool;

  await upsertContractStorageEntries(pool, 'mainnet', [storageEntry()]);

  // DO UPDATE, not DO NOTHING: the value must track the chain, and a restored
  // (un-archived) entry has to become active again.
  assert.match(queries[0]!, /ON CONFLICT \(contract_id, key, network\) DO UPDATE SET/);
  assert.match(queries[0]!, /state = 'active'/);
  assert.match(queries[0]!, /value = EXCLUDED.value/);
});

test('markContractStorageEntriesArchived marks rows rather than deleting them', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return { rows: [] }; },
  } as unknown as Pool;

  await markContractStorageEntriesArchived(pool, 'mainnet', [STORAGE_KEY, 'other']);

  const [query] = queries;
  assert.ok(query);
  // An UPDATE, never a DELETE: deleting would report a contract as having lost
  // state it still has.
  assert.match(query.sql, /UPDATE contract_storage_entries/);
  assert.doesNotMatch(query.sql, /DELETE/);
  assert.match(query.sql, /state = 'archived'/);
  assert.deepEqual(query.params, ['mainnet', [STORAGE_KEY, 'other']]);
});

test('markContractStorageEntriesArchived only touches rows that are currently active', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => { queries.push(sql); return { rows: [] }; },
  } as unknown as Pool;

  await markContractStorageEntriesArchived(pool, 'mainnet', [STORAGE_KEY]);

  // The state guard makes re-archiving an already-archived entry a no-op rather
  // than a repeated write, and keeps an archived row's history intact.
  assert.match(queries[0]!, /AND state = 'active'/);
});

test('markContractStorageEntriesArchived is a no-op for an empty key list', async () => {
  let calls = 0;
  const pool = { query: async () => { calls++; return { rows: [] }; } } as unknown as Pool;
  await markContractStorageEntriesArchived(pool, 'mainnet', []);
  assert.equal(calls, 0);
});

test('getTrackedContractStorageKeys reads every key for one network, active or archived', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [{ key: STORAGE_KEY }, { key: 'other' }] };
    },
  } as unknown as Pool;

  const keys = await getTrackedContractStorageKeys(pool, 'testnet');

  assert.deepEqual(keys, [STORAGE_KEY, 'other']);
  // Tracked across both states, and scoped to one network.
  assert.match(queries[0]!.sql, /FROM contract_storage_entries WHERE network = \$1/);
  assert.doesNotMatch(queries[0]!.sql, /state/);
  assert.deepEqual(queries[0]?.params, ['testnet']);
});

test('processLiquidityPoolOperation handles deposits and updates pool reserves and account shares', async () => {
  const executed: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql: sql.trim(), params });
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const depositOp = {
    ...op,
    id: 'op_lp_1',
    type: 'liquidity_pool_deposit',
    liquidity_pool_id: 'pool_abc123',
    source_account: 'GA_DEPOSITOR',
    reserves_deposited: [
      { asset: 'native', amount: '100.0000000' },
      { asset: { code: 'USDC', issuer: 'GISSUER' }, amount: '50.0000000' },
    ],
    shares_received: '70.7106781',
  };

  await processLiquidityPoolOperation(client, 'mainnet', 500, depositOp);

  assert.equal(executed.length, 2);
  // Upsert pool
  assert.match(executed[0]!.sql, /INSERT INTO liquidity_pools/);
  assert.deepEqual(executed[0]!.params, [
    'pool_abc123',
    'native',
    'USDC:GISSUER',
    '100.0000000',
    '50.0000000',
    '70.7106781',
    500,
    'mainnet',
  ]);
  // Upsert account shares
  assert.match(executed[1]!.sql, /INSERT INTO liquidity_pool_shares/);
  assert.deepEqual(executed[1]!.params, [
    'pool_abc123',
    'GA_DEPOSITOR',
    '70.7106781',
    500,
    'mainnet',
  ]);
});

test('processLiquidityPoolOperation handles withdraws and decrements reserves and shares', async () => {
  const executed: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql: sql.trim(), params });
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const withdrawOp = {
    ...op,
    id: 'op_lp_2',
    type: 'liquidity_pool_withdraw',
    liquidity_pool_id: 'pool_abc123',
    source_account: 'GA_DEPOSITOR',
    reserves_received: [
      { asset: 'native', amount: '20.0000000' },
      { asset: { code: 'USDC', issuer: 'GISSUER' }, amount: '10.0000000' },
    ],
    shares: '14.1421356',
  };

  await processLiquidityPoolOperation(client, 'mainnet', 501, withdrawOp);

  assert.equal(executed.length, 2);
  // Update pool reserves and shares
  assert.match(executed[0]!.sql, /UPDATE liquidity_pools/);
  assert.deepEqual(executed[0]!.params, [
    '20.0000000',
    '10.0000000',
    '14.1421356',
    501,
    'pool_abc123',
    'mainnet',
  ]);
  // Update account shares
  assert.match(executed[1]!.sql, /UPDATE liquidity_pool_shares/);
  assert.deepEqual(executed[1]!.params, [
    '14.1421356',
    501,
    'pool_abc123',
    'GA_DEPOSITOR',
    'mainnet',
  ]);
});

test('getLiquidityPool and getAccountPoolShares query pool reserves and user shares', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM liquidity_pools')) {
        return {
          rows: [{
            pool_id: 'pool_abc123',
            asset_a: 'native',
            asset_b: 'USDC:GISSUER',
            fee_bp: 30,
            reserve_a: '80.0000000',
            reserve_b: '40.0000000',
            total_shares: '56.5685425',
            last_ledger: '501',
          }],
        };
      }
      if (sql.includes('FROM liquidity_pool_shares')) {
        return {
          rows: [{
            pool_id: 'pool_abc123',
            account: 'GA_DEPOSITOR',
            shares: '56.5685425',
            last_ledger: '501',
          }],
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;

  const lp = await getLiquidityPool(pool, 'mainnet', 'pool_abc123');
  assert.ok(lp);
  assert.equal(lp.reserve_a, '80.0000000');
  assert.equal(lp.fee_bp, 30);
  assert.equal(lp.last_ledger, 501);

  const shares = await getAccountPoolShares(pool, 'mainnet', 'GA_DEPOSITOR');
  assert.equal(shares.length, 1);
  assert.equal(shares[0]?.shares, '56.5685425');
  assert.equal(shares[0]?.account, 'GA_DEPOSITOR');
});

test('processClaimableBalanceOperation records creation with predicates in queryable form', async () => {
  const executed: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql: sql.trim(), params });
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const createClaimOp = {
    ...op,
    id: 'op_cb_1',
    type: 'create_claimable_balance',
    balance_id: '00000000balance_123',
    asset: 'USDC:GISSUER',
    amount: '250.0000000',
    sponsor: 'G_SPONSOR',
    created_at: '2026-02-01T12:00:00Z',
    claimants: [
      {
        destination: 'G_BENEFICIARY_1',
        predicate: { unconditional: true },
      },
      {
        destination: 'G_BENEFICIARY_2',
        predicate: { abs_before: '2026-12-31T23:59:59Z' },
      },
    ],
  };

  await processClaimableBalanceOperation(client, 'mainnet', 600, createClaimOp);

  assert.equal(executed.length, 3);
  // Main claimable balance table
  assert.match(executed[0]!.sql, /INSERT INTO claimable_balances/);
  assert.deepEqual(executed[0]!.params, [
    '00000000balance_123',
    'USDC:GISSUER',
    '250.0000000',
    'G_SPONSOR',
    JSON.stringify(createClaimOp.claimants),
    600,
    '2026-02-01T12:00:00Z',
    'mainnet',
  ]);

  // Claimant 1 (unconditional)
  assert.match(executed[1]!.sql, /INSERT INTO claimable_balance_claimants/);
  assert.equal(executed[1]!.params[1], 'G_BENEFICIARY_1');
  assert.equal(executed[1]!.params[2], 'unconditional');

  // Claimant 2 (abs_before)
  assert.match(executed[2]!.sql, /INSERT INTO claimable_balance_claimants/);
  assert.equal(executed[2]!.params[1], 'G_BENEFICIARY_2');
  assert.equal(executed[2]!.params[2], 'abs_before');
  assert.equal(executed[2]!.params[4], '2026-12-31T23:59:59Z');
});

test('processClaimableBalanceOperation marks claimable balance as claimed rather than deleting', async () => {
  const executed: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql: sql.trim(), params });
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const claimOp = {
    ...op,
    id: 'op_cb_2',
    type: 'claim_claimable_balance',
    balance_id: '00000000balance_123',
    source_account: 'G_BENEFICIARY_1',
    created_at: '2026-02-02T10:00:00Z',
  };

  await processClaimableBalanceOperation(client, 'mainnet', 605, claimOp);

  assert.equal(executed.length, 1);
  assert.match(executed[0]!.sql, /UPDATE claimable_balances/);
  assert.match(executed[0]!.sql, /SET status = 'claimed'/);
  assert.deepEqual(executed[0]!.params, [
    'G_BENEFICIARY_1',
    '2026-02-02T10:00:00Z',
    605,
    '00000000balance_123',
    'mainnet',
  ]);
});

test('processClaimableBalanceOperation keys a created balance by the id its claim will carry', async () => {
  // Horizon's create_claimable_balance record has no balance_id (see
  // test/contract/fixtures/operations.json); the id comes from the
  // transaction. This is mainnet operation 279341181123747842.
  const executed: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql: sql.trim(), params });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const balanceId = '00000000dd35e5f1aa87257450979d481daa163a12a7c24ac82e7f829af6a47b7f261943';
  const transaction = {
    hash: '03660b0b49d4a6c31dec4a382758dd87af66d56743bba092e7be83e2551a4765',
    ledger: 65039178,
    created_at: '2026-02-01T12:00:00Z',
    source_account: 'GB4NLVHUFFJYUG5PMJRPSOOXGM6GRKNKWJ2BMJQATAZOEG2GZD2PVN27',
    source_account_sequence: '266166330288257195',
    fee_charged: '100',
    operation_count: 52,
    successful: true,
    memo_type: 'none',
  };

  await processClaimableBalanceOperation(client, 'mainnet', 65039178, {
    ...op,
    id: '279341181123747842',
    type: 'create_claimable_balance',
    transaction_hash: transaction.hash,
    source_account: transaction.source_account,
    asset: 'native',
    amount: '1.0000000',
    claimants: [{ destination: 'G_BENEFICIARY_1', predicate: { unconditional: true } }],
  }, transaction);
  assert.equal(executed[0]!.params[0], balanceId);
  assert.equal(executed[1]!.params[0], balanceId);

  // The claim, as Horizon reports it, now targets the same row.
  await processClaimableBalanceOperation(client, 'mainnet', 65039200, {
    ...op,
    id: '279341300000000001',
    type: 'claim_claimable_balance',
    balance_id: balanceId,
    claimant: 'G_BENEFICIARY_1',
  });
  assert.match(executed[2]!.sql, /UPDATE claimable_balances/);
  assert.equal(executed[2]!.params[3], balanceId);
});

test('processClaimableBalanceOperation marks a clawed-back balance so it stops reading as claimable', async () => {
  const executed: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql: sql.trim(), params });
      return { rows: [] };
    },
  } as unknown as PoolClient;

  await processClaimableBalanceOperation(client, 'mainnet', 610, {
    ...op,
    id: 'op_cb_3',
    type: 'clawback_claimable_balance',
    balance_id: '00000000balance_123',
    source_account: 'G_ISSUER',
    created_at: '2026-02-03T10:00:00Z',
  });

  assert.equal(executed.length, 1);
  assert.match(executed[0]!.sql, /SET status = 'clawed_back'/);
  assert.deepEqual(executed[0]!.params, ['2026-02-03T10:00:00Z', 610, '00000000balance_123', 'mainnet']);
});

test('getClaimableBalancesForAccount queries claimable balances by claimant destination', async () => {
  const pool = {
    query: async () => ({
      rows: [{
        balance_id: '00000000balance_123',
        destination: 'G_BENEFICIARY_1',
        predicate_type: 'unconditional',
        asset: 'USDC:GISSUER',
        amount: '250.0000000',
        sponsor: 'G_SPONSOR',
        status: 'unclaimed',
        created_at: '2026-02-01T12:00:00Z',
      }],
    }),
  } as unknown as Pool;

  const balances = await getClaimableBalancesForAccount(pool, 'mainnet', 'G_BENEFICIARY_1');
  assert.equal(balances.length, 1);
  assert.equal(balances[0]?.balance_id, '00000000balance_123');
  assert.equal(balances[0]?.status, 'unclaimed');
});

test('processPathPaymentOperation records distinct source/destination amounts and routing path', async () => {
  const executed: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql: sql.trim(), params });
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const pathPaymentOp = {
    ...op,
    id: 'op_pp_1',
    transaction_hash: 'tx_path_99',
    type: 'path_payment_strict_send',
    from: 'G_SENDER',
    to: 'G_RECEIVER',
    source_asset_type: 'native',
    source_amount: '100.0000000',
    dest_asset_type: 'credit_alphanum4',
    dest_asset_code: 'EURC',
    dest_asset_issuer: 'G_EURC_ISSUER',
    dest_amount: '85.5000000',
    path: [
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'G_USDC_ISSUER' },
      { asset_type: 'credit_alphanum4', asset_code: 'XLM_BRIDGE', asset_issuer: 'G_BRIDGE_ISSUER' },
    ],
    created_at: '2026-03-01T08:00:00Z',
  };

  await processPathPaymentOperation(client, 'mainnet', 700, pathPaymentOp);

  // 1 path_payments row + 2 path_payment_hops rows
  assert.equal(executed.length, 3);
  assert.match(executed[0]!.sql, /INSERT INTO path_payments/);
  assert.deepEqual(executed[0]!.params, [
    'op_pp_1',
    'tx_path_99',
    700,
    'mainnet',
    'strict_send',
    'G_SENDER',
    'G_RECEIVER',
    'native',
    '100.0000000',
    'EURC:G_EURC_ISSUER',
    '85.5000000',
    ['USDC:G_USDC_ISSUER', 'XLM_BRIDGE:G_BRIDGE_ISSUER'],
    2,
    '2026-03-01T08:00:00Z',
  ]);

  assert.match(executed[1]!.sql, /INSERT INTO path_payment_hops/);
  assert.deepEqual(executed[1]!.params, ['op_pp_1', 0, 'USDC:G_USDC_ISSUER', 'mainnet']);
  assert.deepEqual(executed[2]!.params, ['op_pp_1', 1, 'XLM_BRIDGE:G_BRIDGE_ISSUER', 'mainnet']);
});

test('findPathPaymentsByAsset finds payments that routed through an intermediate asset', async () => {
  const pool = {
    query: async (_sql: string, params: unknown[] = []) => {
      assert.equal(params[1], 'USDC:G_USDC_ISSUER');
      return {
        rows: [{
          operation_id: 'op_pp_1',
          transaction_hash: 'tx_path_99',
          payment_type: 'strict_send',
          source_asset: 'native',
          dest_asset: 'EURC:G_EURC_ISSUER',
          path_assets: ['USDC:G_USDC_ISSUER', 'XLM_BRIDGE:G_BRIDGE_ISSUER'],
          created_at: '2026-03-01T08:00:00Z',
        }],
      };
    },
  } as unknown as Pool;

  const payments = await findPathPaymentsByAsset(pool, 'mainnet', 'USDC:G_USDC_ISSUER');
  assert.equal(payments.length, 1);
  assert.equal(payments[0]?.operation_id, 'op_pp_1');
  assert.deepEqual(payments[0]?.path_assets, ['USDC:G_USDC_ISSUER', 'XLM_BRIDGE:G_BRIDGE_ISSUER']);
});

test('processSetOptionsOperation records signer additions, removals, and threshold changes', async () => {
  const executed: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql: sql.trim(), params });
      return { rows: [] };
    },
  } as unknown as PoolClient;

  // 1. Signer addition with thresholds
  const setOptionsAdd = {
    ...op,
    id: 'op_opt_1',
    transaction_hash: 'tx_opt_1',
    type: 'set_options',
    source_account: 'G_SIGNER_ACCOUNT',
    signer_key: 'G_NEW_SIGNER_KEY',
    signer_weight: 10,
    master_key_weight: 20,
    low_threshold: 10,
    med_threshold: 20,
    high_threshold: 30,
    home_domain: 'lumina.network',
    set_flags_s: ['auth_required'],
    created_at: '2026-04-01T15:00:00Z',
  };

  await processSetOptionsOperation(client, 'mainnet', 800, setOptionsAdd);

  assert.equal(executed.length, 2);
  // Signer change
  assert.match(executed[0]!.sql, /INSERT INTO account_signer_changes/);
  assert.deepEqual(executed[0]!.params, [
    'G_SIGNER_ACCOUNT',
    'op_opt_1',
    'tx_opt_1',
    800,
    'mainnet',
    'G_NEW_SIGNER_KEY',
    10,
    'added',
    '2026-04-01T15:00:00Z',
  ]);

  // Threshold change
  assert.match(executed[1]!.sql, /INSERT INTO account_threshold_changes/);
  assert.deepEqual(executed[1]!.params, [
    'G_SIGNER_ACCOUNT',
    'op_opt_1',
    'tx_opt_1',
    800,
    'mainnet',
    20,
    10,
    20,
    30,
    'lumina.network',
    ['auth_required'],
    null,
    '2026-04-01T15:00:00Z',
  ]);

  // 2. Signer removal (weight 0)
  executed.length = 0;
  const setOptionsRemove = {
    ...op,
    id: 'op_opt_2',
    transaction_hash: 'tx_opt_2',
    type: 'set_options',
    source_account: 'G_SIGNER_ACCOUNT',
    signer_key: 'G_OLD_SIGNER_KEY',
    signer_weight: 0,
    created_at: '2026-04-02T11:00:00Z',
  };

  await processSetOptionsOperation(client, 'mainnet', 801, setOptionsRemove);

  assert.equal(executed.length, 1);
  assert.match(executed[0]!.sql, /INSERT INTO account_signer_changes/);
  assert.equal(executed[0]!.params[7], 'removed');
});

test('getSignerChangesForAccount and getThresholdChangesForAccount query account security history', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM account_signer_changes')) {
        return {
          rows: [{
            id: '1',
            account: 'G_SIGNER_ACCOUNT',
            operation_id: 'op_opt_1',
            signer_key: 'G_NEW_SIGNER_KEY',
            weight: 10,
            action: 'added',
            created_at: '2026-04-01T15:00:00Z',
          }],
        };
      }
      if (sql.includes('FROM account_threshold_changes')) {
        return {
          rows: [{
            id: '1',
            account: 'G_SIGNER_ACCOUNT',
            operation_id: 'op_opt_1',
            master_weight: 20,
            low_threshold: 10,
            med_threshold: 20,
            high_threshold: 30,
            home_domain: 'lumina.network',
            created_at: '2026-04-01T15:00:00Z',
          }],
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;

  const signers = await getSignerChangesForAccount(pool, 'mainnet', 'G_SIGNER_ACCOUNT');
  assert.equal(signers.length, 1);
  assert.equal(signers[0]?.signer_key, 'G_NEW_SIGNER_KEY');
  assert.equal(signers[0]?.action, 'added');

  const thresholds = await getThresholdChangesForAccount(pool, 'mainnet', 'G_SIGNER_ACCOUNT');
  assert.equal(thresholds.length, 1);
  assert.equal(thresholds[0]?.low_threshold, 10);
  assert.equal(thresholds[0]?.home_domain, 'lumina.network');
});

