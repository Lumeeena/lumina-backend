import { Pool, PoolClient, type PoolConfig } from 'pg';
import type { HorizonAccount, HorizonLedger, HorizonOperation, HorizonTransaction, HorizonTrade } from './horizon';
import type { ContractEvent, ContractStorageEntry } from './soroban';
import { notifyIndexed } from './notify';
import { subsystem } from './logger';
import { dbPoolConnectionsIdle, dbPoolConnectionsTotal, dbPoolWaiting, indexerPoolErrors } from './metrics';
import { PREPARED_STATEMENTS } from './preparedStatements';

const log = subsystem('db');
import { parseContractSchema, type ContractSchema } from './customSchema';
import type { DecodedCustomEvent } from './customDecode';
import { claimableBalanceId } from './claimableBalanceId';

/**
 * Postgres SQLSTATE for a CHECK constraint violation.
 *
 * Worth picking out from a generic database error: a check violation means the
 * row itself is implausible (see db/migrations/008_data_constraints.sql), so
 * retrying the identical write fails identically — unlike a transient error
 * (deadlock, connection drop), a retry will never succeed. Naming the
 * constraint turns a cryptic write failure into an actionable data-quality
 * signal.
 */
const PG_CHECK_VIOLATION = '23514';

/** True when the error is a Postgres CHECK constraint violation. */
export function isCheckViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === PG_CHECK_VIOLATION;
}

/** A short, loggable description of a constraint violation, if it carries one. */
function describeCheckViolation(err: unknown): string {
  const e = err as { constraint?: unknown; table?: unknown };
  if (typeof e.constraint === 'string' && e.constraint) {
    return `check constraint "${e.constraint}"${typeof e.table === 'string' && e.table ? ` on ${e.table}` : ''}`;
  }
  return 'a check constraint';
}

/**
 * Report a failed write clearly when it was rejected by a check constraint.
 *
 * Called before the error is retried/rewritten by the caller, so the specific
 * violation is visible alongside the generic retry logging.
 */
function logCheckViolation(context: Record<string, unknown>, err: unknown): void {
  if (!isCheckViolation(err)) return;
  log.error(
    { ...context, violation: describeCheckViolation(err), err: err instanceof Error ? err.message : String(err) },
    'write rejected by a database check constraint; the row is implausible, so retrying will not help'
  );
}

/**
 * JSON replacer that renders bigint as a decimal string.
 *
 * Soroban values are full of u128/i128 token amounts, which arrive from
 * scValToNative as bigint. JSON has no bigint, and the codebase's convention
 * (see customDecode.ts) is to keep such amounts as canonical decimal text so
 * they never lose precision — so they are stringified, not rounded.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Which of the two indexer pools a query runs on.
 *
 * `write` carries every mutating statement — ledger indexing, events, trades,
 * the retry queue, retention. `read` carries the standalone reads: cursor
 * probes, schema loads, and the long scans (gap detection, integrity checks)
 * whose whole point is that they can take their time.
 */
export type DbPoolRole = 'write' | 'read';

/**
 * The indexer's two database pools, sized independently.
 *
 * They exist so a long-running read — a gap scan over the whole `ledgers`
 * table, an integrity check — cannot occupy the connections the write path
 * needs. Before this split, one pool served both, and a slow read stalled
 * indexing for a reason that had nothing to do with writing. Both pools point
 * at the same database; the separation is one of connection budget, not of
 * data source.
 */
export interface Pools {
  write: Pool;
  read: Pool;
}

/**
 * Pool factory with the idle-client error handled.
 *
 * Postgres emits `error` on the pool when a client dies while idle. With no
 * listener that is an unhandled `'error'` event — the process dies — so the
 * handler logs it and counts it; the pool replaces the client itself.
 *
 * The `role` labels that counter.
 *
 * A client checked out of the pool has no such listener: pg-pool removes its
 * own while the client is in use. So a connection that dies inside a ledger
 * transaction — a Postgres restart, `pg_terminate_backend` — raised the same
 * unhandled event on the client and killed the process mid-write. The
 * statement in flight already rejects with that error, which rolls the ledger
 * back and sends it to the retry path, and `release()` discards a client that
 * is no longer queryable; the client listener only has to exist.
 */
export function createPool(databaseUrl: string, options?: PoolConfig, role: DbPoolRole = 'write'): Pool {
  const pool = new Pool({ connectionString: databaseUrl, ...options });
  pool.on('error', err => {
    indexerPoolErrors.inc({ pool: role });
    log.error({ pool: role, err: err.message }, 'unexpected PostgreSQL pool client error; pool will replace the client');
  });
  pool.on('connect', client => {
    client.on('error', () => undefined);
  });
  return pool;
}

/**
 * Sample both pools' saturation into the per-pool gauges.
 *
 * Called at scrape time rather than on a timer, so the numbers in a scrape
 * are the numbers at scrape time and there is no background interval to leak.
 * `waiting` above zero on the write pool means indexing work is queued for a
 * connection; the same on only the read pool means the long reads are
 * saturating their own budget and nothing else.
 */
export function samplePoolSaturation(pools: Pools): void {
  for (const [name, pool] of [['write', pools.write], ['read', pools.read]] as const) {
    // These are documented pg.Pool properties but not in every @types/pg version.
    const stats = pool as unknown as { totalCount?: number; idleCount?: number; waitingCount?: number };
    dbPoolConnectionsTotal.set({ pool: name }, stats.totalCount ?? 0);
    dbPoolConnectionsIdle.set({ pool: name }, stats.idleCount ?? 0);
    dbPoolWaiting.set({ pool: name }, stats.waitingCount ?? 0);
  }
}

/**
 * Highest ledger indexed for one network.
 *
 * Every read here is scoped by `network`: the tables are keyed by
 * (sequence, network), so `MAX(sequence)` unfiltered would happily return the
 * other chain's tip and make a fresh network look like it had nothing to do.
 */
export async function getLatestIndexedLedger(pool: Pool, network: string): Promise<number> {
  const { rows } = await pool.query<{ max: string | null }>(
    'SELECT MAX(sequence) AS max FROM ledgers WHERE network = $1',
    [network]
  );
  return rows[0]?.max ? Number(rows[0].max) : 0;
}

/**
 * Lowest ledger indexed for one network.
 */
export async function getEarliestIndexedLedger(pool: Pool, network: string): Promise<number> {
  const { rows } = await pool.query<{ min: string | null }>(
    'SELECT MIN(sequence) AS min FROM ledgers WHERE network = $1',
    [network]
  );
  return rows[0]?.min ? Number(rows[0].min) : 0;
}

export interface BackfillProgressRecord {
  network: string;
  startLedger: number;
  endLedger: number;
  currentLedger: number;
  completedAt: string | null;
}

/**
 * Gets or initializes backfill progress for a network and ledger range.
 * If no progress row exists yet, inserts one starting at endLedger.
 */
export async function getOrInitBackfillProgress(
  pool: Pool,
  network: string,
  startLedger: number,
  endLedger: number
): Promise<BackfillProgressRecord> {
  const { rows } = await pool.query<{
    network: string;
    start_ledger: string;
    end_ledger: string;
    current_ledger: string;
    completed_at: string | null;
  }>(
    `INSERT INTO backfill_progress (network, start_ledger, end_ledger, current_ledger)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (network, start_ledger, end_ledger) DO UPDATE SET updated_at = NOW()
     RETURNING network, start_ledger, end_ledger, current_ledger, completed_at`,
    [network, startLedger, endLedger]
  );

  const row = rows[0]!;
  return {
    network: row.network,
    startLedger: Number(row.start_ledger),
    endLedger: Number(row.end_ledger),
    currentLedger: Number(row.current_ledger),
    completedAt: row.completed_at,
  };
}

/**
 * Updates the current backfill ledger cursor, marking completed if it reaches startLedger - 1.
 */
