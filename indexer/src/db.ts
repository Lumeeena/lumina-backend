import { Pool, PoolClient, type PoolConfig } from 'pg';
import type { HorizonAccount, HorizonLedger, HorizonOperation, HorizonTransaction } from './horizon';
import type { ContractEvent } from './soroban';
import { notifyIndexed } from './notify';
import { subsystem } from './logger';
import { indexerPoolErrors } from './metrics';

const log = subsystem('db');
import { parseContractSchema, type ContractSchema } from './customSchema';
import type { DecodedCustomEvent } from './customDecode';

export function createPool(databaseUrl: string, options?: PoolConfig): Pool {
  return new Pool({ connectionString: databaseUrl, ...options });
}

export async function getLatestIndexedLedger(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ max: string | null }>('SELECT MAX(sequence) AS max FROM ledgers');
  return rows[0].max ? Number(rows[0].max) : 0;
}

/**
 * Writes a ledger and all of its transactions/operations in a single DB
 * transaction, so a crash mid-ledger leaves no partial rows behind — the
 * ledger sequence simply gets re-fetched and re-indexed on restart.
 */
export async function indexLedger(
  pool: Pool,
  ledger: HorizonLedger,
  transactions: HorizonTransaction[],
  operations: HorizonOperation[],
  accounts: HorizonAccount[] = []
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count, base_fee, base_reserve)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sequence) DO NOTHING`,
      [
        ledger.sequence,
        ledger.closed_at,
        ledger.successful_transaction_count + ledger.failed_transaction_count,
        ledger.operation_count,
        ledger.base_fee_in_stroops,
        ledger.base_reserve_in_stroops,
      ]
    );

    for (const tx of transactions) {
      await client.query(
        `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (hash) DO NOTHING`,
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
        ]
      );
    }

    for (const op of operations) {
      await client.query(
        `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [op.id, op.type, op.transaction_hash, ledger.sequence, op.created_at, op.source_account, JSON.stringify(op)]
      );
    }

    for (const account of accounts) {
      await upsertAccount(client, account);
    }

    // Queued inside the transaction on purpose: Postgres delivers notifications
    // at commit, so a rolled-back ledger announces nothing and no subscriber is
    // ever told about rows that did not land.
    await notifyIndexed(client, {
      kind: 'ledger',
      ledger: ledger.sequence,
      transactions: transactions.length,
      operations: operations.length,
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function upsertAccount(client: PoolClient, account: HorizonAccount): Promise<void> {
  await client.query(
    `INSERT INTO accounts (address, sequence, subentry_count, last_modified_ledger, num_sponsored, num_sponsoring, balances, flags, thresholds, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (address) DO UPDATE SET
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
    ]
  );
}

export async function insertContractEvents(pool: Pool, events: ContractEvent[]): Promise<void> {
  if (events.length === 0) return;

  // Events arrive from Soroban RPC on their own cadence, keyed by the ledger
  // they were emitted in — so the notification names the highest ledger in the
  // batch, which is what a subscriber would read up to.
  let highestLedger = 0;

  for (const event of events) {
    await pool.query(
      `INSERT INTO contract_events (id, type, contract_id, ledger, created_at, paging_token, topics, value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.type,
        event.contractId,
        event.ledger,
        event.createdAt,
        event.pagingToken,
        event.topics,
        event.value === undefined ? null : JSON.stringify(event.value),
      ]
    );
    if (event.ledger > highestLedger) highestLedger = event.ledger;
  }

  await notifyIndexed(pool, {
    kind: 'events',
    ledger: highestLedger,
    events: events.length,
  });
}

export async function getLatestIndexedEventLedger(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ max: string | null }>('SELECT MAX(ledger) AS max FROM contract_events');
  return rows[0].max ? Number(rows[0].max) : 0;
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
export async function loadContractSchemas(pool: Pool): Promise<Map<string, ContractSchema>> {
  const { rows } = await pool.query<{ contract_id: string; definition: unknown }>(
    'SELECT contract_id, definition FROM contract_schemas'
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
export async function upsertContractSchema(pool: Pool, schema: ContractSchema): Promise<void> {
  await pool.query(
    `INSERT INTO contract_schemas (contract_id, version, definition, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (contract_id) DO UPDATE SET
       version = EXCLUDED.version,
       definition = EXCLUDED.definition,
       updated_at = NOW()`,
    [schema.contractId, schema.version, JSON.stringify(schema)]
  );
}

export async function deleteContractSchema(pool: Pool, contractId: string): Promise<void> {
  await pool.query('DELETE FROM contract_schemas WHERE contract_id = $1', [contractId]);
}

/**
 * Store decoded events.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING`, unlike the generic event
 * insert: re-indexing the same event after a schema revision should produce the
 * new decoding, and the old row would otherwise survive forever.
 */
export async function insertCustomEvents(pool: Pool, events: DecodedCustomEvent[]): Promise<void> {
  if (events.length === 0) return;

  for (const event of events) {
    await pool.query(
      `INSERT INTO custom_events
         (event_id, contract_id, event_name, ledger, created_at, schema_version, fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id, event_name) DO UPDATE SET
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
      ]
    );
  }
}
