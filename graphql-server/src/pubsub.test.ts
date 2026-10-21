import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEXED_CHANNEL, type IndexedNotification } from './notifications';
import { LedgerNotifier, SubscriberLimitError, type ListenClient } from './pubsub';

type Handlers = {
  notification?: (msg: { channel: string; payload?: string }) => void;
  error?: (err: Error) => void;
  end?: () => void;
};

/** A `pg.Client` stand-in whose lifecycle the test drives by hand. */
class FakeClient implements ListenClient {
  handlers: Handlers = {};
  queries: string[] = [];
  connected = false;
  ended = false;
  connectError: Error | null = null;

  constructor(readonly id: number) {}

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  async query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    return { rows: [] };
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  // Mirrors `ListenClient`'s overloads, so the fake is checked against the same
  // contract the real `pg.Client` satisfies.
  on(event: 'notification', handler: (msg: { channel: string; payload?: string }) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'end', handler: () => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    (this.handlers as Record<string, unknown>)[event] = handler;
  }

  /** Deliver a raw NOTIFY as Postgres would. */
  emit(payload: string, channel = INDEXED_CHANNEL): void {
    this.handlers.notification?.({ channel, payload });
  }
}

interface Harness {
  notifier: LedgerNotifier;
  clients: FakeClient[];
  /** Run every reconnect timer that has been scheduled but not yet fired. */
  runScheduled: () => Promise<void>;
}

