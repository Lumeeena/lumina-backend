import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  getTransactions,
  getOperations,
  getLedgers,
  getAccounts,
  getEventsByContract,
  getContractStorageEntries,
} from './db';
import { getOperationsByAsset, searchTransactions } from './search';
import { encodeCursor } from './pagination';

const SNAPSHOTS_DIR = join(__dirname, '__snapshots__');
const SNAPSHOTS_FILE = join(SNAPSHOTS_DIR, 'sql_queries.json');
const SHOULD_UPDATE = process.env.UPDATE_SQL_SNAPSHOTS === 'true' || process.env.UPDATE_SNAPSHOTS === '1';

let snapshots: Record<string, { sql: string; paramCount: number }> = {};
let modified = false;

before(() => {
  if (existsSync(SNAPSHOTS_FILE)) {
    try {
      snapshots = JSON.parse(readFileSync(SNAPSHOTS_FILE, 'utf8'));
    } catch {
      snapshots = {};
    }
  }
});

after(() => {
  if (modified && SHOULD_UPDATE) {
    if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    // Sort keys alphabetically for stable formatting
    const sorted = Object.keys(snapshots).sort().reduce<Record<string, { sql: string; paramCount: number }>>((acc, key) => {
      acc[key] = snapshots[key]!;
      return acc;
    }, {});
    writeFileSync(SNAPSHOTS_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  }
});

function fakePool(): { pool: Pool; getLastQuery: () => { sql: string; params: unknown[] } } {
  let lastQuery = { sql: '', params: [] as unknown[] };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      lastQuery = { sql: sql.replace(/\s+/g, ' ').trim(), params };
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, getLastQuery: () => lastQuery };
}

function verifySqlSnapshot(testName: string, sql: string, params: unknown[]) {
  const normalizedSql = sql.replace(/\s+/g, ' ').trim();
  const entry = { sql: normalizedSql, paramCount: params.length };

  if (SHOULD_UPDATE) {
    snapshots[testName] = entry;
    modified = true;
    return;
  }

  const existing = snapshots[testName];
  if (!existing) {
    if (!existsSync(SNAPSHOTS_FILE)) {
      // If snapshot file doesn't exist at all yet, record initial snapshot
      snapshots[testName] = entry;
      modified = true;
      return;
    }
    throw new Error(
      `No snapshot found for query "${testName}".\n` +
      `If this is a newly added query, accept it by running:\n` +
      `  npm run test:sql-snapshots:update\n` +
      `or with: UPDATE_SQL_SNAPSHOTS=true node --test src/sqlSnapshots.test.ts`
    );
  }

  if (existing.sql !== normalizedSql || existing.paramCount !== params.length) {
    assert.strictEqual(
      normalizedSql,
      existing.sql,
      `Generated SQL for "${testName}" has changed.\n` +
      `Expected:\n  ${existing.sql}\n` +
      `Received:\n  ${normalizedSql}\n\n` +
      `If this SQL change is intentional, accept it by running:\n` +
      `  npm run test:sql-snapshots:update\n` +
      `or with: UPDATE_SQL_SNAPSHOTS=true node --test src/sqlSnapshots.test.ts\n`
    );
  }
}

// ─── Transactions SQL Snapshots ──────────────────────────────────────────────

test('SQL snapshot: getTransactions default query', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTransactions(pool, 'mainnet', 20);
  const q = getLastQuery();
  verifySqlSnapshot('getTransactions_default', q.sql, q.params);
});

test('SQL snapshot: getTransactions filtered (successful, from, to, sourceAccount)', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTransactions(pool, 'mainnet', 20, null, {
    successful: true,
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-02T00:00:00Z',
    sourceAccount: 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ',
    order: 'DESC',
  });
  const q = getLastQuery();
  verifySqlSnapshot('getTransactions_filtered', q.sql, q.params);
});

test('SQL snapshot: getTransactions paginated forward', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTransactions(pool, 'mainnet', 20, encodeCursor('transactions', [500000, 'hash123']), {
    direction: 'FORWARD',
    order: 'DESC',
  });
  const q = getLastQuery();
  verifySqlSnapshot('getTransactions_forward', q.sql, q.params);
});