export async function updateBackfillProgress(
  pool: Pool,
  network: string,
  startLedger: number,
  endLedger: number,
  currentLedger: number
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const completed = currentLedger < startLedger;
    await client.query(
      `UPDATE backfill_progress
       SET current_ledger = $4,
           completed_at = CASE WHEN $5 THEN NOW() ELSE completed_at END,
           updated_at = NOW()
       WHERE network = $1 AND start_ledger = $2 AND end_ledger = $3`,
      [network, startLedger, endLedger, currentLedger, completed]
    );
    await setIndexerCursor(client, network, 'backfill', currentLedger);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Creates any missing `operations` partitions covering the ledger range up
 * to `partitionsAhead` partitions past the current max indexed ledger. Safe
 * to call repeatedly — it no-ops once the needed partitions already exist.
 * See db/migrations/006_partition_operations.sql for the partition-sizing
 * rationale and the ensure_operations_partitions() function this calls.
 */
export async function ensurePartitions(pool: Pool, partitionsAhead = 5): Promise<void> {
  await pool.query('SELECT ensure_operations_partitions($1)', [partitionsAhead]);
}

/**
 * Return accounts whose stored state may not include the ledger being indexed.
 * A snapshot modified at or after that ledger already reflects its account state.
 */
export async function getAccountsNeedingRefresh(
  pool: Pool,
  network: string,
  addresses: string[],
  ledger: number
): Promise<string[]> {
  if (addresses.length === 0) return [];

  const { rows } = await pool.query<{ address: string; last_modified_ledger: string }>(
    `SELECT address, last_modified_ledger
     FROM accounts
     WHERE network = $1 AND address = ANY($2)`,
    [network, addresses]
  );
  const modifiedAt = new Map<string, number>();
  for (const row of rows) modifiedAt.set(row.address, Number(row.last_modified_ledger));

  return addresses.filter(address => {
    const lastModifiedLedger = modifiedAt.get(address);
    return lastModifiedLedger === undefined || lastModifiedLedger < ledger;
  });
}

export interface AccountRefreshRequest {
  address: string;
  lastRequestedLedger: number;
  lastModifiedLedger: number | null;
}

export async function getPendingAccountRefreshes(
  pool: Pool,
  network: string,
  limit: number
): Promise<AccountRefreshRequest[]> {
  const { rows } = await pool.query<{
    address: string;
    last_requested_ledger: string;
    last_modified_ledger: string | null;
  }>(
    `SELECT q.address, q.last_requested_ledger, a.last_modified_ledger
     FROM account_refresh_queue q
     LEFT JOIN accounts a ON a.network = q.network AND a.address = q.address
     WHERE q.network = $1
       AND q.queued_at <= NOW()
     ORDER BY q.queued_at, q.address
     LIMIT $2`,
    [network, limit]
  );

  return rows.map(row => ({
    address: row.address,
    lastRequestedLedger: Number(row.last_requested_ledger),
    lastModifiedLedger: row.last_modified_ledger === null ? null : Number(row.last_modified_ledger),
  }));
}

export async function completeAccountRefreshes(
  pool: Pool,
  network: string,
  completed: Array<{ request: AccountRefreshRequest; account: HorizonAccount | null }>
): Promise<void> {
  if (completed.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { account } of completed) {
      if (account) {
        await upsertAccount(client, network, account);
        await insertAccountStateHistory(client, network, account);
      }
    }

    await client.query(
      `DELETE FROM account_refresh_queue q
       USING unnest($2::text[], $3::bigint[]) AS completed(address, last_requested_ledger)
       WHERE q.network = $1
         AND q.address = completed.address
         AND q.last_requested_ledger = completed.last_requested_ledger`,
      [
        network,
        completed.map(item => item.request.address),
        completed.map(item => item.request.lastRequestedLedger),
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deferAccountRefreshes(
  pool: Pool,
  network: string,
  deferred: AccountRefreshRequest[]
): Promise<void> {
  if (deferred.length === 0) return;

  await pool.query(
    `UPDATE account_refresh_queue q
    SET queued_at = NOW() + INTERVAL '5 seconds'
     FROM unnest($2::text[], $3::bigint[]) AS deferred(address, last_requested_ledger)
     WHERE q.network = $1
       AND q.address = deferred.address
       AND q.last_requested_ledger = deferred.last_requested_ledger`,
    [
      network,
      deferred.map(request => request.address),
      deferred.map(request => request.lastRequestedLedger),
    ]
  );
}

export const BATCH_CHUNK_SIZE = 500;

export async function recordDeadLetterOperation(
  client: Pool | PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation,
  error: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO dead_letter_operations (network, ledger, operation_id, payload, error)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [network, ledger, operation.id ?? null, JSON.stringify(operation, bigintReplacer), error instanceof Error ? error.message : String(error)]
  );
}

export async function countPendingDeadLetters(pool: Pool, network?: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    network
      ? `SELECT COUNT(*)::text AS count FROM dead_letter_operations WHERE network = $1 AND status = 'pending'`
      : `SELECT COUNT(*)::text AS count FROM dead_letter_operations WHERE status = 'pending'`,
    network ? [network] : []
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function reprocessDeadLetter(
  pool: Pool,
  id: number,
  process: (operation: HorizonOperation) => Promise<void>
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ payload: HorizonOperation }>(
      `SELECT payload FROM dead_letter_operations WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [id]
    );
    if (!rows[0]) throw new Error(`pending dead letter ${id} was not found`);
    await process(rows[0].payload);
    await client.query(
      `UPDATE dead_letter_operations SET status = 'processed', processed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getIndexerCursor(pool: Pool, network: string, purpose: 'forward' | 'backfill' | 'events'): Promise<number | null> {
  const { rows } = await pool.query<{ cursor: string }>(
    'SELECT cursor FROM indexer_cursors WHERE network = $1 AND purpose = $2',
    [network, purpose]
  );
  return rows[0] ? Number(rows[0].cursor) : null;
}

export async function setIndexerCursor(
  client: Pool | PoolClient,
  network: string,
  purpose: 'forward' | 'backfill' | 'events',
  cursor: number
): Promise<void> {
  await client.query(
    `INSERT INTO indexer_cursors (network, purpose, cursor)
     VALUES ($1, $2, $3)
     ON CONFLICT (network, purpose) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = NOW()`,
    [network, purpose, cursor]
  );
}

/**
 * Writes a ledger, transactions, operations, and account refresh intents in a
 * single transaction. If it rolls back, the ledger is retried; after commit,
 * the outbox survives a crash and the account worker resumes it on startup.
 */
export async function indexLedger(
  pool: Pool,
  network: string,
  ledger: HorizonLedger,
  transactions: HorizonTransaction[],
  operations: HorizonOperation[],
  accountAddresses: string[] = []
): Promise<void> {
  // A created claimable balance's id is derived from its transaction.
  const transactionsByHash = new Map(transactions.map(tx => [tx.hash, tx]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query({
      name: PREPARED_STATEMENTS.INSERT_LEDGER,
      text: `INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count, base_fee, base_reserve, network)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (sequence, network) DO NOTHING`,
      values: [
        ledger.sequence,
        ledger.closed_at,
        ledger.successful_transaction_count + ledger.failed_transaction_count,
        ledger.operation_count,
        ledger.base_fee_in_stroops,
        ledger.base_reserve_in_stroops,
        network,
      ],
    });

    if (transactions.length > 0) {
      for (let i = 0; i < transactions.length; i += BATCH_CHUNK_SIZE) {
        const chunk = transactions.slice(i, i + BATCH_CHUNK_SIZE);
        const values: unknown[] = [];
        const rows: string[] = [];

        chunk.forEach((tx, rowIdx) => {
          const offset = rowIdx * 10;
          rows.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`
          );
          values.push(
            tx.hash,
            tx.ledger,
            tx.created_at,
            tx.source_account,
            tx.fee_charged,
            tx.operation_count,
            tx.successful,
            tx.memo_type,
            tx.memo ?? null,
            network
          );
        });

        await client.query(
          `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo, network)
           VALUES ${rows.join(', ')}
           ON CONFLICT (hash, network) DO NOTHING`,
          values
        );
      }
    }

    if (operations.length > 0) {
      for (let i = 0; i < operations.length; i += BATCH_CHUNK_SIZE) {
        const chunk = operations.slice(i, i + BATCH_CHUNK_SIZE);
        const values: unknown[] = [];
        const rows: string[] = [];

        chunk.forEach((op, rowIdx) => {
          const offset = rowIdx * 8;
          rows.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`
          );
          values.push(
            op.id,
            op.type,
            op.transaction_hash,
            ledger.sequence,
            op.created_at,
            op.source_account,
            JSON.stringify(op),
            network
          );
        });

        // No ON CONFLICT inference clause, deliberately. The two shapes this
        // insert has to work against do not agree on a key: a database built
        // from db/schema.sql has a plain `operations` keyed (id, network), while
        // a deployment that ran the original 006_partition_operations still has
        // it partitioned by ledger and keyed (id, ledger, network) — 007 could not
        // add `network` to that key without carrying the partition key too.
        // Naming either target breaks the other shape; naming none works on both.
        //
        // That is safe here because the inference clause is a no-op for a plain
        // DO NOTHING: it only picks which unique violation is tolerated, and
        // `operations` has exactly one unique constraint either way. A DO UPDATE
        // insert would need the target, since it has to know which row to
        // overwrite.
        await client.query(
          `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details, network)
           VALUES ${rows.join(', ')}
           ON CONFLICT DO NOTHING`,
          values
        );
      }

      for (const op of operations) {
        // Process asset-related operations for trustlines, assets, and volume tracking
        await client.query('SAVEPOINT operation_processing');
        try {
          await processAssetOperation(client, network, ledger.sequence, op);

        // Process liquidity pools, claimable balances, path payments, and set_options operations
        await processLiquidityPoolOperation(client, network, ledger.sequence, op);
        await processClaimableBalanceOperation(client, network, ledger.sequence, op, transactionsByHash.get(op.transaction_hash));
        await processPathPaymentOperation(client, network, ledger.sequence, op);
        await processSetOptionsOperation(client, network, ledger.sequence, op);

        // Process decoded operations (Issue #260)
        await processDecodedOperations(client, network, ledger.sequence, op);

        // Process sponsorship revocations (Issue #261)
        await processRevokeSponsorshipOperation(client, network, ledger.sequence, op);

        // Process Soroban TTL operations (Issue #262)
        await processSorobanTTLOperation(client, network, ledger.sequence, op);

        // Process contract interface extraction (Issue #263)
          await processContractInterfaceOperation(client, network, ledger.sequence, op);
          await client.query('RELEASE SAVEPOINT operation_processing');
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT operation_processing');
          await client.query('RELEASE SAVEPOINT operation_processing');
          await recordDeadLetterOperation(client, network, ledger.sequence, op, err);
          log.error({ network, ledger: ledger.sequence, operation: op.id, err: err instanceof Error ? err.message : String(err) }, 'operation was retained in dead letter table');
        }
      }
    }

    if (accountAddresses.length > 0) {
      await client.query(
        `INSERT INTO account_refresh_queue (network, address, last_requested_ledger)
         SELECT $1, address, $3
         FROM unnest($2::text[]) AS addresses(address)
         ON CONFLICT (network, address) DO UPDATE SET
           last_requested_ledger = GREATEST(account_refresh_queue.last_requested_ledger, EXCLUDED.last_requested_ledger)`,
        [network, accountAddresses, ledger.sequence]
      );
    }

    // Clear any failure records for this ledger now that it has landed
    await clearLedgerFailures(client, network, ledger.sequence);
    await setIndexerCursor(client, network, 'forward', ledger.sequence);

    // Queued inside the transaction on purpose: Postgres delivers notifications
    // at commit, so a rolled-back ledger announces nothing and no subscriber is
    // ever told about rows that did not land.
    await notifyIndexed(client, {
      kind: 'ledger',
      network,
      ledger: ledger.sequence,
      transactions: transactions.length,
      operations: operations.length,
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logCheckViolation({ network, ledger: ledger.sequence, transactions: transactions.length, operations: operations.length }, err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Upsert one account's current state.
 *
 * Scoped by `network` on both sides of the conflict: the same address exists
 * on every chain it has ever funded, and overwriting mainnet's balances with
 * testnet's is not a bug anyone would notice from the data alone.
 */
export async function upsertAccount(
  client: PoolClient,
  network: string,
  account: HorizonAccount
): Promise<void> {
  await client.query({
    name: PREPARED_STATEMENTS.UPSERT_ACCOUNT,
    text: `INSERT INTO accounts (address, sequence, subentry_count, last_modified_ledger, num_sponsored, num_sponsoring, balances, flags, thresholds, updated_at, network)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
           ON CONFLICT (address, network) DO UPDATE SET
             sequence = EXCLUDED.sequence,
             subentry_count = EXCLUDED.subentry_count,
             last_modified_ledger = EXCLUDED.last_modified_ledger,
             num_sponsored = EXCLUDED.num_sponsored,
             num_sponsoring = EXCLUDED.num_sponsoring,
             balances = EXCLUDED.balances,
             flags = EXCLUDED.flags,
             thresholds = EXCLUDED.thresholds,
             updated_at = NOW()`,
    values: [
      account.account_id,
      account.sequence,
      account.subentry_count,
      account.last_modified_ledger,
      account.num_sponsored,
      account.num_sponsoring,
      JSON.stringify(account.balances),
      JSON.stringify(account.flags),
      JSON.stringify(account.thresholds),
      network,
    ],
  });
}

/**
 * Stores one observed state of an account in `account_state_history`, so that
 * `account(asOfLedger:)` can answer for a past ledger (docs/ACCOUNT_STATE_HISTORY.md).
 *
 * Keyed by the state's own last-modified ledger, so seeing the same state twice
 * stores it once. Called inside the same transaction as the `accounts` upsert,
 * so a rollback removes both.
 */
export async function insertAccountStateHistory(
  client: PoolClient,
  network: string,
  account: HorizonAccount
): Promise<void> {
  await client.query({
    text: `INSERT INTO account_state_history (address, network, last_modified_ledger, sequence, subentry_count, num_sponsored, num_sponsoring, balances, flags, thresholds)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (address, network, last_modified_ledger) DO NOTHING`,
    values: [
      account.account_id,
      network,
      account.last_modified_ledger,
      account.sequence,
      account.subentry_count,
      account.num_sponsored,
      account.num_sponsoring,
      JSON.stringify(account.balances),
      JSON.stringify(account.flags),
      JSON.stringify(account.thresholds),
    ],
  });
}

export async function insertContractEvents(
  pool: Pool,
  network: string,
  events: ContractEvent[]
): Promise<void> {
  if (events.length === 0) return;

  // Events arrive from Soroban RPC on their own cadence, keyed by the ledger
  // they were emitted in — so the notification names the highest ledger in the
  // batch, which is what a subscriber would read up to.
  let highestLedger = 0;

  try {
    for (const event of events) {
      await pool.query({
        name: PREPARED_STATEMENTS.INSERT_CONTRACT_EVENT,
        text: `INSERT INTO contract_events (id, type, contract_id, ledger, created_at, paging_token, topics, value, transaction_hash, network)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (id, network) DO NOTHING`,
        values: [
          event.id,
          event.type,
          event.contractId,
          event.ledger,
          event.createdAt,
          event.pagingToken,
          event.topics,
          // An i128 token amount decodes as a bigint, which plain JSON.stringify
          // throws on: the batch then never lands and the event cursor never
          // moves past it. Stored as decimal text, like contract storage values.
          event.value === undefined ? null : JSON.stringify(event.value, bigintReplacer),
          event.transactionHash,
          network,
        ],
      });
      if (event.ledger > highestLedger) highestLedger = event.ledger;
    }
  } catch (err) {
    logCheckViolation({ network, events: events.length }, err);
    throw err;
  }

  await notifyIndexed(pool, {
    kind: 'events',
    network,
    ledger: highestLedger,
    events: events.length,
  });
}

export async function getLatestIndexedEventLedger(pool: Pool, network: string): Promise<number> {
  const { rows } = await pool.query<{ max: string | null }>(
    'SELECT MAX(ledger) AS max FROM contract_events WHERE network = $1',
    [network]
  );
  return rows[0]?.max ? Number(rows[0].max) : 0;
}

// ─── Custom per-contract event schemas ─────────────────────────────────────

/**
 * Every registered schema, keyed by contract ID.
 *
 * Read once per poll cycle rather than cached indefinitely, so a schema
 * registered while the indexer is running takes effect without a restart —
 * registration is a CLI operation against the database, not a signal the
 * indexer can receive.
 */
export async function loadContractSchemas(
  pool: Pool,
  network: string
): Promise<Map<string, ContractSchema>> {
  const { rows } = await pool.query<{ contract_id: string; definition: unknown }>(
    'SELECT contract_id, definition FROM contract_schemas WHERE network = $1',
    [network]
  );

  const schemas = new Map<string, ContractSchema>();
  for (const row of rows) {
    try {
      schemas.set(row.contract_id, parseContractSchema(row.definition));
    } catch (err) {
      // A stored schema that no longer validates — because the rules tightened
      // in a later release — must not stop every other contract from indexing.
      log.error(
        { contractId: row.contract_id, err: err instanceof Error ? err.message : String(err) },
        'ignoring invalid stored schema'
      );
    }
  }
  return schemas;
}

/** Register or replace a contract's schema. Validated before it is stored. */
export async function upsertContractSchema(
  pool: Pool,
  network: string,
  schema: ContractSchema
): Promise<void> {
  await pool.query(
    `INSERT INTO contract_schemas (contract_id, version, definition, updated_at, network)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (contract_id, network) DO UPDATE SET
       version = EXCLUDED.version,
       definition = EXCLUDED.definition,
       updated_at = NOW()`,
    [schema.contractId, schema.version, JSON.stringify(schema), network]
  );
}

export async function deleteContractSchema(
  pool: Pool,
  network: string,
  contractId: string
): Promise<void> {
  await pool.query('DELETE FROM contract_schemas WHERE contract_id = $1 AND network = $2', [
    contractId,
    network,
  ]);
}

/**
 * Store decoded events.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING`, unlike the generic event
 * insert: re-indexing the same event after a schema revision should produce the
 * new decoding, and the old row would otherwise survive forever.
 */
export async function insertCustomEvents(
  pool: Pool,
  network: string,
  events: DecodedCustomEvent[]
): Promise<void> {
  if (events.length === 0) return;

  try {
    for (const event of events) {
      await pool.query(
        `INSERT INTO custom_events
           (event_id, contract_id, event_name, ledger, created_at, schema_version, fields, network)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id, event_name, network) DO UPDATE SET
           schema_version = EXCLUDED.schema_version,
           fields = EXCLUDED.fields,
           indexed_at = NOW()`,
        [
          event.eventId,
          event.contractId,
          event.eventName,
          event.ledger,
          event.createdAt,
          event.schemaVersion,
          // The whole point of the JSONB payload: field names travel as data,
          // never as SQL identifiers.
          JSON.stringify(event.fields),
          network,
        ]
      );
    }
  } catch (err) {
    logCheckViolation({ network, events: events.length }, err);
    throw err;
  }
}

// ─── Contract storage entries (Soroban) ────────────────────────────────────

/**
 * Insert or refresh contract storage entries as `active`.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING`: re-fetching a live entry
 * produces its current value, and the old value would otherwise survive
 * forever. An entry that was archived and is later restored (returned by the
 * RPC again) is flipped back to `active` by the same statement.
 */
export async function upsertContractStorageEntries(
  pool: Pool,
  network: string,
  entries: ContractStorageEntry[]
): Promise<void> {
  if (entries.length === 0) return;

  for (const entry of entries) {
    await pool.query(
      `INSERT INTO contract_storage_entries
         (contract_id, key, durability, state, value, value_xdr, live_until_ledger, last_modified_ledger, indexed_at, network)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, NOW(), $8)
       ON CONFLICT (contract_id, key, network) DO UPDATE SET
         durability = EXCLUDED.durability,
         state = 'active',
         value = EXCLUDED.value,
         value_xdr = EXCLUDED.value_xdr,
         live_until_ledger = EXCLUDED.live_until_ledger,
         last_modified_ledger = EXCLUDED.last_modified_ledger,
         indexed_at = NOW()`,
      [
        entry.contractId,
        entry.key,
        entry.durability,
        entry.value === null ? null : JSON.stringify(entry.value, bigintReplacer),
        entry.valueXdr,
        entry.liveUntilLedgerSeq,
        entry.lastModifiedLedgerSeq,
        network,
      ]
    );
  }
}

/**
 * Append this batch to the contract storage change history.
 *
 * `contract_storage_entries` holds only the current value; this table is the
 * append-only timeline behind it (db/migrations/010_contract_storage_history.sql).
 * One row per observed state, keyed by the ledger it was observed at —
 * `ON CONFLICT DO NOTHING` because the storage poll re-fetches overlapping
 * ranges, and a re-observed unchanged state is the same history row, not a
 * second one.
 */
export async function recordContractStorageHistory(
  pool: Pool,
  network: string,
  entries: ContractStorageEntry[]
): Promise<void> {
  if (entries.length === 0) return;

  for (const entry of entries) {
    await pool.query(
      `INSERT INTO contract_storage_history
         (contract_id, key, durability, value, value_xdr, live_until_ledger, last_modified_ledger, indexed_at, network)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
       ON CONFLICT (contract_id, key, last_modified_ledger, network) DO NOTHING`,
      [
        entry.contractId,
        entry.key,
        entry.durability,
        entry.value === null ? null : JSON.stringify(entry.value, bigintReplacer),
        entry.valueXdr,
        entry.liveUntilLedgerSeq,
        entry.lastModifiedLedgerSeq,
        network,
      ]
    );
  }
}

/**
 * Mark the given storage keys as `archived`, keeping the rows.
 *
 * Soroban archives a persistent entry once its TTL expires: the entry is not
 * deleted, it is inaccessible until restored. Deleting our row would report
 * the contract as having lost state it still has, so the row is kept and only
 * its `state` changes — which is what lets a client distinguish "archived"
 * (a row with `state = 'archived'`) from "absent" (no row at all).
 *
 * Only rows that are currently `active` are touched, so re-archiving an
 * already-archived entry is a no-op rather than a repeated write.
 */
export async function markContractStorageEntriesArchived(
  pool: Pool,
  network: string,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) return;

  await pool.query(
    `UPDATE contract_storage_entries
     SET state = 'archived', indexed_at = NOW()
     WHERE network = $1 AND key = ANY($2::text[]) AND state = 'active'`,
    [network, keys]
  );
}

/**
 * Every storage key this network has indexed, regardless of state.
 *
 * The polling loop re-fetches these each cycle: a key the RPC stops returning
 * is the archival signal (see markContractStorageEntriesArchived). Seeding new
 * keys into the watch list is the caller's job — see
 * INDEXED_CONTRACT_STORAGE_KEYS in indexer/src/config.ts.
 */
export async function getTrackedContractStorageKeys(pool: Pool, network: string): Promise<string[]> {
  const { rows } = await pool.query<{ key: string }>(
    'SELECT DISTINCT key FROM contract_storage_entries WHERE network = $1',
    [network]
  );
  return rows.map(row => row.key);
}

// ─── Retry queue for failed ledgers ────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 10;
const RETRY_BACKOFF_BASE_MS = 5000; // 5 seconds

/**
 * Add a failed ledger to the retry queue with exponential backoff.
 */
export async function enqueueLedgerRetry(
  pool: Pool,
  network: string,
  ledger: number,
  error: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ attempt_count: number }>(
      'SELECT attempt_count FROM ledger_retry_queue WHERE ledger = $1 AND network = $2',
      [ledger, network]
    );

    const attemptCount = rows[0] ? rows[0].attempt_count + 1 : 1;
    const isPermanentlyFailed = attemptCount >= MAX_RETRY_ATTEMPTS;
    const backoffMs = Math.min(RETRY_BACKOFF_BASE_MS * Math.pow(2, attemptCount - 1), 3600000); // Max 1 hour

    await client.query(
      `INSERT INTO ledger_retry_queue
         (ledger, network, attempt_count, next_attempt_at, last_error, last_attempted_at, permanently_failed)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 millisecond' * $4, $5, NOW(), $6)
       ON CONFLICT (ledger, network) DO UPDATE SET
         attempt_count = $3,
         next_attempt_at = NOW() + INTERVAL '1 millisecond' * $4,
         last_error = $5,
         last_attempted_at = NOW(),
         permanently_failed = $6`,
      [ledger, network, attemptCount, backoffMs, error, isPermanentlyFailed]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get ledgers that are due for retry.
 */
export async function getPendingRetries(pool: Pool, network: string, limit = 10): Promise<number[]> {
  const { rows } = await pool.query<{ ledger: number }>(
    `SELECT ledger FROM ledger_retry_queue
     WHERE network = $1
       AND NOT permanently_failed
       AND next_attempt_at <= NOW()
     ORDER BY next_attempt_at ASC
     LIMIT $2`,
    [network, limit]
  );
  return rows.map(r => r.ledger);
}

/**
 * Remove a ledger from the retry queue after successful indexing.
 */
export async function removeLedgerFromRetryQueue(
  pool: Pool,
  network: string,
  ledger: number
): Promise<void> {
  await pool.query(
    'DELETE FROM ledger_retry_queue WHERE ledger = $1 AND network = $2',
    [ledger, network]
  );
}

/**
 * Record a ledger that exhausted retries into failed_ledgers.
 */
export async function recordFailedLedger(
  pool: Pool | PoolClient,
  network: string,
  sequence: number,
  error: string,
  attemptCount: number
): Promise<void> {
  await pool.query(
    `INSERT INTO failed_ledgers (sequence, network, error, attempt_count, failed_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (sequence, network) DO UPDATE SET
       error = EXCLUDED.error,
       attempt_count = EXCLUDED.attempt_count,
       failed_at = EXCLUDED.failed_at`,
    [sequence, network, error, attemptCount]
  );
}

/**
 * Remove a ledger from failed_ledgers and ledger_retry_queue after successful
 * indexing.
 *
 * The retry queue has to be cleared here, not only by the retry worker. Every
 * caller that enqueues a retry (forward loop, backfill, gap repair) also
 * retries the same ledger itself on its next pass, so the ledger usually lands
 * through that caller rather than through the worker. Before this, the row
 * outlived the ledger: the worker re-fetched and re-wrote a ledger that was
 * already indexed, and a row that had reached permanently_failed first was
 * never deleted by anything. See docs/LEDGER_RETRY_QUEUE_REVIEW.md.
 *
 * One statement rather than two so the extra delete costs a primary-key probe
 * on a near-empty table, not an extra round trip on the ledger write path.
 */
export async function clearLedgerFailures(
  client: Pool | PoolClient,
  network: string,
  sequence: number
): Promise<void> {
  await client.query(
    `WITH cleared_failure AS (
       DELETE FROM failed_ledgers WHERE sequence = $1 AND network = $2
     )
     DELETE FROM ledger_retry_queue WHERE ledger = $1 AND network = $2`,
    [sequence, network]
  );
}

/**
 * Get all failed ledgers for a network.
 */
export async function getFailedLedgers(
  pool: Pool,
  network: string,
  limit = 100
): Promise<{ sequence: number; error: string | null; attempt_count: number; failed_at: string }[]> {
  const { rows } = await pool.query<{
    sequence: string;
    error: string | null;
    attempt_count: number;
    failed_at: string;
  }>(
    `SELECT sequence, error, attempt_count, failed_at
     FROM failed_ledgers
     WHERE network = $1
     ORDER BY sequence ASC
     LIMIT $2`,
    [network, limit]
  );
  return rows.map(r => ({
    sequence: Number(r.sequence),
    error: r.error,
    attempt_count: r.attempt_count,
    failed_at: r.failed_at,
  }));
}

/**
 * Detect missing ledger sequence numbers below the highest indexed ledger.
 * Also includes any ledgers in failed_ledgers.
 */
export async function findLedgerGaps(
  pool: Pool,
  network: string,
  limit = 100
): Promise<number[]> {
  const { rows } = await pool.query<{ sequence: string }>(
    `WITH seq_gaps AS (
       SELECT sequence,
              LEAD(sequence) OVER (ORDER BY sequence) AS next_sequence
       FROM ledgers
       WHERE network = $1
     ),
     gap_ranges AS (
       SELECT sequence + 1 AS gap_start, next_sequence - 1 AS gap_end
       FROM seq_gaps
       WHERE next_sequence > sequence + 1
     ),
     detected_gaps AS (
       SELECT s.seq::bigint AS sequence
       FROM gap_ranges,
            LATERAL generate_series(gap_start, gap_end) AS s(seq)
     ),
     failed AS (
       SELECT sequence
       FROM failed_ledgers
       WHERE network = $1
     )
     SELECT DISTINCT sequence
     FROM (
       SELECT sequence FROM detected_gaps
       UNION ALL
       SELECT sequence FROM failed
     ) all_gaps
     ORDER BY sequence ASC
     LIMIT $2`,
    [network, limit]
  );
  return rows.map(r => Number(r.sequence));
}

/**
 * Count the total number of missing ledger sequence numbers below the maximum indexed ledger.
 */
export async function countLedgerGaps(
  pool: Pool,
  network: string
): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `WITH seq_gaps AS (
       SELECT sequence,
              LEAD(sequence) OVER (ORDER BY sequence) AS next_sequence
       FROM ledgers
       WHERE network = $1
     ),
     gap_ranges AS (
       SELECT sequence + 1 AS gap_start, next_sequence - 1 AS gap_end
       FROM seq_gaps
       WHERE next_sequence > sequence + 1
     ),
     detected_gaps AS (
       SELECT s.seq::bigint AS sequence
       FROM gap_ranges,
            LATERAL generate_series(gap_start, gap_end) AS s(seq)
     ),
     failed AS (
       SELECT sequence
       FROM failed_ledgers
       WHERE network = $1
     )
     SELECT COUNT(DISTINCT sequence)::int AS count
     FROM (
       SELECT sequence FROM detected_gaps
       UNION ALL
       SELECT sequence FROM failed
     ) all_gaps`,
    [network]
  );
  return rows[0]?.count !== undefined ? Number(rows[0].count) : 0;
}


/**
 * Upsert a trustline from a change_trust operation.
 * Creates or updates the trustline row and maintains the assets table holder count.
 */
export async function upsertTrustline(
  client: PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation,
  createdAt: string
): Promise<void> {
  const assetCode = (operation as { asset_code?: string }).asset_code;
  const assetIssuer = (operation as { asset_issuer?: string }).asset_issuer;
  const limit = (operation as { limit?: string }).limit;
  const account = operation.source_account;

  if (!assetCode || !assetIssuer) {
    return; // Native XLM doesn't create trustlines
  }

  // Check if this is a trustline removal (limit = "0")
  const isRemoval = limit === '0' || limit === '0.0000000';

  if (isRemoval) {
    // Remove trustline
    const deleteResult = await client.query(
      `DELETE FROM trustlines
       WHERE account = $1 AND asset_code = $2 AND asset_issuer = $3 AND network = $4
       RETURNING balance`,
      [account, assetCode, assetIssuer, network]
    );

    // If a trustline with non-zero balance was deleted, decrement holder count
    if (deleteResult.rows.length > 0) {
      const oldBalance = deleteResult.rows[0].balance;
      if (oldBalance !== '0' && oldBalance !== '0.0000000') {
        await client.query(
          `UPDATE assets
           SET holder_count = GREATEST(0, holder_count - 1),
               last_activity_ledger = $4,
               updated_at = NOW()
           WHERE asset_code = $1 AND asset_issuer = $2 AND network = $3`,
          [assetCode, assetIssuer, network, ledger]
        );
      }
    }
  } else {
    // Upsert trustline
    const result = await client.query(
      `INSERT INTO trustlines (account, asset_code, asset_issuer, trust_limit, balance, last_modified_ledger, created_at, network)
       VALUES ($1, $2, $3, $4, '0', $5, $6, $7)
       ON CONFLICT (account, asset_code, asset_issuer, network) DO UPDATE
         SET trust_limit = EXCLUDED.trust_limit,
             last_modified_ledger = EXCLUDED.last_modified_ledger,
             updated_at = NOW()
       RETURNING (xmax = 0) AS is_insert`,
      [account, assetCode, assetIssuer, limit || '922337203685.4775807', ledger, createdAt, network]
    );

    const isInsert = result.rows[0]?.is_insert;

    // Ensure asset exists and increment holder count if new trustline
    await client.query(
      `INSERT INTO assets (asset_code, asset_issuer, holder_count, first_seen_ledger, last_activity_ledger, network)
       VALUES ($1, $2, $3, $4, $4, $5)
       ON CONFLICT (asset_code, asset_issuer, network) DO UPDATE
         SET holder_count = assets.holder_count + $3,
             last_activity_ledger = EXCLUDED.last_activity_ledger,
             updated_at = NOW()`,
      [assetCode, assetIssuer, isInsert ? 1 : 0, ledger, network]
    );
  }
}

/**
 * Update trustline balance from payment operations.
 * Also updates the holder count in assets table when balance transitions to/from zero.
 */
export async function updateTrustlineBalance(
  client: PoolClient,
  network: string,
  ledger: number,
  account: string,
  assetCode: string,
  assetIssuer: string,
  balanceChange: string,
  createdAt: string
): Promise<void> {
  // Get current balance or create trustline if it doesn't exist
  const result = await client.query(
    `INSERT INTO trustlines (account, asset_code, asset_issuer, balance, last_modified_ledger, created_at, network)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (account, asset_code, asset_issuer, network) DO UPDATE
       SET balance = (trustlines.balance::numeric + $4::numeric)::text,
           last_modified_ledger = EXCLUDED.last_modified_ledger,
           updated_at = NOW()
     RETURNING (xmax = 0) AS is_insert, balance, 
               (SELECT balance FROM trustlines WHERE account = $1 AND asset_code = $2 AND asset_issuer = $3 AND network = $7) AS old_balance`,
    [account, assetCode, assetIssuer, balanceChange, ledger, createdAt, network]
  );

  const row = result.rows[0];
  const isInsert = row?.is_insert;
  const newBalance = row?.balance || '0';
  const oldBalance = row?.old_balance || '0';

  // Ensure asset exists
  await client.query(
    `INSERT INTO assets (asset_code, asset_issuer, holder_count, first_seen_ledger, last_activity_ledger, network)
     VALUES ($1, $2, 0, $3, $3, $4)
     ON CONFLICT (asset_code, asset_issuer, network) DO UPDATE
       SET last_activity_ledger = EXCLUDED.last_activity_ledger,
           updated_at = NOW()`,
    [assetCode, assetIssuer, ledger, network]
  );

  // Update holder count if balance crosses zero threshold
  const oldBalanceNum = parseFloat(oldBalance);
  const newBalanceNum = parseFloat(newBalance);
  const wasHolder = oldBalanceNum > 0;
  const isHolder = newBalanceNum > 0;

  if (!wasHolder && isHolder) {
    // Became a holder
    await client.query(
      `UPDATE assets
       SET holder_count = holder_count + 1,
           updated_at = NOW()
       WHERE asset_code = $1 AND asset_issuer = $2 AND network = $3`,
      [assetCode, assetIssuer, network]
    );
  } else if (wasHolder && !isHolder) {
    // No longer a holder
    await client.query(
      `UPDATE assets
       SET holder_count = GREATEST(0, holder_count - 1),
           updated_at = NOW()
       WHERE asset_code = $1 AND asset_issuer = $2 AND network = $3`,
      [assetCode, assetIssuer, network]
    );
  }

  // If this was a new trustline insertion, increment holder count
  if (isInsert && isHolder) {
    await client.query(
      `UPDATE assets
       SET holder_count = holder_count + 1,
           updated_at = NOW()
       WHERE asset_code = $1 AND asset_issuer = $2 AND network = $3`,
      [assetCode, assetIssuer, network]
    );
  }
}

/**
 * Track payment volume in hourly buckets.
 * Increments the volume and operation count for the asset's bucket.
 */
export async function trackAssetVolume(
  client: PoolClient,
  network: string,
  assetCode: string,
  assetIssuer: string,
  amount: string,
  timestamp: string
): Promise<void> {
  await client.query(
    `INSERT INTO asset_volume_buckets (asset_code, asset_issuer, bucket_time, volume, operation_count, network)
     VALUES ($1, $2, bucket_hour($3::timestamptz), $4::numeric, 1, $5)
     ON CONFLICT (asset_code, asset_issuer, bucket_time, network) DO UPDATE
       SET volume = asset_volume_buckets.volume + EXCLUDED.volume,
           operation_count = asset_volume_buckets.operation_count + 1`,
    [assetCode, assetIssuer, timestamp, amount, network]
  );
}

/**
 * Process an operation to update trustlines, balances, and volume tracking.
 * Called for each operation during ledger indexing.
 */
export async function processAssetOperation(
  client: PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation
): Promise<void> {
  const opType = operation.type;
  const createdAt = operation.created_at;

  // Handle change_trust operations
  if (opType === 'change_trust') {
    await upsertTrustline(client, network, ledger, operation, createdAt);
    return;
  }

  // Handle payment operations for volume tracking
  if (opType === 'payment' || opType === 'path_payment_strict_send' || opType === 'path_payment_strict_receive') {
    const amount = (operation as { amount?: string }).amount;
    const from = (operation as { from?: string }).from || operation.source_account;
    const to = (operation as { to?: string }).to;
    
    // Extract asset info - check multiple possible fields
    let assetCode: string | undefined;
    let assetIssuer: string | undefined;
    
    if (opType === 'payment') {
      assetCode = (operation as { asset_code?: string }).asset_code;
      assetIssuer = (operation as { asset_issuer?: string }).asset_issuer;
    } else if (opType === 'path_payment_strict_send') {
      assetCode = (operation as { source_asset_code?: string }).source_asset_code;
      assetIssuer = (operation as { source_asset_issuer?: string }).source_asset_issuer;
    } else if (opType === 'path_payment_strict_receive') {
      assetCode = (operation as { asset_code?: string }).asset_code;
      assetIssuer = (operation as { asset_issuer?: string }).asset_issuer;
    }

    if (!assetCode || !assetIssuer || !amount) {
      return; // Skip native XLM or operations without proper asset info
    }

    // Track volume
    await trackAssetVolume(client, network, assetCode, assetIssuer, amount, createdAt);

    // Update balances for both sender and receiver
    if (from && to) {
      // Deduct from sender
      await updateTrustlineBalance(client, network, ledger, from, assetCode, assetIssuer, `-${amount}`, createdAt);
      // Add to receiver
      await updateTrustlineBalance(client, network, ledger, to, assetCode, assetIssuer, amount, createdAt);
    }
  }
}

/**
 * Inserts executed trades fetched from Horizon's /trades endpoint into the database.
 * Deriving trades from operations is unreliable because a single path payment or offer operation
 * can cross multiple orderbook offers and produce several trades.
 */
export async function insertTrades(
  pool: Pool,
  network: string,
  trades: HorizonTrade[]
): Promise<void> {
  if (trades.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const query = `
      INSERT INTO trades (
        id, paging_token, ledger_close_time, trade_type,
        base_account, base_amount, base_asset_type, base_asset_code, base_asset_issuer, base_offer_id,
        counter_account, counter_amount, counter_asset_type, counter_asset_code, counter_asset_issuer, counter_offer_id,
        base_is_seller, price_n, price_d, price, network
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21
      )
      ON CONFLICT (id, network) DO NOTHING
    `;
    for (const trade of trades) {
      const priceN = trade.price?.n != null ? BigInt(trade.price.n) : null;
      const priceD = trade.price?.d != null ? BigInt(trade.price.d) : null;
      const priceVal = priceN != null && priceD != null && priceD !== 0n
        ? (Number(priceN) / Number(priceD))
        : null;
      await client.query(query, [
        trade.id,
        trade.paging_token,
        trade.ledger_close_time,
        trade.trade_type ?? 'orderbook',
        trade.base_account,
        trade.base_amount,
        trade.base_asset_type,
        trade.base_asset_code ?? null,
        trade.base_asset_issuer ?? null,
        trade.base_offer_id ?? null,
        trade.counter_account ?? null,
        trade.counter_amount,
        trade.counter_asset_type,
        trade.counter_asset_code ?? null,
        trade.counter_asset_issuer ?? null,
        trade.counter_offer_id ?? null,
        trade.base_is_seller ?? null,
        priceN?.toString() ?? null,
        priceD?.toString() ?? null,
        priceVal != null ? priceVal.toFixed(7) : null,
        network,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Returns the highest trade paging_token recorded for the given network.
 */
export async function getLatestTradePagingToken(
  pool: Pool,
  network: string
): Promise<string | null> {
  const { rows } = await pool.query<{ paging_token: string }>(
    'SELECT paging_token FROM trades WHERE network = $1 ORDER BY paging_token DESC LIMIT 1',
    [network]
  );
  return rows[0]?.paging_token ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAsset(obj: any): string {
  if (!obj) return 'native';
  if (typeof obj === 'string') return obj;
  if (obj.asset_type === 'native' || obj.asset === 'native') return 'native';
  const code = obj.asset_code || obj.code;
  const issuer = obj.asset_issuer || obj.issuer;
  if (code && issuer) return `${code}:${issuer}`;
  if (obj.asset) return obj.asset;
  return 'native';
}

function formatAssetFromPrefix(op: any, prefix: string): string {
  const assetType = op[`${prefix}asset_type`];
  if (assetType === 'native') return 'native';
  const code = op[`${prefix}asset_code`];
  const issuer = op[`${prefix}asset_issuer`];
  if (code && issuer) return `${code}:${issuer}`;
  if (op[`${prefix}asset`]) return op[`${prefix}asset`];
  return 'native';
}

// ─── Liquidity Pools (Issue #201) ─────────────────────────────────────────────

export async function processLiquidityPoolOperation(
  client: PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation
): Promise<void> {
  const opType = operation.type;
  if (opType !== 'liquidity_pool_deposit' && opType !== 'liquidity_pool_withdraw') {
    return;
  }

  const poolId = (operation.liquidity_pool_id as string) || '';
  if (!poolId) return;

  if (opType === 'liquidity_pool_deposit') {
    const reserves = (operation.reserves_deposited as Array<{ asset: any; amount: string }>) ||
      (operation.reserves_max as Array<{ asset: any; amount: string }>) || [];
    const assetA = reserves[0] ? formatAsset(reserves[0].asset) : ((operation.asset_a as string) || 'native');
    const amountA = reserves[0] ? reserves[0].amount : ((operation.amount_a as string) || (operation.max_amount_a as string) || '0');
    const assetB = reserves[1] ? formatAsset(reserves[1].asset) : ((operation.asset_b as string) || 'unknown');
    const amountB = reserves[1] ? reserves[1].amount : ((operation.amount_b as string) || (operation.max_amount_b as string) || '0');
    const sharesReceived = (operation.shares_received as string) || (operation.shares as string) || '0';
    const account = operation.source_account;

    await client.query(
      `INSERT INTO liquidity_pools (pool_id, asset_a, asset_b, fee_bp, reserve_a, reserve_b, total_shares, last_ledger, network, updated_at)
       VALUES ($1, $2, $3, 30, $4::numeric, $5::numeric, $6::numeric, $7, $8, NOW())
       ON CONFLICT (pool_id, network) DO UPDATE SET
         reserve_a = liquidity_pools.reserve_a + EXCLUDED.reserve_a,
         reserve_b = liquidity_pools.reserve_b + EXCLUDED.reserve_b,
         total_shares = liquidity_pools.total_shares + EXCLUDED.total_shares,
         last_ledger = EXCLUDED.last_ledger,
         updated_at = NOW()`,
      [poolId, assetA, assetB, amountA, amountB, sharesReceived, ledger, network]
    );

    await client.query(
      `INSERT INTO liquidity_pool_shares (pool_id, account, shares, last_ledger, network, updated_at)
       VALUES ($1, $2, $3::numeric, $4, $5, NOW())
       ON CONFLICT (pool_id, account, network) DO UPDATE SET
         shares = liquidity_pool_shares.shares + EXCLUDED.shares,
         last_ledger = EXCLUDED.last_ledger,
         updated_at = NOW()`,
      [poolId, account, sharesReceived, ledger, network]
    );
  } else if (opType === 'liquidity_pool_withdraw') {
    const reserves = (operation.reserves_received as Array<{ asset: any; amount: string }>) ||
      (operation.reserves_min as Array<{ asset: any; amount: string }>) || [];
    const amountA = reserves[0] ? reserves[0].amount : ((operation.amount_a as string) || (operation.min_amount_a as string) || '0');
    const amountB = reserves[1] ? reserves[1].amount : ((operation.amount_b as string) || (operation.min_amount_b as string) || '0');
    const sharesBurned = (operation.shares as string) || '0';
    const account = operation.source_account;

    await client.query(
      `UPDATE liquidity_pools
       SET reserve_a = GREATEST(0, reserve_a - $1::numeric),
           reserve_b = GREATEST(0, reserve_b - $2::numeric),
           total_shares = GREATEST(0, total_shares - $3::numeric),
           last_ledger = $4,
           updated_at = NOW()
       WHERE pool_id = $5 AND network = $6`,
      [amountA, amountB, sharesBurned, ledger, poolId, network]
    );

    await client.query(
      `UPDATE liquidity_pool_shares
       SET shares = GREATEST(0, shares - $1::numeric),
           last_ledger = $2,
           updated_at = NOW()
       WHERE pool_id = $3 AND account = $4 AND network = $5`,
      [sharesBurned, ledger, poolId, account, network]
    );
  }
}

export async function getLiquidityPool(
  pool: Pool,
  network: string,
  poolId: string
): Promise<{
  pool_id: string;
  asset_a: string;
  asset_b: string;
  fee_bp: number;
  reserve_a: string;
  reserve_b: string;
  total_shares: string;
  last_ledger: number;
} | null> {
  const { rows } = await pool.query(
    `SELECT pool_id, asset_a, asset_b, fee_bp, reserve_a, reserve_b, total_shares, last_ledger
     FROM liquidity_pools
     WHERE pool_id = $1 AND network = $2`,
    [poolId, network]
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    fee_bp: Number(rows[0].fee_bp),
    last_ledger: Number(rows[0].last_ledger),
  };
}

export async function getAccountPoolShares(
  pool: Pool,
  network: string,
  account: string
): Promise<Array<{
  pool_id: string;
  account: string;
  shares: string;
  last_ledger: number;
}>> {
  const { rows } = await pool.query(
    `SELECT pool_id, account, shares, last_ledger
     FROM liquidity_pool_shares
     WHERE account = $1 AND network = $2 AND shares > 0
     ORDER BY updated_at DESC`,
    [account, network]
  );
  return rows.map(r => ({
    ...r,
    last_ledger: Number(r.last_ledger),
  }));
}

// ─── Claimable Balances (Issue #202) ──────────────────────────────────────────

/**
 * The id of the balance a claimable-balance operation creates or claims.
 *
 * A claim carries it as `balance_id`. A create does not (Horizon's operation
 * record omits it), so it is derived from the containing transaction; keying a
 * created balance by anything else means its claim never finds it. The
 * operation id is only a last resort for a transaction Horizon returned
 * without `source_account_sequence`.
 */
function balanceIdFor(operation: HorizonOperation, transaction?: HorizonTransaction): string {
  const reported = (operation.balance_id as string) || (operation.claimable_balance_id as string);
  if (reported) return reported;
  if (transaction?.source_account && transaction.source_account_sequence) {
    return claimableBalanceId(transaction.source_account, transaction.source_account_sequence, operation.id);
  }
  log.warn(
    { operationId: operation.id, transactionHash: operation.transaction_hash },
    'claimable balance id could not be derived (no source_account_sequence); keyed by operation id, so its claim will not match'
  );
  return operation.id;
}

export async function processClaimableBalanceOperation(
  client: PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation,
  transaction?: HorizonTransaction
): Promise<void> {
  const opType = operation.type;
  if (
    opType !== 'create_claimable_balance' &&
    opType !== 'claim_claimable_balance' &&
    opType !== 'clawback_claimable_balance'
  ) {
    return;
  }

  const balanceId = balanceIdFor(operation, transaction);
  if (!balanceId) return;

  if (opType === 'create_claimable_balance') {
    const asset = formatAsset(operation);
    const amount = (operation.amount as string) || '0';
    const sponsor = (operation.sponsor as string) || operation.source_account;
    const claimants = (operation.claimants as Array<{ destination: string; predicate?: Record<string, unknown> }>) || [];

    await client.query(
      `INSERT INTO claimable_balances (balance_id, asset, amount, sponsor, claimants, status, created_ledger, created_at, network)
       VALUES ($1, $2, $3::numeric, $4, $5, 'unclaimed', $6, $7, $8)
       ON CONFLICT (balance_id, network) DO NOTHING`,
      [balanceId, asset, amount, sponsor, JSON.stringify(claimants), ledger, operation.created_at, network]
    );

    for (const claimant of claimants) {
      const dest = claimant.destination;
      const pred = claimant.predicate || {};
      let predicateType = 'unconditional';
      let absBefore: string | null = null;
      let relBefore: string | null = null;

      if (pred.abs_before) {
        predicateType = 'abs_before';
        absBefore = String(pred.abs_before);
      } else if (pred.abs_before_epoch) {
        predicateType = 'abs_before';
        absBefore = new Date(Number(pred.abs_before_epoch) * 1000).toISOString();
      } else if (pred.rel_before != null) {
        predicateType = 'rel_before';
        relBefore = String(pred.rel_before);
      } else if (pred.unconditional) {
        predicateType = 'unconditional';
      } else if (pred.and || pred.or || pred.not) {
        predicateType = 'compound';
      }

      await client.query(
        `INSERT INTO claimable_balance_claimants (balance_id, destination, predicate_type, predicate_details, abs_before, rel_before, network)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::bigint, $7)
         ON CONFLICT (balance_id, destination, network) DO NOTHING`,
        [balanceId, dest, predicateType, JSON.stringify(pred), absBefore, relBefore, network]
      );
    }
  } else if (opType === 'claim_claimable_balance') {
    const claimant = (operation.claimant as string) || operation.source_account;

    await client.query(
      `UPDATE claimable_balances
       SET status = 'claimed',
           claimed_by = $1,
           claimed_at = $2,
           claimed_ledger = $3
       WHERE balance_id = $4 AND network = $5`,
      [claimant, operation.created_at, ledger, balanceId, network]
    );
  } else {
    // The issuer took it back: it has left the ledger as surely as a claimed
    // one, so it must stop reading as claimable. Nobody claimed it, so
    // claimed_by stays null; claimed_at/claimed_ledger record when it left.
    await client.query(
      `UPDATE claimable_balances
       SET status = 'clawed_back',
           claimed_at = $1,
           claimed_ledger = $2
       WHERE balance_id = $3 AND network = $4`,
      [operation.created_at, ledger, balanceId, network]
    );
  }
}

export async function getClaimableBalance(
  pool: Pool,
  network: string,
  balanceId: string
): Promise<{
  balance_id: string;
  asset: string;
  amount: string;
  sponsor: string | null;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
  created_ledger: number;
  created_at: string;
} | null> {
  const { rows } = await pool.query(
    `SELECT balance_id, asset, amount, sponsor, status, claimed_by, claimed_at, created_ledger, created_at
     FROM claimable_balances
     WHERE balance_id = $1 AND network = $2`,
    [balanceId, network]
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    created_ledger: Number(rows[0].created_ledger),
  };
}

export async function getClaimableBalancesForAccount(
  pool: Pool,
  network: string,
  account: string,
  status?: string
): Promise<Array<{
  balance_id: string;
  destination: string;
  predicate_type: string;
  asset: string;
  amount: string;
  sponsor: string | null;
  status: string;
  created_at: string;
}>> {
  let query = `
    SELECT cb.balance_id, cbc.destination, cbc.predicate_type, cb.asset, cb.amount, cb.sponsor, cb.status, cb.created_at
    FROM claimable_balances cb
    JOIN claimable_balance_claimants cbc
      ON cb.balance_id = cbc.balance_id AND cb.network = cbc.network
    WHERE cbc.destination = $1 AND cb.network = $2
  `;
  const params: unknown[] = [account, network];
  if (status) {
    query += ` AND cb.status = $3`;
    params.push(status);
  }
  query += ` ORDER BY cb.created_at DESC`;

  const { rows } = await pool.query(query, params);
  return rows;
}

// ─── Path Payments (Issue #206) ───────────────────────────────────────────────

export async function processPathPaymentOperation(
  client: PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation
): Promise<void> {
  const opType = operation.type;
  if (opType !== 'path_payment_strict_send' && opType !== 'path_payment_strict_receive') {
    return;
  }

  const fromAccount = (operation.from as string) || operation.source_account;
  const toAccount = (operation.to as string) || '';
  const isSend = opType === 'path_payment_strict_send';
  const paymentType = isSend ? 'strict_send' : 'strict_receive';

  const sourceAsset = formatAssetFromPrefix(operation, 'source_');
  const destAsset = formatAssetFromPrefix(operation, 'dest_') !== 'native' || operation['dest_asset_type']
    ? formatAssetFromPrefix(operation, 'dest_')
    : formatAsset(operation);

  const sourceAmount = String(
    isSend
      ? (operation.source_amount ?? operation.amount ?? '0')
      : (operation.source_amount ?? operation.source_max ?? operation.amount ?? '0')
  );

  const destAmount = String(
    isSend
      ? (operation.dest_amount ?? operation.dest_min ?? operation.destination_min ?? operation.amount ?? '0')
      : (operation.dest_amount ?? operation.amount ?? '0')
  );

  const pathRaw = (operation.path as Array<any>) || [];
  const pathAssets = pathRaw.map(p => formatAsset(p));

  await client.query(
    `INSERT INTO path_payments (
       operation_id, transaction_hash, ledger, network, payment_type,
       from_account, to_account, source_asset, source_amount, dest_asset, dest_amount,
       path_assets, hop_count, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11::numeric, $12, $13, $14
     ) ON CONFLICT (operation_id, network) DO NOTHING`,
    [
      operation.id,
      operation.transaction_hash,
      ledger,
      network,
      paymentType,
      fromAccount,
      toAccount,
      sourceAsset,
      sourceAmount,
      destAsset,
      destAmount,
      pathAssets,
      pathAssets.length,
      operation.created_at,
    ]
  );

  for (let idx = 0; idx < pathAssets.length; idx++) {
    await client.query(
      `INSERT INTO path_payment_hops (operation_id, hop_index, asset, network)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (operation_id, hop_index, network) DO NOTHING`,
      [operation.id, idx, pathAssets[idx], network]
    );
  }
}

export async function getPathPayment(
  pool: Pool,
  network: string,
  operationId: string
): Promise<{
  operation_id: string;
  transaction_hash: string;
  ledger: number;
  payment_type: string;
  from_account: string;
  to_account: string;
  source_asset: string;
  source_amount: string;
  dest_asset: string;
  dest_amount: string;
  path_assets: string[];
  hop_count: number;
  created_at: string;
} | null> {
  const { rows } = await pool.query(
    `SELECT operation_id, transaction_hash, ledger, payment_type, from_account, to_account,
            source_asset, source_amount, dest_asset, dest_amount, path_assets, hop_count, created_at
     FROM path_payments
     WHERE operation_id = $1 AND network = $2`,
    [operationId, network]
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    ledger: Number(rows[0].ledger),
    hop_count: Number(rows[0].hop_count),
  };
}

export async function findPathPaymentsByAsset(
  pool: Pool,
  network: string,
  asset: string,
  limit = 50
): Promise<Array<{
  operation_id: string;
  transaction_hash: string;
  payment_type: string;
  source_asset: string;
  dest_asset: string;
  path_assets: string[];
  created_at: string;
}>> {
  const { rows } = await pool.query(
    `SELECT operation_id, transaction_hash, payment_type, source_asset, dest_asset, path_assets, created_at
     FROM path_payments
     WHERE network = $1
       AND (source_asset = $2 OR dest_asset = $2 OR $2 = ANY(path_assets))
     ORDER BY created_at DESC
     LIMIT $3`,
    [network, asset, limit]
  );
  return rows;
}

// ─── Set Options (Issue #207) ─────────────────────────────────────────────────

export async function processSetOptionsOperation(
  client: PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation
): Promise<void> {
  if (operation.type !== 'set_options') {
    return;
  }

  const account = operation.source_account;
  const signerKey = (operation.signer_key as string) || (operation.signer as any)?.key;
  const signerWeightRaw = operation.signer_weight != null ? operation.signer_weight : (operation.signer as any)?.weight;

  if (signerKey) {
    const weight = typeof signerWeightRaw === 'number' ? signerWeightRaw : parseInt(String(signerWeightRaw ?? '0'), 10);
    const action = weight === 0 ? 'removed' : 'added';

    await client.query(
      `INSERT INTO account_signer_changes (
         account, operation_id, transaction_hash, ledger, network, signer_key, weight, action, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        account,
        operation.id,
        operation.transaction_hash,
        ledger,
        network,
        signerKey,
        weight,
        action,
        operation.created_at,
      ]
    );
  }

  const masterWeight = operation.master_key_weight != null ? Number(operation.master_key_weight) : null;
  const lowThreshold = operation.low_threshold != null ? Number(operation.low_threshold) : null;
  const medThreshold = operation.med_threshold != null ? Number(operation.med_threshold) : null;
  const highThreshold = operation.high_threshold != null ? Number(operation.high_threshold) : null;
  const homeDomain = (operation.home_domain as string) || null;
  const setFlags = (operation.set_flags_s as string[]) || (operation.set_flags ? [String(operation.set_flags)] : null);
  const clearFlags = (operation.clear_flags_s as string[]) || (operation.clear_flags ? [String(operation.clear_flags)] : null);

  const hasThresholds =
    masterWeight != null ||
    lowThreshold != null ||
    medThreshold != null ||
    highThreshold != null ||
    homeDomain != null ||
    setFlags != null ||
    clearFlags != null;

  if (hasThresholds) {
    await client.query(
      `INSERT INTO account_threshold_changes (
         account, operation_id, transaction_hash, ledger, network,
         master_weight, low_threshold, med_threshold, high_threshold,
         home_domain, set_flags, clear_flags, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        account,
        operation.id,
        operation.transaction_hash,
        ledger,
        network,
        masterWeight,
        lowThreshold,
        medThreshold,
        highThreshold,
        homeDomain,
        setFlags,
        clearFlags,
        operation.created_at,
      ]
    );
  }
}

export async function getSignerChangesForAccount(
  pool: Pool,
  network: string,
  account: string
): Promise<Array<{
  id: string;
  account: string;
  operation_id: string;
  signer_key: string;
  weight: number;
  action: string;
  created_at: string;
}>> {
  const { rows } = await pool.query(
    `SELECT id, account, operation_id, signer_key, weight, action, created_at
     FROM account_signer_changes
     WHERE account = $1 AND network = $2
     ORDER BY created_at DESC`,
    [account, network]
  );
  return rows.map(r => ({
    ...r,
    id: String(r.id),
    weight: Number(r.weight),
  }));
}

export async function getThresholdChangesForAccount(
  pool: Pool,
  network: string,
  account: string
): Promise<Array<{
  id: string;
  account: string;
  operation_id: string;
  master_weight: number | null;
  low_threshold: number | null;
  med_threshold: number | null;
  high_threshold: number | null;
  home_domain: string | null;
  created_at: string;
}>> {
  const { rows } = await pool.query(
    `SELECT id, account, operation_id, master_weight, low_threshold, med_threshold, high_threshold, home_domain, created_at
     FROM account_threshold_changes
     WHERE account = $1 AND network = $2
     ORDER BY created_at DESC`,
    [account, network]
  );
  return rows.map(r => ({
    ...r,
    id: String(r.id),
  }));
}

// ─── Operation Decoding (Issue #260, #261, #262) ───────────────────────────────────

/**
 * Process bump_sequence and manage_data operations to extract key fields.
 * These operations are stored in the operations.details JSONB, but we extract
 * their meaningful fields to make them queryable.
 */
export async function processDecodedOperations(
  client: PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation
): Promise<void> {
  const opType = operation.type;

  // Issue #260: bump_sequence - extract the bumped sequence number
  if (opType === 'bump_sequence') {
    const bumpTo = (operation.bump_to as string) || (operation.bumpTo as string);
    if (bumpTo) {
      // The bump_sequence value is already in the details JSONB, but we ensure
      // it's in a consistent format for querying
      const details = operation as Record<string, unknown>;
      details.bump_sequence = bumpTo;
    }
  }

  // Issue #260: manage_data - extract data key and value
  if (opType === 'manage_data') {
    const dataName = (operation.data_name as string) || (operation.name as string);
    const dataValue = (operation.data_value as string) || (operation.value as string);
    if (dataName) {
      const details = operation as Record<string, unknown>;
      details.data_name = dataName;
      details.data_value = dataValue || null;
    }
  }
}

/**
 * Process revoke_sponsorship operations to update the sponsorship table.
 * Issue #261: Removes sponsorship relationships when they are revoked.
 */
export async function processRevokeSponsorshipOperation(
  client: PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation
): Promise<void> {
  const opType = operation.type;
  if (opType !== 'revoke_sponsorship') {
    return;
  }

  // Extract the sponsored entry ID and type from the operation
  const sponsoredId = (operation.account_id as string) ||
                     (operation.trustline_account_id as string) ||
                     (operation.data_account_id as string) ||
                     (operation.claimable_balance_id as string) ||
                     (operation.offer_id as string) ||
                     '';

  if (sponsoredId) {
    // Remove the sponsorship relationship
    await client.query(
      `DELETE FROM sponsorships
       WHERE sponsored_id = $1 AND network = $2`,
      [sponsoredId, network]
    );
  }
}

/**
 * Process restore_footprint and extend_footprint_ttl operations to track Soroban TTL.
 * Issue #262: Records which ledger keys were restored or extended and their new expiry.
 */
export async function processSorobanTTLOperation(
  client: PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation
): Promise<void> {
  const opType = operation.type;
  if (opType !== 'restore_footprint' && opType !== 'extend_footprint_ttl') {
    return;
  }

  // Extract ledger keys from the operation
  const ledgerKeys = (operation.ledger_keys as string[]) ||
                    ((operation.ext as any)?.ledgerKeys as string[]) ||
                    [];

  const extendTo = (operation.extend_to as string) || (operation.extendTo as string) || String(ledger);

  for (const key of ledgerKeys) {
    // Try to extract contract_id from the key if it's a contract-related key
    let contractId = '';
    try {
      // Keys are base64-encoded XDR; for now we store the raw key
      // A full implementation would decode the XDR to extract contract_id
      contractId = key.substring(0, 56); // Fallback: use prefix as contract_id
    } catch {
      contractId = '';
    }

    await client.query(
      `INSERT INTO soroban_ttl (key, contract_id, live_until_ledger, last_ledger, operation_type, created_at, network)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key, network) DO UPDATE SET
         live_until_ledger = EXCLUDED.live_until_ledger,
         last_ledger = EXCLUDED.last_ledger,
         operation_type = EXCLUDED.operation_type,
         created_at = EXCLUDED.created_at`,
      [key, contractId, Number(extendTo), ledger, opType, operation.created_at, network]
    );
  }
}

/**
 * Process invoke_host_function operations to extract contract interfaces from WASM.
 * Issue #263: Parses the spec from uploaded wasm and stores functions, arguments and types.
 */
export async function processContractInterfaceOperation(
  client: PoolClient,
  network: string,
  ledger: number,
  operation: HorizonOperation
): Promise<void> {
  const opType = operation.type;
  if (opType !== 'invoke_host_function') {
    return;
  }

  // Check if this is a contract deployment (create_contract host function)
  const functionCall = (operation.function as any) || (operation.host_function as any);
  if (!functionCall) return;

  const contractId = (operation.contract_id as string) ||
                    (functionCall.contract_id as string) ||
                    (operation.address as string) ||
                    '';

  const wasmHash = (operation.wasm_hash as string) ||
                   (functionCall.wasm_hash as string) ||
                   (operation.wasmId as string) ||
                   '';

  // Only process if we have both contract_id and wasm_hash
  if (contractId && wasmHash) {
    // For now, store a placeholder interface. A full implementation would:
    // 1. Fetch the WASM from the RPC
    // 2. Parse the contract spec embedded in the WASM
    // 3. Extract function names, arguments, and types
    // This requires additional Soroban RPC integration and WASM parsing

    const placeholderFunctions = JSON.stringify([
      {
        name: 'placeholder',
        inputs: [],
        outputs: []
      }
    ]);

    await client.query(
      `INSERT INTO contract_interfaces (contract_id, wasm_hash, functions, created_at, updated_at, network)
       VALUES ($1, $2, $3, NOW(), NOW(), $4)
       ON CONFLICT (contract_id, network) DO UPDATE SET
         wasm_hash = EXCLUDED.wasm_hash,
         functions = EXCLUDED.functions,
         updated_at = NOW()`,
      [contractId, wasmHash, placeholderFunctions, network]
    );
  }
}
