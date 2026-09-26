import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { IndexedNotification } from './notifications';
import type { LedgerNotifier } from './pubsub';
import { createSubscriptionResolvers, type SubscriptionContext } from './subscriptions';

/**
 * A notifier whose stream the test feeds by hand, so a resolver can be driven
 * without Postgres, a socket, or a clock.
 */
function fakeNotifier() {
  let push: (n: IndexedNotification) => void = () => {};
  let finish: () => void = () => {};
  const queue: IndexedNotification[] = [];
  let waiting: ((r: IteratorResult<IndexedNotification>) => void) | null = null;
  let done = false;

  push = n => {
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
      return new Promise(resolve => {
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

function txRow(hash: string, ledger = 100) {
  return {
    hash,
    ledger,
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GSOURCE',
    fee_charged: '100',
    operation_count: 1,
    successful: true,
    memo_type: 'none',
    memo: null,
  };
}

function opRow(id: string, ledger = 100, details: Record<string, unknown> = {}) {
  return {
    id,
    type: 'payment',
    transaction_hash: 'tx1',
    ledger,
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GSOURCE',
    details,
  };
}

/** Pull `count` values off a subscription, then close it. */
async function take<T>(stream: AsyncIterable<T>, count: number): Promise<T[]> {
  const out: T[] = [];
  if (count === 0) return out;
  for await (const value of stream) {
    out.push(value);
    if (out.length >= count) break;
  }
  return out;
}

const resolvers = createSubscriptionResolvers();

test('newTransaction yields each transaction in the announced ledger', async () => {
  const { notifier, push } = fakeNotifier();
  const { pool, calls } = fakePool(() => [txRow('tx_a'), txRow('tx_b')]);

  const stream = resolvers.newTransaction.subscribe({}, {}, { pool, notifier } as SubscriptionContext);
  push({ kind: 'ledger', ledger: 100, transactions: 2 });

  const received = (await take(stream, 2)) as { hash: string }[];

  assert.deepEqual(received.map(t => t.hash), ['tx_a', 'tx_b']);
  // The notification carried only a ledger number; the rows come from the DB,
  // scoped to this subscription's network — ledger 100 exists on every chain.
  assert.match(calls[0]?.sql ?? '', /FROM transactions WHERE ledger = \$1 AND network = \$2/);
  assert.deepEqual(calls[0]?.params, [100, 'mainnet']);
});

test('newTransaction maps rows into the GraphQL shape, not raw columns', async () => {
  const { notifier, push } = fakeNotifier();
  const { pool } = fakePool(() => [txRow('tx_a')]);

  const stream = resolvers.newTransaction.subscribe({}, {}, { pool, notifier } as SubscriptionContext);
  push({ kind: 'ledger', ledger: 100 });

  const tx = (await take(stream, 1))[0] as Record<string, unknown>;

  assert.equal(tx['sourceAccount'], 'GSOURCE');
  assert.equal(tx['createdAt'], '2026-01-01T00:00:00.000Z');
  assert.equal(tx['source_account'], undefined, 'snake_case columns must not leak through');
});

test('newTransaction ignores event-only notifications', async () => {
  const { notifier, push } = fakeNotifier();
  const { pool, calls } = fakePool(() => [txRow('tx_a')]);

  const stream = resolvers.newTransaction.subscribe({}, {}, { pool, notifier } as SubscriptionContext);
  // Contract events are not transactions; reading the ledger for them would be
  // a wasted query and would re-push transactions already sent.
  push({ kind: 'events', ledger: 100, events: 3 });
  push({ kind: 'ledger', ledger: 101 });

  const received = (await take(stream, 1)) as { hash: string }[];

  assert.equal(received.length, 1);
  assert.equal(calls.length, 1, 'only the ledger notification should have hit the DB');
  assert.deepEqual(calls[0]?.params, [101, 'mainnet']);
});

test('a ledger with no transactions yields nothing and does not stall the stream', async () => {
  const { notifier, push } = fakeNotifier();
  const { pool } = fakePool((_sql, params) => (params[0] === 100 ? [] : [txRow('tx_later', 101)]));

  const stream = resolvers.newTransaction.subscribe({}, {}, { pool, notifier } as SubscriptionContext);
  push({ kind: 'ledger', ledger: 100 });
  push({ kind: 'ledger', ledger: 101 });

  const received = (await take(stream, 1)) as { hash: string }[];

  assert.deepEqual(received.map(t => t.hash), ['tx_later']);
});

test('a failed ledger read costs that ledger, not the subscription', async () => {
  const { notifier, push } = fakeNotifier();
  const logged: string[] = [];
  const failing = createSubscriptionResolvers(message => logged.push(message));

  let first = true;
  const pool = {
    query: async () => {
      if (first) {
        first = false;
        throw new Error('deadlock detected');
      }
      return { rows: [txRow('tx_after_failure')] };
    },
  } as unknown as Pool;

  const stream = failing.newTransaction.subscribe({}, {}, { pool, notifier } as SubscriptionContext);
  push({ kind: 'ledger', ledger: 100 });
  push({ kind: 'ledger', ledger: 101 });

  const received = (await take(stream, 1)) as { hash: string }[];

  assert.deepEqual(received.map(t => t.hash), ['tx_after_failure']);
  assert.equal(logged.length, 1, 'the dropped ledger should be logged, not swallowed silently');
});

test('accountActivity filters to operations touching the address', async () => {
  const { notifier, push } = fakeNotifier();
  const { pool, calls } = fakePool(() => [opRow('op1')]);

  const stream = resolvers.accountActivity.subscribe(
    {},
    { address: 'GWATCHED' },
    { pool, notifier } as SubscriptionContext
  );
  push({ kind: 'ledger', ledger: 100 });

  await take(stream, 1);

  assert.deepEqual(calls[0]?.params, [100, 'GWATCHED', 'mainnet']);
  // Source-account alone would miss the case people care about most: being
  // paid. The counterparty fields live in the details JSONB.
  assert.match(calls[0]?.sql ?? '', /source_account = \$2/);
  assert.match(calls[0]?.sql ?? '', /details->>'from'\s*= \$2/);
  assert.match(calls[0]?.sql ?? '', /details->>'to'\s*= \$2/);
});

test('accountActivity yields nothing for a ledger that does not touch the address', async () => {
  const { notifier, push } = fakeNotifier();
  const { pool } = fakePool((_sql, params) =>
    params[1] === 'GWATCHED' && params[0] === 101 ? [opRow('op_theirs', 101)] : []
  );

  const stream = resolvers.accountActivity.subscribe(
    {},
    { address: 'GWATCHED' },
    { pool, notifier } as SubscriptionContext
  );
  push({ kind: 'ledger', ledger: 100 });
  push({ kind: 'ledger', ledger: 101 });

  const received = (await take(stream, 1)) as { id: string }[];

  assert.deepEqual(received.map(o => o.id), ['op_theirs']);
});

test('two subscribers to different addresses each get their own query', async () => {
  const a = fakeNotifier();
  const b = fakeNotifier();
  const { pool, calls } = fakePool(() => [opRow('op1')]);

  const streamA = resolvers.accountActivity.subscribe(
    {},
    { address: 'GALICE' },
    { pool, notifier: a.notifier } as SubscriptionContext
  );
  const streamB = resolvers.accountActivity.subscribe(
    {},
    { address: 'GBOB' },
    { pool, notifier: b.notifier } as SubscriptionContext
  );

  a.push({ kind: 'ledger', ledger: 100 });
  b.push({ kind: 'ledger', ledger: 100 });
  await take(streamA, 1);
  await take(streamB, 1);

  assert.deepEqual(
    calls.map(c => c.params[1]).sort(),
    ['GALICE', 'GBOB']
  );
});

test('a notification for another network is dropped before it is read', async () => {
  const { notifier, push } = fakeNotifier();
  const { pool, calls } = fakePool(() => [txRow('tx_testnet_only')]);

  const stream = resolvers.newTransaction.subscribe({}, {}, { pool, notifier } as SubscriptionContext);
  // Ledger 500 on testnet is a different ledger than 500 on the primary
  // network. Reading rows by sequence alone would return whichever network's
  // rows are in the table.
  push({ kind: 'ledger', ledger: 500, network: 'testnet' });

  assert.deepEqual(await take(stream, 0), []);
  assert.equal(calls.length, 0, 'another network\'s notification must not hit the database');
});

test('the stream ends when the notifier closes', async () => {
  const { notifier, finish } = fakeNotifier();
  const { pool } = fakePool(() => []);

  const stream = resolvers.newTransaction.subscribe({}, {}, { pool, notifier } as SubscriptionContext);
  finish();

  const received = [];
  for await (const value of stream) received.push(value);

  assert.deepEqual(received, []);
});

test('resolve passes the payload straight through', () => {
  // Without this, Apollo would look for a `newTransaction` key on each
  // Transaction object and push nulls.
  const tx = { hash: 'tx_a' };
  assert.equal(resolvers.newTransaction.resolve(tx), tx);
  assert.equal(resolvers.accountActivity.resolve(tx), tx);
});
