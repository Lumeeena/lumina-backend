/**
 * Lumina Indexer Benchmark Harness
 *
 * Measures how fast the indexer can fetch and index a fixed range of ledgers,
 * so changes to batching, pacing or retry behaviour can be compared against a
 * number rather than a feeling.
 *
 * Usage (HORIZON_URL / DATABASE_URL etc. must be set as for the indexer):
 *   ts-node indexer/src/benchmark.ts <startLedger> <endLedger>
 *
 * Ledgers are indexed sequentially, in backfill mode, through the same
 * retry-wrapped path the main loop uses. Sequential on purpose: the result is
 * then a per-ledger latency figure that is not confounded by concurrency.
 *
 * This is a standalone harness. It does not start the indexer loop or its
 * health/metrics servers, and it writes to the configured database, so do not
 * point it at production data you are not prepared to re-index.
 */

import { performance } from 'perf_hooks';
import { createBenchmarkIndexer } from './index';
import { subsystem } from './logger';

const log = subsystem('benchmark');

/** Outcome of one benchmark run. */
export interface BenchmarkResult {
  /** Ledgers that were indexed successfully. */
  indexedCount: number;
  /** Ledgers that failed after exhausting retries (or whose indexer threw). */
  errorCount: number;
  durationMs: number;
  /** Successful ledgers per second; 0 when no time elapsed. */
  ledgersPerSecond: number;
}

/**
 * Parses `<startLedger> <endLedger>` from argv-style arguments.
 *
 * Returns `null` for anything unusable: missing or non-numeric values, or a
 * start after the end. The range is inclusive, so start === end is valid.
 */
export function parseBenchmarkArgs(args: string[]): { start: number; end: number } | null {
  const start = parseInt(args[0], 10);
  const end = parseInt(args[1], 10);
  if (isNaN(start) || isNaN(end) || start > end) return null;
  return { start, end };
}

/**
 * Indexes every ledger in `[startLedger, endLedger]` in order and reports
 * timing.
 *
 * `indexOne` follows the indexer's contract: it resolves `false` when a ledger
 * was given up on after retries (it does not throw), so `false` and a thrown
 * error both count as failures. A failed ledger never aborts the run.
 * `ledgersPerSecond` only counts successes, so failures lower throughput
 * rather than inflating it.
 */
export async function runBenchmark(
  startLedger: number,
  endLedger: number,
  indexOne: (sequence: number) => Promise<boolean>,
  now: () => number = () => performance.now()
): Promise<BenchmarkResult> {
  let indexedCount = 0;
  let errorCount = 0;
  const startTime = now();

  for (let sequence = startLedger; sequence <= endLedger; sequence++) {
    try {
      if (await indexOne(sequence)) {
        indexedCount++;
        log.debug({ ledger: sequence }, 'Indexed ledger');
      } else {
        errorCount++;
        log.error({ ledger: sequence }, 'Failed to index ledger after retries');
      }
    } catch (err) {
      errorCount++;
      log.error({ ledger: sequence, err: err instanceof Error ? err.message : String(err) }, 'Failed to index ledger');
    }
  }

  const durationMs = now() - startTime;
  const ledgersPerSecond = durationMs > 0 ? indexedCount / (durationMs / 1000) : 0;
  return { indexedCount, errorCount, durationMs, ledgersPerSecond };
}

async function main(): Promise<void> {
  const range = parseBenchmarkArgs(process.argv.slice(2));
  if (!range) {
    console.error('Usage: ts-node indexer/src/benchmark.ts <startLedger> <endLedger>');
    process.exit(1);
  }

  const indexer = createBenchmarkIndexer();
  log.info(
    { startLedger: range.start, endLedger: range.end, horizon: indexer.horizonUrl, database: indexer.databaseUrl },
    'Starting indexer benchmark'
  );

  try {
    const result = await runBenchmark(range.start, range.end, indexer.indexOne);
    log.info(
      {
        indexedCount: result.indexedCount,
        errorCount: result.errorCount,
        durationMs: result.durationMs.toFixed(2),
        ledgersPerSecond: result.ledgersPerSecond.toFixed(2),
        startLedger: range.start,
        endLedger: range.end,
      },
      'Benchmark complete'
    );
  } finally {
    await Promise.all([indexer.pools.write.end(), indexer.pools.read.end()]);
  }
}

if (require.main === module) {
  main().catch(err => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'Benchmark failed fatally');
    process.exit(1);
  });
}
