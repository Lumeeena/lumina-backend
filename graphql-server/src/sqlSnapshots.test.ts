import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  getAccountAsOfLedgerFromDb,
  getAccountOperationsInLedger,
  getAccountLifecycle,
  getTableCountEstimateOrExact,
  getTradesFromDb,
  getTransactions,
  getAccountTransactions,
  getOperations,
  getOperationsByTransactionHash,
  getAccountOperations,
  getLedgers,
  getLedgerBySequence,
  getAccounts,
  getAccountSigners,
  getSponsoredAccounts,
  getContractDeployment,
  getEventsByContract,
  getContractStorageEntries,
  getActivityRollups,
  getRollupConsistency,
} from './db';
import { getOperationsByAsset, searchTransactions } from './search';
import { getTopAccountsByActivity } from './topAccounts';
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

function fakePool(): {
  pool: Pool;
  getLastQuery: () => { sql: string; params: unknown[] };
  getQueries: () => { sql: string; params: unknown[] }[];
} {
  const queries: { sql: string; params: unknown[] }[] = [];
  let lastQuery = { sql: '', params: [] as unknown[] };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      lastQuery = { sql: sql.replace(/\s+/g, ' ').trim(), params };
      queries.push(lastQuery);
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, getLastQuery: () => lastQuery, getQueries: () => queries };
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
  await getTransactions(pool, 'mainnet', 20, encodeCursor('transactions', [500, 'hash123']), {
    direction: 'FORWARD',
    order: 'DESC',
  });
  const q = getLastQuery();
  verifySqlSnapshot('getTransactions_forward', q.sql, q.params);
});

test('SQL snapshot: getTransactions paginated backward', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTransactions(pool, 'mainnet', 20, encodeCursor('transactions', [500, 'hash123']), {
    direction: 'BACKWARD',
    order: 'DESC',
  });
  const q = getLastQuery();
  verifySqlSnapshot('getTransactions_backward', q.sql, q.params);
});

test('SQL snapshot: getTransactions ascending order', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTransactions(pool, 'mainnet', 20, encodeCursor('transactions', [500, 'hash123']), {
    order: 'ASC',
  });
  const q = getLastQuery();
  verifySqlSnapshot('getTransactions_ascending', q.sql, q.params);
});

// ─── Account Transactions SQL Snapshots ──────────────────────────────────────

