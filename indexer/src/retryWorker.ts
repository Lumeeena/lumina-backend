/**
 * Drains the durable ledger retry queue independently of the forward indexer.
 *
 * The forward loop records failures in PostgreSQL after its bounded inline
 * retries are exhausted. This worker picks those rows up on a later pass so a
 * transient Horizon or database outage does not permanently strand a ledger
 * or hold the forward cursor back. A successful retry removes the row; a
 * false result or thrown error leaves it available for a future poll.
 */

import { getPendingRetries, removeLedgerFromRetryQueue, type Pools } from './db';
import { subsystem } from './logger';

const log = subsystem('retry-worker');

export interface RetryWorkerOptions {
  /** Read and write pools: queue scans run on the read side, removals on the write side. */
  pools: Pools;
  /** Network name used to prevent retries crossing network boundaries. */
  network: string;
  /** Re-indexes one ledger and resolves `true` only when it is complete. */
  indexOne: (sequence: number) => Promise<boolean>;
  /** Delay between queue polls. Defaults to the 30-second production cadence. */
  pollIntervalMs?: number;
}

export class RetryWorker {
  private pools: Pools;
  private network: string;
  private indexOne: (sequence: number) => Promise<boolean>;
  private pollIntervalMs: number;
  private running = false;
  private stopped = false;

  constructor(options: RetryWorkerOptions) {
    this.pools = options.pools;
    this.network = options.network;
    this.indexOne = options.indexOne;
    // The production caller uses the same 30-second cadence explicitly. The
    // default keeps direct users of this worker on that operational policy.
    this.pollIntervalMs = options.pollIntervalMs ?? 30000;
  }

  /**
   * Start polling until {@link stop} is called.
   *
   * A failed poll is isolated to its cycle and does not terminate the worker;
   * the next poll can recover from a transient database failure. Calling
   * `start` while already running is a no-op.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;

    log.info({ network: this.network }, 'retry worker started');

    while (!this.stopped) {
      try {
        await this.processRetries();
      } catch (err) {
        log.error(
          { network: this.network, err: err instanceof Error ? err.message : String(err) },
          'retry worker cycle failed'
        );
      }

      // Wait before the next cycle. This also prevents a permanently empty
      // queue from turning into a tight database polling loop.
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }

    this.running = false;
    log.info({ network: this.network }, 'retry worker stopped');
  }

  /** Request a graceful stop after the current retry attempt finishes. */
  stop(): void {
    this.stopped = true;
  }

  /** Process at most ten due ledgers, preserving queue rows on failure. */
  private async processRetries(): Promise<void> {
    // Ten rows per pass bounds the work done by one cycle while allowing the
    // next poll to continue draining a larger backlog. Queue reads run on the
    // read pool: a backlog scan must not take a connection from the write
    // path, which is about to re-index these very ledgers.
    const pendingLedgers = await getPendingRetries(this.pools.read, this.network, 10);

    if (pendingLedgers.length === 0) return;

    log.info(
      { network: this.network, count: pendingLedgers.length, ledgers: pendingLedgers },
      'processing retry queue'
    );

    for (const ledger of pendingLedgers) {
      if (this.stopped) break;

      try {
        const success = await this.indexOne(ledger);
        if (success) {
          await removeLedgerFromRetryQueue(this.pools.write, this.network, ledger);
          log.info({ network: this.network, ledger }, 'retry succeeded; removed from queue');
        }
      } catch (err) {
        log.warn(
          { network: this.network, ledger, err: err instanceof Error ? err.message : String(err) },
          'retry attempt failed; will retry later'
        );
      }
    }
  }
}