function harness(options: Partial<ConstructorParameters<typeof LedgerNotifier>[0]> = {}): Harness {
  const clients: FakeClient[] = [];
  let pending: (() => void)[] = [];

  const notifier = new LedgerNotifier({
    connectionString: 'postgresql://test/lumina',
    createClient: () => {
      const client = new FakeClient(clients.length);
      clients.push(client);
      return client;
    },
    schedule: fn => {
      pending.push(fn);
    },
    ...options,
  });

  return {
    notifier,
    clients,
    runScheduled: async () => {
      const due = pending;
      pending = [];
      for (const fn of due) fn();
      // Let the async connect() settle.
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

const ledgerPayload = (ledger: number, transactions = 1) =>
  JSON.stringify({ kind: 'ledger', ledger, transactions });

test('start opens a connection and issues LISTEN on the agreed channel', async () => {
  const { notifier, clients } = harness();

  await notifier.start();

  assert.equal(clients.length, 1);
  assert.equal(clients[0].connected, true);
  assert.deepEqual(clients[0].queries, [`LISTEN ${INDEXED_CHANNEL}`]);
  assert.equal(notifier.connected, true);

  await notifier.stop();
});

test('a notification reaches every open subscriber', async () => {
  const { notifier, clients } = harness();
  await notifier.start();

  const a = notifier.subscribe();
  const b = notifier.subscribe();
  const nextA = a.next();
  const nextB = b.next();

  clients[0].emit(ledgerPayload(100));

  assert.equal((await nextA).value?.ledger, 100);
  assert.equal((await nextB).value?.ledger, 100);

  await notifier.stop();
});

test('notification listeners receive events without consuming subscription slots', async () => {
  const { notifier, clients } = harness({ maxSubscribers: 1 });
  const received: IndexedNotification[] = [];
  const unsubscribe = notifier.onNotification(notification => received.push(notification));
  await notifier.start();

  const sub = notifier.subscribe();
  clients[0].emit(ledgerPayload(101));

  assert.equal(notifier.subscriberCount, 1);
  assert.deepEqual(received, [{ kind: 'ledger', ledger: 101, network: undefined, transactions: 1, operations: undefined, events: undefined }]);
  assert.equal((await sub.next()).value?.ledger, 101);

  unsubscribe();
  clients[0].emit(ledgerPayload(102));
  assert.equal(received.length, 1);
  await notifier.stop();
});

test('notifications on another channel are ignored', async () => {
  const { notifier, clients } = harness();
  await notifier.start();

  const sub = notifier.subscribe();
  clients[0].emit(ledgerPayload(1), 'some_other_channel');
  clients[0].emit(ledgerPayload(2));

  assert.equal((await sub.next()).value?.ledger, 2);

  await notifier.stop();
});

test('a malformed payload is dropped without disturbing the stream', async () => {
  const { notifier, clients } = harness();
  await notifier.start();

  const sub = notifier.subscribe();
  // If this threw, it would propagate out of pg's notification handler and
  // take down the connection every subscriber shares.
  clients[0].emit('}{ not json');
  clients[0].emit(ledgerPayload(55));

  assert.equal((await sub.next()).value?.ledger, 55);
  assert.equal(notifier.connected, true);

  await notifier.stop();
});

test('notifications buffered before a read are delivered in order', async () => {
  const { notifier, clients } = harness();
  await notifier.start();

  const sub = notifier.subscribe();
  clients[0].emit(ledgerPayload(1));
  clients[0].emit(ledgerPayload(2));
  clients[0].emit(ledgerPayload(3));

  assert.equal((await sub.next()).value?.ledger, 1);
  assert.equal((await sub.next()).value?.ledger, 2);
  assert.equal((await sub.next()).value?.ledger, 3);

  await notifier.stop();
});

test('a stalled subscriber drops its oldest notifications rather than growing without bound', async () => {
  const { notifier, clients } = harness({ queueLimit: 3 });
  await notifier.start();

  const sub = notifier.subscribe();
  for (let ledger = 1; ledger <= 10; ledger++) {
    clients[0].emit(ledgerPayload(ledger));
  }

  // The buffer holds the three newest, not the three oldest: on a live feed a
  // client catching up wants the head, not a replay it no longer cares about.
  assert.equal(sub.droppedCount(), 7);
  assert.equal((await sub.next()).value?.ledger, 8);
  assert.equal((await sub.next()).value?.ledger, 9);
  assert.equal((await sub.next()).value?.ledger, 10);

  await notifier.stop();
});

test('one stalled subscriber does not cost a healthy one any notifications', async () => {
  const { notifier, clients } = harness({ queueLimit: 2 });
  await notifier.start();

  const stalled = notifier.subscribe();
  const healthy = notifier.subscribe();

  for (let ledger = 1; ledger <= 5; ledger++) {
    clients[0].emit(ledgerPayload(ledger));
    // The healthy one keeps up, so it is parked on `next()` each time.
    assert.equal((await healthy.next()).value?.ledger, ledger);
  }

  assert.equal(healthy.droppedCount(), 0);
  assert.equal(stalled.droppedCount(), 3);

  await notifier.stop();
});

test('subscriptions are refused once the cap is reached', async () => {
  const { notifier } = harness({ maxSubscribers: 2 });
  await notifier.start();

  const a = notifier.subscribe();
  notifier.subscribe();

  assert.throws(() => notifier.subscribe(), SubscriberLimitError);
  assert.equal(notifier.subscriberCount, 2);

  // Closing one frees a slot, so the cap is a ceiling rather than a lifetime
  // budget.
  await a.return?.();
  assert.equal(notifier.subscriberCount, 1);
  assert.doesNotThrow(() => notifier.subscribe());

  await notifier.stop();
});

test('closing a subscription releases its slot and ends the iterator', async () => {
  const { notifier } = harness();
  await notifier.start();

  const sub = notifier.subscribe();
  assert.equal(notifier.subscriberCount, 1);

  // A consumer parked on next() has to be woken, or `for await` hangs forever.
  const parked = sub.next();
  await sub.return?.();

  assert.equal((await parked).done, true);
  assert.equal((await sub.next()).done, true);
  assert.equal(notifier.subscriberCount, 0);

  await notifier.stop();
});

test('the listener reconnects after the connection errors', async () => {
  const { notifier, clients, runScheduled } = harness();
  await notifier.start();

  const sub = notifier.subscribe();

  // The indexer restarting, a failover, an idle reaper — all arrive here.
  clients[0].handlers.error?.(new Error('connection terminated unexpectedly'));
  assert.equal(notifier.connected, false);

  await runScheduled();

  assert.equal(clients.length, 2, 'a fresh client should have been created');
  assert.deepEqual(clients[1].queries, [`LISTEN ${INDEXED_CHANNEL}`], 'LISTEN must be re-issued');
  assert.equal(notifier.connected, true);

  // And the existing subscription keeps working across the reconnect.
  const next = sub.next();
  clients[1].emit(ledgerPayload(200));
  assert.equal((await next).value?.ledger, 200);

  await notifier.stop();
});

test('a clean server-side close reconnects too', async () => {
  const { notifier, clients, runScheduled } = harness();
  await notifier.start();

  clients[0].handlers.end?.();
  await runScheduled();

  assert.equal(clients.length, 2);
  assert.equal(notifier.connected, true);

  await notifier.stop();
});

test('a failed reconnect backs off and keeps retrying', async () => {
  const delays: number[] = [];
  const clients: FakeClient[] = [];
  let pending: (() => void)[] = [];

  const notifier = new LedgerNotifier({
    connectionString: 'postgresql://test/lumina',
    reconnectDelayMs: 100,
    maxReconnectDelayMs: 400,
    createClient: () => {
      const client = new FakeClient(clients.length);
      // Every attempt fails until the test says otherwise.
      client.connectError = new Error('ECONNREFUSED');
      clients.push(client);
      return client;
    },
    schedule: (fn, ms) => {
      delays.push(ms);
      pending.push(fn);
    },
  });

  await notifier.start();
  for (let i = 0; i < 4; i++) {
    const due = pending;
    pending = [];
    for (const fn of due) fn();
    await new Promise(resolve => setImmediate(resolve));
  }

  // Exponential, then flat at the ceiling — so a long outage does not turn into
  // a reconnect storm.
  assert.deepEqual(delays, [100, 200, 400, 400, 400]);
  assert.equal(notifier.connected, false);

  await notifier.stop();
});

test('stop closes the connection and ends every subscription', async () => {
  const { notifier, clients } = harness();
  await notifier.start();

  const sub = notifier.subscribe();
  const parked = sub.next();

  await notifier.stop();

  assert.equal((await parked).done, true);
  assert.equal(clients[0].ended, true);
  assert.equal(notifier.subscriberCount, 0);
});

test('stop prevents any further reconnection', async () => {
  const { notifier, clients, runScheduled } = harness();
  await notifier.start();

  await notifier.stop();
  clients[0].handlers.error?.(new Error('late failure after shutdown'));
  await runScheduled();

  assert.equal(clients.length, 1, 'no client should be created after stop');
});

test('publish is a no-op with no subscribers', async () => {
  const { notifier, clients } = harness();
  await notifier.start();

  assert.doesNotThrow(() => clients[0].emit(ledgerPayload(1)));

  const sub = notifier.subscribe();
  const next = sub.next();
  clients[0].emit(ledgerPayload(2));

  const result: IteratorResult<IndexedNotification> = await next;
  assert.equal(result.value?.ledger, 2);

  await notifier.stop();
});

// ── Connection lifecycle (regression: leaked listeners) ────────────────────

test('a dying client firing both error and end reconnects exactly once', async () => {
  // The bug this pins: `pg.Client` emits *both* events when a connection dies.
  // A null-tolerant identity guard let the second one through, scheduling a
  // second reconnect. Two timers built two connections, the later overwrote
  // the former, and the former stayed open forever — one leaked Postgres
  // connection per reconnect, until `max_connections` ran out.
  const { notifier, clients, runScheduled } = harness();
  await notifier.start();

  clients[0].handlers.error?.(new Error('connection terminated unexpectedly'));
  clients[0].handlers.end?.();

  await runScheduled();
  await runScheduled();

  assert.equal(clients.length, 2, 'error + end must produce one replacement, not two');
  assert.equal(notifier.connected, true);

  await notifier.stop();
  assert.deepEqual(
    clients.map(c => c.ended),
    [true, true],
    'both the dead original and its replacement are closed'
  );
});

test('every client the notifier opens is closed by the time it stops', async () => {
  // The invariant the CI hang exposed: a single unclosed client keeps the
  // Node event loop alive, so `node --test` finishes its tests and then never
  // exits.
  const { notifier, clients, runScheduled } = harness();
  await notifier.start();

  for (let i = 0; i < 3; i++) {
    clients[clients.length - 1].handlers.error?.(new Error('dropped'));
    clients[clients.length - 1].handlers.end?.();
    await runScheduled();
  }

  await notifier.stop();

  const stillOpen = clients.filter(c => c.connected && !c.ended);
  assert.deepEqual(stillOpen, [], `${stillOpen.length} client(s) left open`);
});

test('a client whose connect() throws is closed rather than left half-open', async () => {
  const clients: FakeClient[] = [];
  let pending: (() => void)[] = [];
  let failNext = true;

  const notifier = new LedgerNotifier({
    connectionString: 'postgresql://test/lumina',
    createClient: () => {
      const client = new FakeClient(clients.length);
      if (failNext) client.connectError = new Error('ECONNREFUSED');
      clients.push(client);
      return client;
    },
    schedule: fn => {
      pending.push(fn);
    },
  });

  await notifier.start();
  assert.equal(clients[0].ended, true, 'the failed client must not keep its socket');

  failNext = false;
  const due = pending;
  pending = [];
  for (const fn of due) fn();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(notifier.connected, true);
  await notifier.stop();
});

test('a reconnect that lands after stop closes itself instead of lingering', async () => {
  const { notifier, clients, runScheduled } = harness();
  await notifier.start();

  clients[0].handlers.error?.(new Error('dropped'));
  // Shut down while the reconnect timer is still pending, then let it fire.
  await notifier.stop();
  await runScheduled();

  const stillOpen = clients.filter(c => c.connected && !c.ended);
  assert.deepEqual(stillOpen, [], 'a late reconnect must not outlive stop()');
});
