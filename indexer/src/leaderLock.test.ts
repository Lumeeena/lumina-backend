import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaderLock, LEADER_LOCK_KEY, type LockConnection } from './leaderLock';

/**
 * A stand-in for a Postgres connection. `locked` is what `pg_try_advisory_lock`
 * returns on it, or an Error to throw from the query instead.
 */
class FakeConnection implements LockConnection {
  readonly queries: string[] = [];
  ended = false;
  private readonly listeners: Record<'error' | 'end', Array<(err?: Error) => void>> = {
    error: [],
    end: [],
  };

  constructor(private readonly locked: boolean | Error) {}

  async query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queries.push(text);
    if (this.locked instanceof Error) throw this.locked;
    return { rows: [{ locked: this.locked }] };
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  on(event: 'error' | 'end', listener: (err?: Error) => void): unknown {
    this.listeners[event].push(listener);
    return this;
  }

  emit(event: 'error' | 'end', err?: Error): void {
    for (const listener of this.listeners[event]) listener(err);
  }
}

/** Builds a lock whose successive connections come from `connections`. */
function lockWith(connections: FakeConnection[], overrides: {
  stopRequested?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  onLost?: (err?: Error) => void;
} = {}) {
  let next = 0;
  const sleeps: number[] = [];
  const lost: Array<Error | undefined> = [];
  const lock = new LeaderLock({
    databaseUrl: 'postgres://unused',
    retryIntervalMs: 5,
    connect: async () => {
      const connection = connections[next++];
      if (!connection) throw new Error('no connection scripted');
      return connection;
    },
    sleep: overrides.sleep ?? (async ms => {
      sleeps.push(ms);
    }),
    stopRequested: overrides.stopRequested,
    onLost: overrides.onLost ?? (err => lost.push(err)),
  });
  return { lock, sleeps, lost, connectCount: () => next };
}

test('acquires immediately when no other process holds the lock', async () => {
  const conn = new FakeConnection(true);
  const { lock, sleeps } = lockWith([conn]);

  assert.equal(await lock.acquire(), true);
  assert.equal(sleeps.length, 0);
  assert.equal(conn.ended, false, 'the connection must stay open to hold the session lock');
  assert.match(conn.queries[0] ?? '', /pg_try_advisory_lock/);
});

test('a standby waits, retrying, until the leader releases the lock', async () => {
  const conns = [new FakeConnection(false), new FakeConnection(false), new FakeConnection(true)];
  const { lock, sleeps } = lockWith(conns);

  assert.equal(await lock.acquire(), true);
  assert.deepEqual(sleeps, [5, 5]);
  assert.equal(conns[0].ended, true, 'a failed attempt closes its connection');
  assert.equal(conns[1].ended, true);
  assert.equal(conns[2].ended, false);
});

test('a standby stops waiting when shutdown is requested, without taking the lock', async () => {
  const conn = new FakeConnection(false);
  let stop = false;
  const { lock, connectCount } = lockWith([conn], {
    stopRequested: () => stop,
    sleep: async () => {
      stop = true;
    },
  });

  assert.equal(await lock.acquire(), false);
  assert.equal(connectCount(), 1);
  assert.equal(conn.ended, true);
});

test('shutdown requested before the first attempt means no connection is opened', async () => {
  const { lock, connectCount } = lockWith([], { stopRequested: () => true });

  assert.equal(await lock.acquire(), false);
  assert.equal(connectCount(), 0);
});

test('a failed attempt, such as a dropped connection, is retried rather than fatal', async () => {
  const conns = [new FakeConnection(new Error('connection terminated')), new FakeConnection(true)];
  const { lock } = lockWith(conns);

  assert.equal(await lock.acquire(), true);
  assert.equal(conns[0].ended, true);
});

test('losing the connection after acquiring calls onLost exactly once', async () => {
  const conn = new FakeConnection(true);
  const { lock, lost } = lockWith([conn]);
  await lock.acquire();

  conn.emit('error', new Error('server closed the connection'));
  conn.emit('end');

  assert.equal(lost.length, 1);
  assert.equal(lost[0]?.message, 'server closed the connection');
});

test('releasing the lock unlocks, closes, and does not report it as lost', async () => {
  const conn = new FakeConnection(true);
  const { lock, lost } = lockWith([conn]);
  await lock.acquire();

  await lock.release();
  conn.emit('end');

  assert.equal(conn.queries.at(-1), 'SELECT pg_advisory_unlock($1, $2)');
  assert.equal(conn.ended, true);
  assert.equal(lost.length, 0);
});

test('release is a no-op when nothing is held, and safe to call twice', async () => {
  const conn = new FakeConnection(true);
  const { lock } = lockWith([conn]);

  await lock.release();
  await lock.acquire();
  await lock.release();
  await lock.release();

  assert.equal(conn.queries.filter(q => q.includes('pg_advisory_unlock')).length, 1);
});

test('the lock key is fixed, so every indexer contends for the same lock', () => {
  assert.deepEqual([...LEADER_LOCK_KEY], [0x4c554d49, 1]);
});
