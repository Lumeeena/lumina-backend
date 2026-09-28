/**
 * Integration tests for the real LISTEN/NOTIFY path.
 *
 * The unit tests in `pubsub.test.ts` drive a fake client, which proves the
 * fan-out, backpressure and reconnect *logic* but says nothing about whether
 * `pg` actually delivers a notification, or whether a killed backend really
 * surfaces as the `error`/`end` events the supervisor relies on. Those are
 * precisely the assumptions most likely to be wrong, so they are checked here
 * against a live Postgres.
 *
 * Skipped unless `TEST_DATABASE_URL` is set, so `npm test` still runs anywhere.
 * CI sets it against the same Postgres service `db-lint` already uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { INDEXED_CHANNEL } from './notifications';
import { LedgerNotifier } from './pubsub';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const skip = DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

/**
 * A live-database test that stops making progress should fail with a name
 * attached, not stall the whole run. The job also carries its own
 * `timeout-minutes` as a second line of defence.
 */
const TEST_TIMEOUT_MS = 30_000;

/** Resolve the next notification, or reject if none arrives in time. */
async function nextWithin<T>(stream: AsyncIterableIterator<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no notification within ${ms}ms`)), ms);
  });
  try {
    const result = await Promise.race([stream.next(), timeout]);
    assert.equal(result.done, false, 'stream ended instead of yielding');
    return result.value as T;
  } finally {
    clearTimeout(timer!);
  }
}

async function withNotifier(
  run: (notifier: LedgerNotifier, sender: Client) => Promise<void>,
  options: Partial<ConstructorParameters<typeof LedgerNotifier>[0]> = {}
) {
  const notifier = new LedgerNotifier({ connectionString: DATABASE_URL!, ...options });
  const sender = new Client({ connectionString: DATABASE_URL });
  await sender.connect();
  await notifier.start();
  try {
    await run(notifier, sender);
  } finally {
    await notifier.stop();
    await sender.end();
  }
}

test('a real NOTIFY reaches a subscriber', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  await withNotifier(async (notifier, sender) => {
    const sub = notifier.subscribe();

    await sender.query('SELECT pg_notify($1, $2)', [
      INDEXED_CHANNEL,
      JSON.stringify({ kind: 'ledger', ledger: 4242, transactions: 3 }),
    ]);

    const received = await nextWithin(sub, 5000);
    assert.equal(received.ledger, 4242);
    assert.equal(received.transactions, 3);
    assert.equal(received.kind, 'ledger');
  });
});

test('a notification only arrives once its transaction commits', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  // This is the property that makes queueing the NOTIFY inside `indexLedger`'s
  // transaction correct: a rolled-back ledger must announce nothing.
  await withNotifier(async (notifier, sender) => {
    const sub = notifier.subscribe();

    await sender.query('BEGIN');
    await sender.query('SELECT pg_notify($1, $2)', [
      INDEXED_CHANNEL,
      JSON.stringify({ kind: 'ledger', ledger: 999 }),
    ]);
    await sender.query('ROLLBACK');

    // Then a committed one, to prove the listener is healthy and it was the
    // rollback — not a dead connection — that produced silence.
    await sender.query('SELECT pg_notify($1, $2)', [
      INDEXED_CHANNEL,
      JSON.stringify({ kind: 'ledger', ledger: 1000 }),
    ]);

    const received = await nextWithin(sub, 5000);
    assert.equal(received.ledger, 1000, 'the rolled-back notification must never be delivered');
  });
});

test('the listener recovers when its backend is terminated', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  // Unique per run: the other integration files share this database and
  // `test:integration` runs them concurrently, so a kill scoped only to
  // "some backend is LISTENing" would take out a neighbour's connection too.
  const applicationName = 'lumina-test-listener-recovery';

  /** Backends of *this* notifier that are connected and waiting on a channel. */
  const listeningBackends = async (sender: Client) => {
    const { rows } = await sender.query(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE application_name = $1 AND state = 'idle' AND query LIKE 'LISTEN%'`,
      [applicationName]
    );
    return rows[0].n as number;
  };

  await withNotifier(
    async (notifier, sender) => {
      const sub = notifier.subscribe();
      assert.equal(await listeningBackends(sender), 1, 'the notifier should hold one listening backend to begin with');

      // Kill exactly the listener's backend, the way a failover or an idle
      // reaper would. Everything else in the pool is left alone.
      const killed = await sender.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE application_name = $1 AND pid <> pg_backend_pid()`,
        [applicationName]
      );
      assert.equal(killed.rowCount, 1, 'the listener backend should have been terminated');

      // Wait for the channel to be re-issued, not merely for a client object to
      // exist: `connected` is true while a fresh socket is still mid-handshake,
      // and a NOTIFY sent into that gap is lost for good.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (notifier.connected && (await listeningBackends(sender)) === 1) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(notifier.connected, true, 'notifier should have reconnected');
      assert.equal(await listeningBackends(sender), 1, 'LISTEN should have been re-issued on the new connection');

      await sender.query('SELECT pg_notify($1, $2)', [
        INDEXED_CHANNEL,
        JSON.stringify({ kind: 'ledger', ledger: 7777 }),
      ]);

      // The pre-existing subscription has to survive the reconnect, not just
      // the connection.
      const received = await nextWithin(sub, 5000);
      assert.equal(received.ledger, 7777);
    },
    { reconnectDelayMs: 100, applicationName }
  );
});

test('a malformed real notification does not kill the connection', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  await withNotifier(async (notifier, sender) => {
    const sub = notifier.subscribe();

    await sender.query('SELECT pg_notify($1, $2)', [INDEXED_CHANNEL, 'this is not json']);
    await sender.query('SELECT pg_notify($1, $2)', [
      INDEXED_CHANNEL,
      JSON.stringify({ kind: 'ledger', ledger: 31337 }),
    ]);

    const received = await nextWithin(sub, 5000);
    assert.equal(received.ledger, 31337);
    assert.equal(notifier.connected, true);
  });
});

test('every subscriber receives the same real notification', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  await withNotifier(async (notifier, sender) => {
    const subs = [notifier.subscribe(), notifier.subscribe(), notifier.subscribe()];

    await sender.query('SELECT pg_notify($1, $2)', [
      INDEXED_CHANNEL,
      JSON.stringify({ kind: 'ledger', ledger: 555 }),
    ]);

    for (const sub of subs) {
      assert.equal((await nextWithin(sub, 5000)).ledger, 555);
    }
  });
});
