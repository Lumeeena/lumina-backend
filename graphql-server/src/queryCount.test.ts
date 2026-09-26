import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createContext, resolvers } from './resolvers';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function txRow(n: number) {
  return {
    network: 'mainnet',
    hash: `tx_${n}`,
    ledger: String(100 + (n % 4)),
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: `GACCOUNT_${n % 5}`,
    fee_charged: '100',
    operation_count: 1,
    successful: true,
    memo_type: 'none',
    memo: null,
  };
}

function ledgerRow(sequence: number) {
  return {
    network: 'mainnet',
    sequence: String(sequence),
    closed_at: new Date('2026-01-01T00:00:00Z'),
    transaction_count: 1,
    operation_count: 1,
    base_fee: '100',
    base_reserve: '5000000',
  };
}

function accountRow(address: string) {
  return {
    network: 'mainnet',
    address,
    sequence: '1',
    subentry_count: 0,
    last_modified_ledger: '100',
    num_sponsored: 0,
    num_sponsoring: 0,
    balances: [],
    flags: {},
    thresholds: {},
  };
}

function opRow(hash: string, n: number) {
  return {
    network: 'mainnet',
    id: `${hash}_op_${n}`,
    type: 'payment',
    transaction_hash: hash,
    ledger: '100',
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GOP_SOURCE',
    details: {},
  };
}

function countingPool() {
  const txs = Array.from({ length: 20 }, (_, i) => txRow(i));
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM transactions\s+WHERE network = \$1/.test(sql)) return { rows: txs };
      if (/FROM accounts WHERE address = ANY/.test(sql)) return { rows: (params[0] as string[]).map(accountRow) };
      if (/FROM ledgers WHERE sequence = ANY/.test(sql)) return { rows: (params[0] as number[]).map(ledgerRow) };
      if (/FROM operations WHERE transaction_hash = ANY/.test(sql)) {
        return { rows: (params[0] as string[]).flatMap((hash, i) => [opRow(hash, i)]) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('a page of 20 transactions with accounts uses a constant number of queries', async () => {
  const { pool, calls } = countingPool();
  const context = createContext(pool);

  const page = await resolvers.Query.transactions({}, { limit: 20 }, context);
  await Promise.all(page.items.map(tx => resolvers.Transaction.account(tx, {}, context)));

  assert.equal(calls.length, 2);
  assert.match(calls[0]?.sql ?? '', /FROM transactions/);
  assert.match(calls[1]?.sql ?? '', /FROM accounts WHERE address = ANY/);
});

test('representative nested transaction fields stay batched', async () => {
  const { pool, calls } = countingPool();
  const context = createContext(pool);

  const page = await resolvers.Query.transactions({}, { limit: 20 }, context);
  await Promise.all(page.items.map(tx => Promise.all([
    resolvers.Transaction.account(tx, {}, context),
    resolvers.Transaction.ledgerData(tx, {}, context),
    resolvers.Transaction.operations(tx, {}, context),
  ])));

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => {
    if (/FROM transactions/.test(call.sql)) return 'transactions';
    if (/FROM accounts/.test(call.sql)) return 'accounts';
    if (/FROM ledgers/.test(call.sql)) return 'ledgers';
    if (/FROM operations/.test(call.sql)) return 'operations';
    return 'unknown';
  }), ['transactions', 'accounts', 'ledgers', 'operations']);
});
