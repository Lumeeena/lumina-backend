import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { IndexedNotification } from './notifications';
import type { LedgerNotifier } from './pubsub';
import { createSubscriptionResolvers, type SubscriptionContext } from './subscriptions';
import { EXTENDED_SUBSCRIPTION_TOPICS } from './subscriptionsExtended';

function fakeNotifier() {
  let push: (n: IndexedNotification) => void = () => {};
  let finish: () => void = () => {};
  const queue: IndexedNotification[] = [];
  let waiting: ((r: IteratorResult<IndexedNotification>) => void) | null = null;
  let done = false;

  push = (n) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: n, done: false });
    } else {
      queue.push(n);
    }
  };

  finish = () => {
    done = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: undefined, done: true });
    }
  };

  const iterator: AsyncIterableIterator<IndexedNotification> = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    next: () => {
      const buffered = queue.shift();
      if (buffered) return Promise.resolve({ value: buffered, done: false });
      if (done) return Promise.resolve({ value: undefined, done: true } as IteratorResult<IndexedNotification>);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    return: () => {
      done = true;
      return Promise.resolve({ value: undefined, done: true } as IteratorResult<IndexedNotification>);
    },
    throw: () => Promise.resolve({ value: undefined, done: true } as IteratorResult<IndexedNotification>),
  };

  const notifier = { subscribe: () => iterator } as unknown as LedgerNotifier;
  return { notifier, push, finish };
}

interface QueryCall {
  sql: string;
  params: unknown[];
}

function fakePool(rowsFor: (sql: string, params: unknown[]) => unknown[]) {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: rowsFor(sql, params) };
    },
  } as unknown as Pool;
  return { pool, calls };
}

function tradeRow(id: string) {
  return {
    id,
    paging_token: `${id}-0`,
    ledger_close_time: new Date('2026-05-01T12:00:00Z'),
    trade_type: 'orderbook',
    base_account: 'GBUYER',
    base_amount: '100.0000000',
    base_asset_type: 'credit_alphanum4',
    base_asset_code: 'USDC',
    base_asset_issuer: 'GISSUER',
    base_offer_id: '1',
    counter_account: 'GSELLER',
    counter_amount: '500.0000000',
    counter_asset_type: 'native',
    counter_asset_code: null,
    counter_asset_issuer: null,
    counter_offer_id: '2',
    base_is_seller: false,
    price_n: '5',
    price_d: '1',
    price: '5.0000000',
    network: 'mainnet',
  };
}

function contractEventRow(id: string, ledger = 200) {
  return {
    id,
    type: 'contract',
    contract_id: 'CCONTRACT1',
    ledger,
    created_at: new Date('2026-05-01T12:00:05Z'),
    paging_token: `${ledger}-0`,
    topic: ['transfer'],
    value: { amount: '42' },
    transaction_hash: 'txhash1',
    in_successful_contract_call: true,
    network: 'mainnet',
  };
}

test('newTrade streams indexed trades with network and filter arguments', async () => {
  const { notifier, push, finish } = fakeNotifier();
  const { pool, calls } = fakePool(() => [tradeRow('t1'), tradeRow('t2')]);
  const resolvers = createSubscriptionResolvers();
  const ctx: SubscriptionContext = { pool, notifier };

  const stream = resolvers.newTrade.subscribe(
    null,
    { network: 'MAINNET', baseAssetCode: 'USDC', account: 'GBUYER' },
    ctx
  );

  // Events-only and wrong-network notifications must be skipped.
  push({ kind: 'events', network: 'mainnet', ledger: 99, events: 1 });
  push({ kind: 'ledger', network: 'testnet', ledger: 100 });
  push({ kind: 'ledger', network: 'mainnet', ledger: 101 });
  finish();

  const received: unknown[] = [];
  for await (const item of stream) {
    received.push(resolvers.newTrade.resolve(item));
  }

  assert.equal(received.length, 2);
  assert.equal((received[0] as { id: string }).id, 't1');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.params, ['mainnet', 101, 'USDC', 'GBUYER']);
});

test('newContractEvent streams indexed Soroban contract events with contractId/type filters', async () => {
  const { notifier, push, finish } = fakeNotifier();
  const { pool, calls } = fakePool(() => [contractEventRow('ev-1', 200)]);
  const resolvers = createSubscriptionResolvers();
  const ctx: SubscriptionContext = { pool, notifier };

  const stream = resolvers.newContractEvent.subscribe(
    null,
    { network: 'MAINNET', contractId: 'CCONTRACT1', type: 'contract' },
    ctx
  );

  // Plain ledger notifications and wrong-network event notifications are ignored.
  push({ kind: 'ledger', network: 'mainnet', ledger: 199 });
  push({ kind: 'events', network: 'testnet', ledger: 200, events: 1 });
  push({ kind: 'events', network: 'mainnet', ledger: 200, events: 1 });
  finish();

  const received: unknown[] = [];
  for await (const item of stream) {
    received.push(resolvers.newContractEvent.resolve(item));
  }

  assert.equal(received.length, 1);
  assert.equal((received[0] as { id: string }).id, 'ev-1');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.params, ['mainnet', 200, 'CCONTRACT1', 'contract']);
});

test('NEW_OFFER is intentionally omitted until offers are indexed', () => {
  const resolvers = createSubscriptionResolvers();
  assert.equal('newOffer' in resolvers, false);
  assert.equal('NEW_OFFER' in EXTENDED_SUBSCRIPTION_TOPICS, false);
});
