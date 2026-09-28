import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import {
  RETENTION_SPECS,
  deleteExpiredBatch,
  isRetentionEnabled,
  pruneExpiredData,
  retentionCutoff,
  retainedTables,
  unlimitedRetentionWindows,
  type RetentionSpec,
  type RetentionWindows,
} from './retention';

interface QueryRecord {
  sql: string;
  params: unknown[];
}

interface FakeOptions {
  /** rowCount reported by DELETE, in order; exhausted entries report 0. */
  deleteCounts?: number[];
}

function fakeClient(options: FakeOptions = {}) {
  const queries: QueryRecord[] = [];
  const deletes: number[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('DELETE FROM')) {
        const count = options.deleteCounts?.length ? (options.deleteCounts.shift() as number) : 0;
        deletes.push(count);
        return { rows: [], rowCount: count };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { client: client as unknown as PoolClient, queries, deletes };
}

function fakePool(client: PoolClient) {
  return { connect: async () => client } as unknown as Pool;
}

function windows(overrides: Partial<RetentionWindows> = {}): RetentionWindows {
  return { ...unlimitedRetentionWindows(), ...overrides };
}

test('every table defaults to an unlimited window', () => {
  const defaults = unlimitedRetentionWindows();
  assert.deepEqual(Object.keys(defaults).sort(), [
    'contract_events', 'custom_events', 'ledgers', 'operations', 'transactions',
  ]);
  for (const days of Object.values(defaults)) assert.equal(days, 0);
  // "Default to unlimited" is an acceptance criterion, so it is asserted
  // directly rather than inferred from the absence of configuration.
  assert.equal(isRetentionEnabled(defaults), false);
  assert.deepEqual(retainedTables(defaults), []);
});

test('retention is enabled when any single table has a window', () => {
  assert.equal(isRetentionEnabled(windows({ operations: 30 })), true);
  assert.deepEqual(retainedTables(windows({ operations: 30 })), ['operations']);
  assert.deepEqual(
    retainedTables(windows({ operations: 30, ledgers: 365, contract_events: 7 })),
    ['operations', 'contract_events', 'ledgers'],
    'retained tables come back in prune order, not the order they were configured'
  );
});

test('cutoff is a window of chain time before now', () => {
  const now = Date.UTC(2026, 0, 31, 12, 0, 0);
  assert.equal(retentionCutoff(1, now).toISOString(), '2026-01-30T12:00:00.000Z');
  assert.equal(retentionCutoff(30, now).toISOString(), '2026-01-01T12:00:00.000Z');
});

test('the cutoff is passed as a parameter, never interpolated into SQL', async () => {
  const spec: RetentionSpec = { table: 'operations', timeColumn: 'created_at' };
  const { client, queries } = fakeClient();
  await deleteExpiredBatch(client, spec, retentionCutoff(30), 500);
  assert.match(queries[0].sql, /WHERE created_at < \$1 LIMIT \$2/);
});

test('deletes are batched and bounded rather than unbounded', async () => {
  const { client, queries, deletes } = fakeClient({ deleteCounts: [500] });
  const spec: RetentionSpec = { table: 'operations', timeColumn: 'created_at' };
  const cutoff = retentionCutoff(30);

  assert.equal(await deleteExpiredBatch(client, spec, cutoff, 500), 500);

  assert.match(queries[0].sql, /DELETE FROM operations/);
  assert.deepEqual(queries[0].params, [cutoff, 500]);
  assert.deepEqual(deletes, [500]);
});

test('each table is pruned against its own chain-time column', async () => {
  const ledgers = RETENTION_SPECS.find(spec => spec.table === 'ledgers');
  assert.ok(ledgers);
  const { client, queries } = fakeClient();
  await deleteExpiredBatch(client, ledgers, retentionCutoff(1), 10);
  assert.match(queries[0].sql, /WHERE closed_at < \$1/, 'ledgers close at a different time than they are created');
});

test('a table name that is not a plain identifier is refused, not escaped', async () => {
  // Table names come from RETENTION_SPECS, so this is a guard against that list
  // being edited into something unsafe rather than against external input —
  // but an interpolated identifier cannot be parameterised, so the check earns
  // its place.
  const spec = { table: 'operations; DROP TABLE ledgers', timeColumn: 'created_at' } as unknown as RetentionSpec;
  const { client, queries } = fakeClient();
  await assert.rejects(() => deleteExpiredBatch(client, spec, retentionCutoff(1), 10), /Refusing to use a table name/);
  assert.equal(queries.length, 0);
});

test('tables with no window are left completely alone', async () => {
  const { client, queries } = fakeClient({ deleteCounts: [10] });
  const reports = await pruneExpiredData(fakePool(client), windows({ operations: 30 }), { now: 1 });

  const operations = reports.find(r => r.table === 'operations');
  assert.equal(operations?.skipped, false);
  const skipped = reports.filter(r => r.skipped).map(r => r.table);
  assert.deepEqual(skipped, ['transactions', 'contract_events', 'custom_events', 'ledgers']);

  const touched = queries.filter(q => /DELETE/.test(q.sql));
  assert.ok(touched.every(q => /operations/.test(q.sql)), 'no unconfigured table is touched');
});

test('children are pruned before parents so foreign keys never dangle', async () => {
  const { client } = fakeClient();
  const reports = await pruneExpiredData(
    fakePool(client),
    windows({ operations: 30, transactions: 30, contract_events: 30, custom_events: 30, ledgers: 30 }),
    { now: 1 }
  );

  const order = reports.filter(r => !r.skipped).map(r => r.table);
  assert.deepEqual(order, ['operations', 'transactions', 'contract_events', 'custom_events', 'ledgers']);
  // operations -> transactions -> ledgers is the FK chain; reversing any pair
  // of those would fail the delete rather than merely slow it down.
  assert.ok(order.indexOf('operations') < order.indexOf('transactions'));
  assert.ok(order.indexOf('transactions') < order.indexOf('ledgers'));
});

test('a prune round gives the indexer priority on contested locks', async () => {
  const { client, queries } = fakeClient();
  await pruneExpiredData(fakePool(client), windows({ ledgers: 365 }), { now: 1 });
  const setLockTimeout = queries.find(q => q.sql.startsWith('SET lock_timeout'));
  assert.ok(setLockTimeout, 'the prune session takes a lock_timeout');
  assert.match(setLockTimeout.sql, /lock_timeout = '\d+ms'/);
});

test('a round stops at the batch cap instead of deleting without limit', async () => {
  // Every batch reports a full delete, so only the cap can end the loop. An
  // unbounded loop would keep going until the backlog cleared.
  const { client, deletes } = fakeClient({ deleteCounts: Array(200).fill(1000) });
  const report = await pruneExpiredData(fakePool(client), windows({ ledgers: 365 }), {
    batchSize: 1000, now: 1,
  });
  const ledgers = report.find(r => r.table === 'ledgers');
  assert.equal(deletes.length, 20, 'one delete per batch, capped');
  assert.equal(ledgers?.rowsPruned, 20_000);
});

test('pruning stops as soon as a batch reports nothing left to delete', async () => {
  const { client, deletes } = fakeClient({ deleteCounts: [7] });
  const report = await pruneExpiredData(fakePool(client), windows({ ledgers: 365 }), { batchSize: 10, now: 1 });
  // The loop has to run one batch past the last full one: a DELETE that
  // reports zero rows is the only way to know the table is clean.
  assert.deepEqual(deletes, [7, 0], 'the empty batch that ends the loop is still counted');
  assert.equal(report.find(r => r.table === 'ledgers')?.rowsPruned, 7);
});

test('each table gets its own cutoff, so windows are independent', async () => {
  const { client, queries } = fakeClient();
  await pruneExpiredData(fakePool(client), windows({ operations: 30, ledgers: 365 }), { now: 0 });
  const cutoffs = queries
    .filter(q => /DELETE FROM/.test(q.sql))
    .map(q => (q.params[0] as Date).toISOString());
  // One batch per table here, because an empty database has nothing to delete
  // and the first batch is already the terminating one.
  assert.equal(cutoffs.length, 2, 'one batch per configured table');
  assert.equal(cutoffs[0], new Date(-30 * 24 * 3600 * 1000).toISOString());
  assert.equal(cutoffs[1], new Date(-365 * 24 * 3600 * 1000).toISOString());
});

test('the pool client is released even when a prune statement fails', async () => {
  let released = false;
  const failing = {
    query: async (sql: string) => {
      if (sql.startsWith('SET lock_timeout')) return { rows: [], rowCount: 0 };
      throw new Error('canceling statement due to lock timeout');
    },
    release: () => { released = true; },
  } as unknown as PoolClient;

  await assert.rejects(
    () => pruneExpiredData(fakePool(failing), windows({ ledgers: 30 })),
    /lock timeout/
  );
  // Leaking the client would shrink the pool a little more on every round
  // until indexing had nothing to run on.
  assert.equal(released, true);
});