test('SQL snapshot: getAccountTransactions representative arguments', async () => {
  const { pool, getLastQuery } = fakePool();
  const address = 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ';
  await getAccountTransactions(pool, 'mainnet', address, 20);
  const q = getLastQuery();

  assert.deepEqual(q.params, [address, 'mainnet', 20]);
  assert.match(q.sql, /WHERE source_account = \$1 AND network = \$2/);
  assert.doesNotMatch(q.sql, /mainnet|GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ/i);
  assert.doesNotMatch(q.sql, /\bOFFSET\b/i);
  assert.match(q.sql, /\bLIMIT \$3\b/);

  verifySqlSnapshot('getAccountTransactions_representative', q.sql, q.params);
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

test('SQL snapshot: getOperationsByTransactionHash', async () => {
  const { pool, getLastQuery } = fakePool();
  const hash = 'tx-hash-not-interpolated-123';
  const network = 'testnet';
  await getOperationsByTransactionHash(pool, network, hash);
  const q = getLastQuery();

  assert.match(q.sql, /WHERE transaction_hash = \$1 AND network = \$2/);
  assert.doesNotMatch(q.sql, new RegExp(hash));
  assert.doesNotMatch(q.sql, new RegExp(network));
  assert.doesNotMatch(q.sql, /\bOFFSET\b/i);
  assert.deepEqual(q.params, [hash, network]);
  verifySqlSnapshot('getOperationsByTransactionHash_default', q.sql, q.params);
});

test('SQL snapshot: getOperations paginated forward', async () => {
  const { pool, getLastQuery } = fakePool();
  await getOperations(pool, {
    network: 'mainnet',
    cursor: encodeCursor('operations', [900, 'op123']),
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
    cursor: encodeCursor('operations', [900, 'op123']),
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

test('SQL snapshot: getLedgerBySequence', async () => {
  const { pool, getLastQuery } = fakePool();
  await getLedgerBySequence(pool, 'mainnet', 500000);
  const q = getLastQuery();
  verifySqlSnapshot('getLedgerBySequence', q.sql, q.params);

  // Values are bound, never interpolated into the statement.
  assert.deepStrictEqual(q.params, [500000, 'mainnet']);
  assert.ok(!q.sql.includes('500000'), 'sequence must be a bound parameter');
  assert.ok(!q.sql.includes('mainnet'), 'network must be a bound parameter');
  // The network scopes the lookup, so the same sequence on another network never matches.
  assert.match(q.sql, /WHERE sequence = \$1 AND network = \$2/);
  // A point lookup: no pagination at all.
  assert.doesNotMatch(q.sql, /\bOFFSET\b/i);
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

// ─── Account As Of Ledger SQL Snapshots (#446) ───────────────────────────────

test('SQL snapshot: getAccountAsOfLedgerFromDb representative arguments', async () => {
  const { pool, getLastQuery, getQueries } = fakePool();
  const address = 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ';
  const result = await getAccountAsOfLedgerFromDb(pool, 'mainnet', address, 52000000);
  const q = getLastQuery();

  // One statement, and no stored state at or before the ledger means null.
  assert.equal(getQueries().length, 1);
  assert.equal(result, null);

  // Values are bound as parameters, in the order the statement numbers them,
  // and never interpolated into the SQL text.
  assert.deepEqual(q.params, [address, 'mainnet', 52000000]);
  assert.ok(!q.sql.includes(address));
  assert.doesNotMatch(q.sql, /mainnet|52000000/);

  // Reads the history table, not the current-state `accounts` table.
  assert.match(q.sql, /\bFROM account_state_history\b/);
  assert.doesNotMatch(q.sql, /\bFROM accounts\b/);

  // The network is part of the predicate. It is the only one of the three
  // predicates that keeps a testnet account's history out of a mainnet answer.
  const where = q.sql.match(/\bWHERE (.+?) ORDER BY\b/)?.[1];
  assert.ok(where, 'statement has a WHERE clause before ORDER BY');
  assert.deepEqual(where.split(' AND '), [
    'address = $1',
    'network = $2',
    'last_modified_ledger <= $3',
  ]);

  // "At or before" the ledger, newest first, one row. This is a point lookup,
  // not a paged list: there is no cursor and so no keyset comparison to assert,
  // and it must not grow an OFFSET.
  assert.match(q.sql, /\bORDER BY last_modified_ledger DESC LIMIT 1$/);
  assert.doesNotMatch(q.sql, /\bOFFSET\b/i);
  assert.doesNotMatch(q.sql, /\(\s*last_modified_ledger\s*,/);

  verifySqlSnapshot('getAccountAsOfLedgerFromDb_representative', q.sql, q.params);
});

test('SQL snapshot: getAccountAsOfLedgerFromDb binds the network it is given', async () => {
  const { pool, getLastQuery } = fakePool();
  const address = 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ';
  await getAccountAsOfLedgerFromDb(pool, 'testnet', address, 1);
  const q = getLastQuery();

  // Same statement for every network; only the bound value differs.
  assert.deepEqual(q.params, [address, 'testnet', 1]);
  assert.doesNotMatch(q.sql, /testnet/);
  assert.match(q.sql, /\bnetwork = \$2\b/);
});

// ─── Account Operations SQL Snapshots (#449) ─────────────────────────────────

test('SQL snapshot: getAccountOperations default query', async () => {
  const { pool, getLastQuery } = fakePool();
  const address = 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ';
  await getAccountOperations(pool, 'mainnet', address, 20);
  const q = getLastQuery();
  assert.deepEqual(q.params, [address, 'mainnet', 20]);
  assert.doesNotMatch(q.sql, /mainnet|GBRPYHIL|20/);
  assert.match(q.sql, /\bsource_account = \$1 AND network = \$2\b/);
  assert.doesNotMatch(q.sql, /\bOFFSET\b/i);
  verifySqlSnapshot('getAccountOperations_default', q.sql, q.params);
});

// ─── Account Signers SQL Snapshots (#454) ────────────────────────────────────

test('SQL snapshot: getAccountSigners default query', async () => {
  const { pool, getLastQuery } = fakePool();
  const address = 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ';
  await getAccountSigners(pool, 'mainnet', address);
  const q = getLastQuery();
  assert.doesNotMatch(q.sql, /mainnet/);
  assert.ok(!q.sql.includes(address));
  assert.match(q.sql, /\bnetwork = \$1\b/);
  assert.doesNotMatch(q.sql, /\bOFFSET\b/i);
  assert.deepEqual(q.params, ['mainnet', address]);
  verifySqlSnapshot('getAccountSigners_default', q.sql, q.params);
});

// ─── Sponsored Accounts SQL Snapshots (#455) ─────────────────────────────────

test('SQL snapshot: getSponsoredAccounts default query', async () => {
  const { pool, getLastQuery } = fakePool();
  const sponsor = 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ';
  await getSponsoredAccounts(pool, 'mainnet', sponsor, 20);
  const q = getLastQuery();
  assert.doesNotMatch(q.sql, /mainnet/);
  assert.ok(!q.sql.includes(sponsor));
  assert.match(q.sql, /\bs\.network = a\.network\b/);
  assert.match(q.sql, /\bs\.network = \$2\b/);
  assert.doesNotMatch(q.sql, /\bOFFSET\b/i);
  assert.deepEqual(q.params, [sponsor, 'mainnet', 20]);
  verifySqlSnapshot('getSponsoredAccounts_default', q.sql, q.params);
});

// ─── Contract Deployment SQL Snapshots (#456) ────────────────────────────────

test('SQL snapshot: getContractDeployment default query', async () => {
  const { pool, getLastQuery } = fakePool();
  const contractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  await getContractDeployment(pool, 'mainnet', contractId);
  const q = getLastQuery();
  assert.doesNotMatch(q.sql, /mainnet/);
  assert.ok(!q.sql.includes(contractId));
  assert.match(q.sql, /\bnetwork = \$1\b/);
  assert.doesNotMatch(q.sql, /\bOFFSET\b/i);
  assert.deepEqual(q.params, ['mainnet', contractId]);
  verifySqlSnapshot('getContractDeployment_default', q.sql, q.params);
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
    cursor: encodeCursor('events', [900, 'evt-123']),
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
    cursor: encodeCursor('operations', [900, 'op123']),
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

// ─── Top Accounts SQL Snapshots (#376) ───────────────────────────────────────

test('SQL snapshot: getTopAccountsByActivity windowed', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTopAccountsByActivity(pool, {
    network: 'mainnet',
    window: '7d',
    limit: 20,
  });
  const q = getLastQuery();
  assert.doesNotMatch(q.sql, /history_operations|history_trades/);
  assert.deepEqual(q.params, ['mainnet', 604800, 20]);
  verifySqlSnapshot('getTopAccountsByActivity_windowed', q.sql, q.params);
});

test('SQL snapshot: getTopAccountsByActivity all time', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTopAccountsByActivity(pool, {
    network: 'testnet',
    window: 'all',
    limit: 10,
  });
  const q = getLastQuery();
  assert.doesNotMatch(q.sql, /history_operations|history_trades/);
  assert.deepEqual(q.params, ['testnet', 10]);
  verifySqlSnapshot('getTopAccountsByActivity_all', q.sql, q.params);
});

// ─── Account Operations In Ledger SQL Snapshots (#451) ───────────────────────

test('SQL snapshot: getAccountOperationsInLedger default query', async () => {
  const { pool, getLastQuery } = fakePool();
  const address = 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ';
  await getAccountOperationsInLedger(pool, 'mainnet', 500000, address);
  const q = getLastQuery();
  assert.deepEqual(q.params, [500000, address, 'mainnet']);
  assert.doesNotMatch(q.sql, /mainnet|500000|GBRPYHIL/);
  assert.match(q.sql, /\bnetwork\s*=\s*\$\d+/);
  verifySqlSnapshot('getAccountOperationsInLedger_default', q.sql, q.params);
});

// ─── Transactions By Ledger SQL Snapshots (#450) ─────────────────────────────

test('SQL snapshot: getTransactionsByLedger default query', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTransactionsByLedger(pool, 'mainnet', 500000);
  const q = getLastQuery();
  assert.deepEqual(q.params, [500000, 'mainnet']);
  assert.doesNotMatch(q.sql, /mainnet|500000/);
  assert.match(q.sql, /\bnetwork\s*=\s*\$\d+/);
  verifySqlSnapshot('getTransactionsByLedger_default', q.sql, q.params);
});

// ─── Trades SQL Snapshots (#452) ─────────────────────────────────────────────

test('SQL snapshot: getTradesFromDb default query', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTradesFromDb(pool, 'mainnet', { limit: 20 });
  const q = getLastQuery();
  assert.deepEqual(q.params, ['mainnet', 20]);
  assert.doesNotMatch(q.sql, /mainnet/);
  assert.match(q.sql, /\bnetwork\s*=\s*\$\d+/);
  assert.doesNotMatch(q.sql, /\bOFFSET\b/i);
  verifySqlSnapshot('getTradesFromDb_default', q.sql, q.params);
});

test('SQL snapshot: getTradesFromDb filtered and paginated forward', async () => {
  const { pool, getLastQuery } = fakePool();
  const account = 'GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ';
  const issuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  await getTradesFromDb(pool, 'mainnet', {
    account,
    baseAsset: { assetType: 'native' },
    counterAsset: {
      assetType: 'credit_alphanum4',
      assetCode: 'USDC',
      assetIssuer: issuer,
    },
    cursor: encodeCursor('trades', ['2026-01-01T00:00:00Z', 'trade-123']),
    limit: 20,
  });
  const q = getLastQuery();
  assert.deepEqual(q.params, [
    'mainnet',
    account,
    'native',
    'credit_alphanum4',
    'USDC',
    issuer,
    '2026-01-01T00:00:00Z',
    'trade-123',
    20,
  ]);
  assert.doesNotMatch(q.sql, /mainnet|GBRPYHIL|USDC|GA5ZSEJY|trade-123|2026-01-01/);
  assert.match(q.sql, /\bnetwork\s*=\s*\$\d+/);
  assert.match(q.sql, /\(ledger_close_time,\s*id\)\s*<\s*\(\$\d+::timestamptz,\s*\$\d+::text\)/);
  assert.doesNotMatch(q.sql, /\bOFFSET\b/i);
  verifySqlSnapshot('getTradesFromDb_filtered_forward', q.sql, q.params);
});

// ─── Table Count Estimate Or Exact SQL Snapshots (#453) ──────────────────────

test('SQL snapshot: getTableCountEstimateOrExact ledgers exact count', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTableCountEstimateOrExact(pool, 'ledgers', 'mainnet');
  const q = getLastQuery();
  assert.deepEqual(q.params, ['mainnet']);
  assert.doesNotMatch(q.sql, /mainnet/);
  assert.match(q.sql, /\bnetwork\s*=\s*\$\d+/);
  verifySqlSnapshot('getTableCountEstimateOrExact_ledgers', q.sql, q.params);
});

test('SQL snapshot: getTableCountEstimateOrExact exact fallback', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTableCountEstimateOrExact(pool, 'transactions', 'mainnet');
  const q = getLastQuery();
  assert.deepEqual(q.params, ['mainnet']);
  assert.doesNotMatch(q.sql, /mainnet/);
  assert.match(q.sql, /\bnetwork\s*=\s*\$\d+/);
  verifySqlSnapshot('getTableCountEstimateOrExact_exactFallback', q.sql, q.params);
});

test('SQL snapshot: getTableCountEstimateOrExact pg_class estimate', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTableCountEstimateOrExact(pool, 'transactions', 'mainnet', {
    affordableThreshold: 0,
  });
  const q = getLastQuery();
  assert.deepEqual(q.params, ['transactions']);
  assert.doesNotMatch(q.sql, /transactions/);
  verifySqlSnapshot('getTableCountEstimateOrExact_estimate', q.sql, q.params);
});

test('SQL snapshot: getTableCountEstimateOrExact filtered whereClause', async () => {
  const { pool, getLastQuery } = fakePool();
  await getTableCountEstimateOrExact(pool, 'transactions', 'mainnet', {
    whereClause: 'network = $1 AND successful = $2',
    params: ['mainnet', true],
  });
  const q = getLastQuery();
  assert.deepEqual(q.params, ['mainnet', true]);
  assert.doesNotMatch(q.sql, /mainnet|true/);
  assert.match(q.sql, /\bnetwork\s*=\s*\$\d+/);
  verifySqlSnapshot('getTableCountEstimateOrExact_filtered', q.sql, q.params);
});
