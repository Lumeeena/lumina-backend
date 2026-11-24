/**
 * The batch functions run against a stub pool, so these tests pin the batching
 * contract: keys requested in one tick share one query, results come back in
 * key order with `null` (or `[]`) for misses, and every query names its network.
 *
 * Only keys the stub database answers are requested. A database miss on the
 * account loader falls through to Horizon over the network, which these tests
 * do not reach.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createLoaders } from './loaders';
import type { NetworkConfig } from './networks';

const MAINNET: NetworkConfig = {
  name: 'mainnet',
  horizonUrl: 'https://horizon.example',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
};

const TESTNET: NetworkConfig = {
  name: 'testnet',
  horizonUrl: 'https://horizon-testnet.example',
  networkPassphrase: 'Test SDF Network ; September 2015',
};

const CLOSED_AT = new Date('2026-01-01T00:00:00.000Z');

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** A pool that answers every query with the same rows and records each call. */
function stubPool(rows: unknown[]) {
  const queries: RecordedQuery[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, queries };
}

function ledgerRow(sequence: number) {
  return {
    sequence: String(sequence),
    network: 'mainnet',
    closed_at: CLOSED_AT,
    transaction_count: 3,
    operation_count: 7,
    base_fee: '100',
    base_reserve: '5000000',
  };
}

function transactionRow(hash: string) {
  return {
    hash,
    network: 'mainnet',
    ledger: '10',
    created_at: CLOSED_AT,
    source_account: 'GSOURCE',
    fee_charged: '100',
    operation_count: 1,
    successful: true,
    memo_type: null,
    memo: null,
  };
}

function operationRow(transactionHash: string, id: string) {
  return {
    id,
    network: 'mainnet',
    type: 'payment',
    transaction_hash: transactionHash,
    ledger: '10',
    created_at: CLOSED_AT,
    source_account: 'GSOURCE',
    details: {},
  };
}

function accountRow(address: string, lastModifiedLedger: string) {
  return {
    address,
    network: 'mainnet',
    sequence: '100',
    subentry_count: 0,
    last_modified_ledger: lastModifiedLedger,
    num_sponsored: 0,
    num_sponsoring: 0,
    balances: [],
    flags: {},
    thresholds: {},
  };
}

test('ledger loads made in one tick share a single query and return null for misses', async () => {
  const { pool, queries } = stubPool([ledgerRow(10), ledgerRow(12)]);
  const { ledger } = createLoaders(pool, MAINNET);

  const [first, missing, third] = await Promise.all([ledger.load(10), ledger.load(11), ledger.load(12)]);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [[10, 11, 12], 'mainnet']);
  assert.equal(first?.sequence, 10);
  assert.equal(missing, null);
  assert.equal(third?.sequence, 12);
});

test('transaction loads are keyed by hash, with null for a hash that has no row', async () => {
  const { pool, queries } = stubPool([transactionRow('aa')]);
  const { transaction } = createLoaders(pool, MAINNET);

  const [found, missing] = await Promise.all([transaction.load('aa'), transaction.load('bb')]);

  assert.equal(queries.length, 1);
  assert.equal(found?.hash, 'aa');
  assert.equal(found?.ledger, 10);
  assert.equal(missing, null);
});

test('operations are grouped under their transaction hash, and a hash with none gets an empty list', async () => {
  const { pool, queries } = stubPool([operationRow('aa', '1'), operationRow('aa', '2')]);
  const { operationsByTransactionHash } = createLoaders(pool, MAINNET);

  const [withOperations, withoutOperations] = await Promise.all([
    operationsByTransactionHash.load('aa'),
    operationsByTransactionHash.load('bb'),
  ]);

  assert.equal(queries.length, 1);
  assert.deepEqual(withOperations.map(operation => operation.id), ['1', '2']);
  assert.deepEqual(withoutOperations, []);
});

test('an account the indexer has is answered from the database', async () => {
  const { pool, queries } = stubPool([accountRow('GACCOUNT', '42')]);
  const { account } = createLoaders(pool, MAINNET);

  const found = await account.load('GACCOUNT');

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [['GACCOUNT'], 'mainnet']);
  assert.equal(found?.address, 'GACCOUNT');
  assert.equal(found?.lastModifiedLedger, 42);
  assert.equal(found?.subentryCount, 0);
});

test('each network gets its own loaders, and each query names its network', async () => {
  // A loader caches one answer per key. The same sequence exists on every chain,
  // so a loader shared between networks would return the first network's row for
  // a sequence the second network also has.
  const { pool, queries } = stubPool([ledgerRow(10)]);
  const mainnet = createLoaders(pool, MAINNET);
  const testnet = createLoaders(pool, TESTNET);

  assert.notEqual(mainnet.ledger, testnet.ledger);

  await mainnet.ledger.load(10);
  await testnet.ledger.load(10);

  assert.deepEqual(
    queries.map(query => query.params[1]),
    ['mainnet', 'testnet']
  );
});
