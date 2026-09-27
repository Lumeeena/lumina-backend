import { Pool, PoolClient, type PoolConfig } from 'pg';
import type { HorizonAccount, HorizonLedger, HorizonOperation, HorizonTransaction } from './horizon';
import type { ContractEvent, ContractStorageEntry } from './soroban';
import { notifyIndexed } from './notify';
import { subsystem } from './logger';
import { indexerPoolErrors } from './metrics';

const log = subsystem('db');
import { parseContractSchema, type ContractSchema } from './customSchema';
import type { DecodedCustomEvent } from './customDecode';

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
 * Pool factory with the idle-client error handled.
 *
 * Postgres emits `error` on the pool when a client dies while idle. With no
 * listener that is an unhandled `'error'` event — the process dies — so the
 * handler logs it and counts it; the pool replaces the client itself.
 */
export function createPool(databaseUrl: string, options?: PoolConfig): Pool {
  const pool = new Pool({ connectionString: databaseUrl, ...options });
  pool.on('error', err => {
    indexerPoolErrors.inc();
    log.error({ err: err.message }, 'unexpected PostgreSQL pool client error; pool will replace the client');
  });
  return pool;
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
      if (account) await upsertAccount(client, network, account);
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count, base_fee, base_reserve, network)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (sequence, network) DO NOTHING`,
      [
        ledger.sequence,
        ledger.closed_at,
        ledger.successful_transaction_count + ledger.failed_transaction_count,
        ledger.operation_count,
        ledger.base_fee_in_stroops,
        ledger.base_reserve_in_stroops,
        network,
      ]
    );

    for (const tx of transactions) {
      await client.query(
        `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo, network)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (hash, network) DO NOTHING`,
        [
          tx.hash,
          tx.ledger,
          tx.created_at,
          tx.source_account,
          tx.fee_charged,
          tx.operation_count,
          tx.successful,
          tx.memo_type,
          tx.memo ?? null,
          network,
        ]
      );
    }

    for (const op of operations) {
      // ON CONFLICT target includes the network and partition key: operations is
      // partitioned by ledger (see db/migrations/006_partition_operations.sql),
      // and Postgres requires a partitioned table's unique constraints to
      // include the partition key. This isn't a behavior change — a given
      // operation id is only ever written with one ledger value.
      await client.query(
        `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details, network)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id, ledger, network) DO NOTHING`,
        [op.id, op.type, op.transaction_hash, ledger.sequence, op.created_at, op.source_account, JSON.stringify(op), network]
      );
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
  await client.query(
    `INSERT INTO accounts (address, sequence, subentry_count, last_modified_ledger, num_sponsored, num_sponsoring, balances, flags, thresholds, updated_at, network)
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
    [
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
    ]
  );
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
      await pool.query(
        `INSERT INTO contract_events (id, type, contract_id, ledger, created_at, paging_token, topics, value, network)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id, network) DO NOTHING`,
        [
          event.id,
          event.type,
          event.contractId,
          event.ledger,
          event.createdAt,
          event.pagingToken,
          event.topics,
          event.value === undefined ? null : JSON.stringify(event.value),
          network,
        ]
      );
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

