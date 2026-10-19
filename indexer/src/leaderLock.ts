/**
 * Single-writer guard for the indexer.
 *
 * The indexer assumes it is the only process advancing the cursors, and nothing
 * enforced that. Two replicas, or a rolling restart that briefly overlaps, both
 * walk the same ledgers: `ON CONFLICT DO NOTHING` keeps the rows from doubling,
 * but the Horizon traffic doubles, and the cursors fight.
 *
 * The guard is a session-level Postgres advisory lock held on a connection of
 * its own, outside the pool. The lock lasts as long as that connection, so:
 *
 * - A standby retries `pg_try_advisory_lock` and does no indexing meanwhile.
 * - A clean shutdown releases the lock explicitly.
 * - A crash releases it too: Postgres drops the session, and with it the lock.
 *   A host that dies without closing its socket keeps the lock until TCP
 *   keepalive gives up on it, which the keepalive settings below shorten.
 * - If the connection drops while this process is the leader, the lock is
 *   already gone, so `onLost` fires and the process must stop writing.
 *
 * The indexer is single-writer by design. Run one active replica per database;
 * extra replicas idle until the active one exits.
 */
import { Client } from 'pg';
import { subsystem } from './logger';

const log = subsystem('leader');

/**
 * The lock id, as the two int4 keys `pg_try_advisory_lock(int, int)` takes.
 * The first key is 'LUMI' in ASCII, so this lock is distinguishable from other
 * advisory locks in `pg_locks`; the second names the indexer's role.
 */
export const LEADER_LOCK_KEY: readonly [number, number] = [0x4c554d49, 1];

/** The part of a Postgres connection the lock uses. A fake in tests. */
export interface LockConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: (err?: Error) => void): unknown;
}

export interface LeaderLockOptions {
  databaseUrl: string;
  /** How long a standby waits between attempts. */
  retryIntervalMs: number;
  /** Called when the lock is lost after it was acquired. The caller must stop writing. */
  onLost: (err?: Error) => void;
  /** Opens the dedicated connection. Defaults to a `pg` client with TCP keepalive. */
  connect?: (databaseUrl: string) => Promise<LockConnection>;
  sleep?: (ms: number) => Promise<void>;
  /** Checked between attempts; once true, `acquire` gives up and returns false. */
  stopRequested?: () => boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function defaultConnect(databaseUrl: string): Promise<LockConnection> {
  const client = new Client({
    connectionString: databaseUrl,
    // Visible in pg_stat_activity, so an operator can see which process leads.
    application_name: 'lumina-indexer-leader',
    // A peer that vanishes without a FIN holds the lock until the socket is
    // declared dead. Probing from 10 s after idle, rather than the OS default
    // of hours, makes that the probe schedule's problem, not a long wait.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  await client.connect();
  // `pg.Client` has more overloads than this interface names; it satisfies the
  // parts the lock calls, so the cast only narrows what is visible here.
  return client as unknown as LockConnection;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class LeaderLock {
  private connection: LockConnection | null = null;
  private held = false;

  constructor(private readonly options: LeaderLockOptions) {}

  /**
   * Waits until this process holds the lock. Returns `true` once it does, or
   * `false` if `stopRequested` turns true first, in which case nothing is held.
   */
  async acquire(): Promise<boolean> {
    const {
      retryIntervalMs,
      stopRequested = () => false,
      sleep = defaultSleep,
    } = this.options;
    let announcedStandby = false;

    while (!stopRequested()) {
      if (await this.tryOnce()) {
        log.info({ key: LEADER_LOCK_KEY }, 'acquired leader lock; this process will index');
        return true;
      }
      if (!announcedStandby) {
        log.info({ retryIntervalMs }, 'another indexer holds the leader lock; waiting as standby');
        announcedStandby = true;
      }
      await sleep(retryIntervalMs);
    }
    return false;
  }

  /**
   * Releases the lock and closes its connection. Safe to call when nothing is
   * held, and idempotent.
   */
  async release(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;

    // Cleared first so the 'end' event from closing the connection is not
    // mistaken for losing a lock this process still believes it holds.
    this.held = false;
    try {
      await connection.query('SELECT pg_advisory_unlock($1, $2)', [...LEADER_LOCK_KEY]);
    } catch (err) {
      // Closing the connection releases a session lock anyway, so a failed
      // unlock is logged and not rethrown.
      log.warn({ err: message(err) }, 'explicit unlock failed; closing the connection releases the lock');
    }
    await connection.end().catch(() => undefined);
    log.info('released leader lock');
  }

  /** One attempt on a fresh connection. A failed attempt closes its connection. */
  private async tryOnce(): Promise<boolean> {
    let connection: LockConnection | null = null;
    try {
      connection = await (this.options.connect ?? defaultConnect)(this.options.databaseUrl);
      // Attached before any query: an idle client that errors with no listener
      // takes the process down. `lost` ignores this while nothing is held.
      connection.on('error', err => this.lost(err));
      connection.on('end', () => this.lost());
      const { rows } = await connection.query(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [...LEADER_LOCK_KEY]
      );
      if (rows[0]?.locked === true) {
        this.connection = connection;
        this.held = true;
        return true;
      }
      await connection.end().catch(() => undefined);
      return false;
    } catch (err) {
      log.warn({ err: message(err) }, 'leader lock attempt failed; will retry');
      await connection?.end().catch(() => undefined);
      return false;
    }
  }

  private lost(err?: Error): void {
    if (!this.held) return;
    this.held = false;
    this.connection = null;
    log.fatal({ err: err ? message(err) : undefined }, 'leader lock lost; stopping so no second writer runs');
    this.options.onLost(err);
  }
}
