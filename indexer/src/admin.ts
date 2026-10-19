#!/usr/bin/env node
/**
 * Admin CLI for ledger reindexing and state inspection.
 *
 * Provides safe, auditable commands for:
 * - Reindexing a ledger range
 * - Resetting indexing cursors
 * - Inspecting indexing state
 *
 * Destructive operations require explicit confirmation (--force).
 * Every invocation is logged to a dedicated admin_operations table.
 *
 * Usage:
 *   admin [--network <name>] reindex   <start-ledger> <end-ledger> [--force]
 *   admin [--network <name>] reset-cursor <ledger> [--force]
 *   admin [--network <name>] show-state
 *   admin [--network <name>] show-gaps
 *
 * Reads DATABASE_URL from the environment.
 */
import { Pool } from 'pg';
import { createPool, getLatestIndexedLedger, getEarliestIndexedLedger, findLedgerGaps, countLedgerGaps, indexLedger } from './db';
import { getLedger, getLedgerTransactions, getLedgerOperations } from './horizon';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/lumina';

function usage(): never {
  console.error(
    [
      'Usage:',
      '  admin [--network <name>] reindex       <start-ledger> <end-ledger> [--force]',
      '  admin [--network <name>] reset-cursor  <ledger> [--force]',
      '  admin [--network <name>] show-state',
      '  admin [--network <name>] show-gaps',
      '',
      'Commands:',
      '  reindex      Re-index a range of ledgers (deletes existing data in range)',
      '  reset-cursor Reset the indexing cursor to a specific ledger',
      '  show-state   Display current indexing state (earliest, latest, gap count)',
      '  show-gaps    List missing ledger sequences',
      '',
      'Flags:',
      '  --network    Network to operate on (default: mainnet)',
      '  --force      Skip confirmation for destructive operations',
    ].join('\n')
  );
  process.exit(1);
}

/** Pull `--network <name>` and `--force` out of the arguments. */
function parseFlags(args: string[]): { network: string; force: boolean; rest: string[] } {
  const rest: string[] = [];
  let network = process.env['NETWORK'] ?? 'mainnet';
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--network') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('--network needs a value');
        process.exit(1);
      }
      network = value;
      i++;
      continue;
    }
    if (arg?.startsWith('--network=')) {
      network = arg.slice('--network='.length);
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg !== undefined) rest.push(arg);
  }
  return { network, force, rest };
}

/** Log every admin operation to the database for audit trail. */
async function logAdminOperation(
  pool: Pool,
  network: string,
  command: string,
  args: string[],
  success: boolean,
  details?: string
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO admin_operations (network, command, arguments, success, details, executed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [network, command, JSON.stringify(args), success, details ?? null]
    );
  } catch (err) {
    // Logging failure should not prevent the operation from completing
    console.error('Failed to log admin operation:', err instanceof Error ? err.message : err);
  }
}



/** Confirm destructive operation unless --force is set. */
async function confirmDestructive(force: boolean, operation: string): Promise<boolean> {
  if (force) return true;
  console.error(`\n${operation} is destructive.`);
  console.error('This will delete existing indexed data.');
  process.stderr.write('Type "yes" to confirm: ');
  const input = await new Promise<string>(resolve => {
    process.stdin.once('data', data => resolve(data.toString().trim()));
  });
  return input.toLowerCase() === 'yes';
}

async function main(): Promise<void> {
  const { network, force, rest } = parseFlags(process.argv.slice(2));
  const [command, ...args] = rest;
  if (!command) usage();

  const pool = createPool(DATABASE_URL);

  let success = false;
  let details: string | undefined;

  try {
    switch (command) {
      case 'reindex': {
        if (args.length < 2) usage();
        const startLedger = parseInt(args[0], 10);
        const endLedger = parseInt(args[1], 10);

        if (isNaN(startLedger) || isNaN(endLedger) || startLedger < 1 || endLedger < startLedger) {
          console.error('Invalid ledger range: must be positive integers with end >= start');
          process.exit(1);
        }

        if (!(await confirmDestructive(force, `Reindexing ledgers ${startLedger}-${endLedger}`))) {
          console.log('Operation cancelled');
          process.exit(0);
        }

        console.log(`Reindexing ledgers ${startLedger}-${endLedger} on ${network}...`);
        
        const horizonUrl = process.env[`${network.toUpperCase()}_HORIZON_URL`] ?? process.env['HORIZON_URL'] ?? 'https://horizon.stellar.org';
        
        let reindexed = 0;
        let skipped = 0;
        for (let seq = startLedger; seq <= endLedger; seq++) {
          try {
            const ledger = await getLedger(horizonUrl, seq, 'backfill');
            const transactions = await getLedgerTransactions(horizonUrl, seq, 'backfill');
            const operations = await getLedgerOperations(horizonUrl, seq, 'backfill');

            // Re-index (ON CONFLICT DO NOTHING handles duplicates)
            await indexLedger(pool, network, ledger, transactions, operations, []);
            reindexed++;
            if (reindexed % 10 === 0) {
              console.log(`Progress: ${reindexed}/${endLedger - startLedger + 1} ledgers`);
            }
          } catch (err) {
            console.warn(`Failed to reindex ledger ${seq}: ${err instanceof Error ? err.message : err}`);
            skipped++;
          }
        }

        console.log(`Reindex complete: ${reindexed} succeeded, ${skipped} skipped`);
        details = `Reindexed ${reindexed} ledgers, ${skipped} failed`;
        success = true;
        break;
      }

      case 'reset-cursor': {
        if (args.length < 1) usage();
        const ledger = parseInt(args[0], 10);

        if (isNaN(ledger) || ledger < 1) {
          console.error('Invalid ledger: must be a positive integer');
          process.exit(1);
        }

        if (!(await confirmDestructive(force, `Resetting cursor to ledger ${ledger}`))) {
          console.log('Operation cancelled');
          process.exit(0);
        }

        // Delete ledgers >= the cursor reset point
        const result = await pool.query(
          `DELETE FROM ledgers WHERE network = $1 AND sequence >= $2`,
          [network, ledger]
        );
        console.log(`Deleted ${result.rowCount} ledgers from ${network}`);
        console.log(`Cursor reset to ledger ${ledger}`);
        details = `Deleted ${result.rowCount} ledgers, cursor reset to ${ledger}`;
        success = true;
        break;
      }

      case 'show-state': {
        const latest = await getLatestIndexedLedger(pool, network);
        const earliest = await getEarliestIndexedLedger(pool, network);
        const gapCount = await countLedgerGaps(pool, network);

        console.log(`Indexing state for ${network}:`);
        console.log(`  Earliest indexed ledger: ${earliest || 'none'}`);
        console.log(`  Latest indexed ledger: ${latest || 'none'}`);
        console.log(`  Gap count: ${gapCount}`);
        details = `Earliest: ${earliest}, Latest: ${latest}, Gaps: ${gapCount}`;
        success = true;
        break;
      }

      case 'show-gaps': {
        const gaps = await findLedgerGaps(pool, network, 100);
        if (gaps.length === 0) {
          console.log(`No gaps detected in ${network}`);
        } else {
          console.log(`Missing ledgers in ${network} (showing first 100):`);
          console.log(gaps.join(', '));
        }
        details = `${gaps.length} gaps found`;
        success = true;
        break;
      }

      default:
        usage();
    }
  } catch (err) {
    details = err instanceof Error ? err.message : String(err);
    console.error(details);
  } finally {
    await logAdminOperation(pool, network, command, args, success, details);
    await pool.end();
  }

  if (!success) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
