/**
 * Durable retry worker for failed ledgers.
 * 
 * Runs independently of the forward indexing loop, periodically checking
 * the retry queue and attempting to re-index failed ledgers. This ensures
 * failures are retried after process restarts and don't block forward progress.
 */

import type { Pool } from 'pg';
import { subsystem } from './logger';
import { getPendingRetries, removeLedgerFromRetryQueue } from './db';

const log = subsystem('retry-worker');

export interface RetryWorkerOptions {
  pool: Pool;
  network: string;
  indexOne: (sequence: number) => Promise<boolean>;
  pollIntervalMs?: number;
}

export class RetryWorker {
  private pool: Pool;
  private network: string;
  private indexOne: (sequence: number) => Promise<boolean>;
  private pollIntervalMs: number;
  private running = false;
  private stopped = false;

  constructor(options: RetryWorkerOptions) {
    this.pool = options.pool;
    this.network = options.network;
    this.indexOne = options.indexOne;
    this.pollIntervalMs = options.pollIntervalMs ?? 30000; // Default 30 seconds
  }

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

      // Wait before next cycle
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }

    this.running = false;
    log.info({ network: this.network }, 'retry worker stopped');
  }

  stop(): void {
    this.stopped = true;
  }

  private async processRetries(): Promise<void> {
    const pendingLedgers = await getPendingRetries(this.pool, this.network, 10);

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
          await removeLedgerFromRetryQueue(this.pool, this.network, ledger);
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