test('SQL snapshot: getTransactions paginated backward', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTransactions(pool, 'mainnet', 20, encodeCursor('transactions', [500000, 'hash123']), {
    direction: 'BACKWARD',
    order: 'DESC',
  });
  const q = getLastQuery();
  verifySqlSnapshot('getTransactions_backward', q.sql, q.params);
});

test('SQL snapshot: getTransactions ascending order', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTransactions(pool, 'mainnet', 20, encodeCursor('transactions', [500000, 'hash123']), {
    order: 'ASC',
  });
  const q = getLastQuery();
  verifySqlSnapshot('getTransactions_ascending', q.sql, q.params);
});

// ─── Operations SQL Snapshots ────────────────────────────────────────────────

test('SQL snapshot: getOperations default query', async () => {
  const { pool, getLastQuery } = fakePool();
  await getOperations(pool, { network: 'mainnet', limit: 20 });
  const q = getLastQuery();
  verifySqlSnapshot('getOperations_default', q.sql, q.params);
});

test('SQL snapshot: getOperations filtered by account and type', async () => {
  const { pool, getLastQuery } = fakePool();
  await getOperations(pool, {
    network: 'mainnet',
    account: 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ',
    type: 'PAYMENT',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('getOperations_filtered', q.sql, q.params);
});

test('SQL snapshot: getOperations paginated forward', async () => {
  const { pool, getLastQuery } = fakePool();
  await getOperations(pool, {
    network: 'mainnet',
    cursor: encodeCursor('operations', [500000, 'op123']),
    direction: 'FORWARD',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('getOperations_forward', q.sql, q.params);
});

test('SQL snapshot: getOperations paginated backward', async () => {
  const { pool, getLastQuery } = fakePool();
  await getOperations(pool, {
    network: 'mainnet',
    cursor: encodeCursor('operations', [500000, 'op123']),
    direction: 'BACKWARD',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('getOperations_backward', q.sql, q.params);
});

// ─── Ledgers SQL Snapshots ───────────────────────────────────────────────────

test('SQL snapshot: getLedgers default query', async () => {
  const { pool, getLastQuery } = fakePool();
  await getLedgers(pool, 'mainnet', 20);
  const q = getLastQuery();
  verifySqlSnapshot('getLedgers_default', q.sql, q.params);
});

test('SQL snapshot: getLedgers paginated forward', async () => {
  const { pool, getLastQuery } = fakePool();
  const cursor = encodeCursor('ledgers', [500000]);
  await getLedgers(pool, 'mainnet', 20, cursor, 'FORWARD');
  const q = getLastQuery();
  verifySqlSnapshot('getLedgers_forward', q.sql, q.params);
});

test('SQL snapshot: getLedgers paginated backward', async () => {
  const { pool, getLastQuery } = fakePool();
  const cursor = encodeCursor('ledgers', [500000]);
  await getLedgers(pool, 'mainnet', 20, cursor, 'BACKWARD');
  const q = getLastQuery();
  verifySqlSnapshot('getLedgers_backward', q.sql, q.params);
});

// ─── Accounts SQL Snapshots ──────────────────────────────────────────────────

test('SQL snapshot: getAccounts recent activity default', async () => {
  const { pool, getLastQuery } = fakePool();
  await getAccounts(pool, { network: 'mainnet', limit: 20, orderBy: 'RECENT_ACTIVITY' });
  const q = getLastQuery();
  verifySqlSnapshot('getAccounts_recentActivity_default', q.sql, q.params);
});

test('SQL snapshot: getAccounts recent activity forward', async () => {
  const { pool, getLastQuery } = fakePool();
  const cursor = encodeCursor('accounts', [500000, 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ']);
  await getAccounts(pool, {
    network: 'mainnet',
    limit: 20,
    orderBy: 'RECENT_ACTIVITY',
    cursor,
    direction: 'FORWARD',
  });
  const q = getLastQuery();
  verifySqlSnapshot('getAccounts_recentActivity_forward', q.sql, q.params);
});

test('SQL snapshot: getAccounts recent activity backward', async () => {
  const { pool, getLastQuery } = fakePool();
  const cursor = encodeCursor('accounts', [500000, 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ']);
  await getAccounts(pool, {
    network: 'mainnet',
    limit: 20,
    orderBy: 'RECENT_ACTIVITY',
    cursor,
    direction: 'BACKWARD',
  });
  const q = getLastQuery();
  verifySqlSnapshot('getAccounts_recentActivity_backward', q.sql, q.params);
});

test('SQL snapshot: getAccounts address order default', async () => {
  const { pool, getLastQuery } = fakePool();
  await getAccounts(pool, { network: 'mainnet', limit: 20, orderBy: 'ADDRESS' });
  const q = getLastQuery();
  verifySqlSnapshot('getAccounts_address_default', q.sql, q.params);
});

// ─── Events By Contract SQL Snapshots ────────────────────────────────────────

test('SQL snapshot: getEventsByContract default query', async () => {
  const { pool, getLastQuery } = fakePool();
  await getEventsByContract(pool, {
    network: 'mainnet',
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('getEventsByContract_default', q.sql, q.params);
});

test('SQL snapshot: getEventsByContract filtered with topic and cursor', async () => {
  const { pool, getLastQuery } = fakePool();
  await getEventsByContract(pool, {
    network: 'mainnet',
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    topic: 'transfer',
    cursor: encodeCursor('events', [500000, 'evt-123']),
    direction: 'FORWARD',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('getEventsByContract_filtered_forward', q.sql, q.params);
});

// ─── Contract Storage Entries SQL Snapshots ──────────────────────────────────

test('SQL snapshot: getContractStorageEntries default query', async () => {
  const { pool, getLastQuery } = fakePool();
  await getContractStorageEntries(pool, {
    network: 'mainnet',
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('getContractStorageEntries_default', q.sql, q.params);
});

test('SQL snapshot: getContractStorageEntries filtered by durability and prefix', async () => {
  const { pool, getLastQuery } = fakePool();
  await getContractStorageEntries(pool, {
    network: 'mainnet',
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    durability: 'PERSISTENT',
    keyPrefix: 'user_balance_',
    cursor: 'key123',
    direction: 'FORWARD',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('getContractStorageEntries_filtered_forward', q.sql, q.params);
});

// ─── Operations By Asset SQL Snapshots ───────────────────────────────────────

test('SQL snapshot: getOperationsByAsset native XLM', async () => {
  const { pool, getLastQuery } = fakePool();
  await getOperationsByAsset(pool, {
    network: 'mainnet',
    asset: 'XLM',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('getOperationsByAsset_native_XLM', q.sql, q.params);
});

test('SQL snapshot: getOperationsByAsset issued token forward', async () => {
  const { pool, getLastQuery } = fakePool();
  await getOperationsByAsset(pool, {
    network: 'mainnet',
    asset: 'USDC:GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ',
    cursor: encodeCursor('operations', [500000, 'op123']),
    direction: 'FORWARD',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('getOperationsByAsset_issued_forward', q.sql, q.params);
});

// ─── Search Transactions SQL Snapshots ───────────────────────────────────────

test('SQL snapshot: searchTransactions default query', async () => {
  const { pool, getLastQuery } = fakePool();
  await searchTransactions(pool, {
    network: 'mainnet',
    query: 'stellar payment',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('searchTransactions_default', q.sql, q.params);
});

test('SQL snapshot: searchTransactions paginated backward', async () => {
  const { pool, getLastQuery } = fakePool();
  const cursor = encodeCursor('search', [0.85, 500000, 'hash123']);
  await searchTransactions(pool, {
    network: 'mainnet',
    query: 'stellar payment',
    cursor,
    direction: 'BACKWARD',
    limit: 20,
  });
  const q = getLastQuery();
  verifySqlSnapshot('searchTransactions_backward', q.sql, q.params);
});
