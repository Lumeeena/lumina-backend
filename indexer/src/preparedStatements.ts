/**
 * Prepared statements for hot query paths.
 *
 * Prepared statements reduce parsing and planning overhead for frequently-executed
 * queries. The pg driver automatically prepares statements on first use, but
 * explicitly naming them ensures consistent reuse across connections.
 *
 * Note: Prepared statements are per-connection. With connection pooling, each
 * connection in the pool maintains its own prepared statement cache. This is
 * intentional - the overhead is small compared to the parsing/planning savings.
 */

import type { Pool, PoolClient } from 'pg';

/** Names of prepared statements for hot paths */
export const PREPARED_STATEMENTS = {
  INSERT_LEDGER: 'insert_ledger',
  INSERT_TRANSACTION: 'insert_transaction',
  INSERT_OPERATION: 'insert_operation',
  UPSERT_ACCOUNT: 'upsert_account',
  INSERT_CONTRACT_EVENT: 'insert_contract_event',
} as const;

/**
 * Prepare hot-path statements on a client.
 *
 * Called when a client is first acquired from the pool. Preparing these
 * statements upfront ensures they're available for the indexer's high-frequency
 * insert operations.
 */
export async function prepareHotPathStatements(client: PoolClient): Promise<void> {
  await client.query({
    name: PREPARED_STATEMENTS.INSERT_LEDGER,
    text: `INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count, base_fee, base_reserve, network)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (sequence, network) DO NOTHING`,
  });

  await client.query({
    name: PREPARED_STATEMENTS.INSERT_TRANSACTION,
    text: `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo, network)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (hash, network) DO NOTHING`,
  });

  await client.query({
    name: PREPARED_STATEMENTS.INSERT_OPERATION,
    text: `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details, network)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
  });

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
  });

  await client.query({
    name: PREPARED_STATEMENTS.INSERT_CONTRACT_EVENT,
    text: `INSERT INTO contract_events (id, type, contract_id, ledger, created_at, paging_token, topics, value, network)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id, network) DO NOTHING`,
  });
}

/**
 * Configure pool to prepare statements on connect.
 *
 * Attaches a handler that prepares hot-path statements whenever a new client
 * connects to the pool. This ensures every connection in the pool has the
 * prepared statements ready for use.
 */
export function configurePoolWithPreparedStatements(pool: Pool): void {
  pool.on('connect', async (client: PoolClient) => {
    try {
      await prepareHotPathStatements(client);
    } catch (err) {
      // If preparation fails, the connection is still usable - it will fall back
      // to automatic statement preparation on first query execution.
      console.error('Failed to prepare hot-path statements:', err);
    }
  });
}
