/**
 * Lumina Indexer Benchmark Harness
 *
 * This harness provides a basic way to benchmark the indexer's performance
 * over a specified range of ledgers. It measures the time taken to fetch
 * and index ledgers.
 *
 * To run this benchmark, you would typically:
 * 1. Ensure the indexer's environment variables (e.g., HORIZON_URL, DATABASE_URL) are set.
 * 2. Execute this script with a tool like `ts-node` or compile it and run with `node`.
 *    e.g., `ts-node indexer/src/benchmark.ts <startLedger> <endLedger>`
 *
 * This is a standalone harness and does not integrate with the main indexer loop
 * or its health/metrics servers.
 */

import { performance } from 'perf_hooks';
import { createPool } from 'pg';
import {
  DATABASE_URL,
  HORIZON_URL,
  fetchAndIndexLedgerWithRetry,
  log as indexerLog, // Renaming to avoid conflict with local log
  message,
  redactUrl,
  pool as indexerPool, // Renaming to avoid conflict with local pool
} from './index'; // Importing necessary functions and constants from index.ts
import { subsystem } from './logger';

const log = subsystem('benchmark');

async function runBenchmark(startLedger: number, endLedger: number) {
  log.info({
    startLedger,
    endLedger,
    horizon: HORIZON_URL,
    database: redactUrl(DATABASE_URL),
  }, 'Starting indexer benchmark');

  const pool = indexerPool; // Use the existing pool from index.ts

  let indexedCount = 0;
  let errorCount = 0;
  const startTime = performance.now();

  for (let sequence = startLedger; sequence <= endLedger; sequence++) {
    try {
      await fetchAndIndexLedgerWithRetry(sequence);
      indexedCount++;
      log.debug({ ledger: sequence }, 'Indexed ledger');
    } catch (err) {
      errorCount++;
      log.error({ ledger: sequence, err: message(err) }, 'Failed to index ledger');
    }
  }

  const endTime = performance.now();
  const durationMs = endTime - startTime;
  const ledgersPerSecond = indexedCount / (durationMs / 1000);

  log.info({
    indexedCount,
    errorCount,
    durationMs: durationMs.toFixed(2),
    ledgersPerSecond: ledgersPerSecond.toFixed(2),
    startLedger,
    endLedger,
  }, 'Benchmark complete');

  await pool.end(); // Close the pool after benchmark
}

// Command-line argument parsing
const args = process.argv.slice(2);
const start = parseInt(args[0], 10);
const end = parseInt(args[1], 10);

if (isNaN(start) || isNaN(end) || start > end) {
  console.error('Usage: ts-node indexer/src/benchmark.ts <startLedger> <endLedger>');
  process.exit(1);
}

runBenchmark(start, end).catch(err => {
  log.fatal({ err: message(err) }, 'Benchmark failed fatally');
  process.exit(1);
});
