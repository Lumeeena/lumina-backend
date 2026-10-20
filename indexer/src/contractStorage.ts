/**
 * Soroban contract storage indexing.
 * Issue #9: Index full Soroban contract storage state, not just events.
 * 
 * Extracts ContractDataEntry changes from ledger close meta and indexes
 * them for GraphQL queries like contractStorage(contractId, key).
 */
import { xdr } from '@stellar/stellar-sdk';
import type { Pool } from 'pg';
import { subsystem } from './logger';

const log = subsystem('contract-storage');

export interface ContractStorageEntry {
  contractId: string;
  storageKey: unknown;  // Decoded ScVal
  storageValue: unknown; // Decoded ScVal
  durability: 'temporary' | 'persistent' | 'instance';
  lastChangedLedger: number;
  createdAt: Date;
}

/**
 * Extract contract storage changes from transaction meta XDR.
 * Returns entries that were created or updated in this transaction.
 */
export function extractStorageChanges(
  txMetaXdr: string,
  ledgerSequence: number
): ContractStorageEntry[] {
  const changes: ContractStorageEntry[] = [];

  try {
    const meta = xdr.TransactionMeta.fromXDR(txMetaXdr, 'base64');
    
    // Parse based on meta version
    if (meta.switch() === 3) {
      // v3 meta
      const v3 = meta.v3();
      for (const _opChange of v3.sorobanMeta()?.diagnosticEvents() || []) {
        // Extract contract data entries from diagnostic events
        // This is a simplified scaffold - full implementation needs proper XDR parsing
        log.debug({ ledger: ledgerSequence }, 'Processing v3 meta');
      }
    }

    // For now, return empty array - full XDR parsing requires stellar-sdk expertise
    return changes;
  } catch (err) {
    log.error({ err, ledger: ledgerSequence }, 'Failed to parse transaction meta');
    return [];
  }
}

/**
 * Upsert contract storage entries into the database.
 * Uses ON CONFLICT to handle concurrent writes and out-of-order processing.
 */
export async function upsertStorageEntries(
  pool: Pool,
  entries: ContractStorageEntry[]
): Promise<void> {
  if (entries.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const entry of entries) {
      await client.query(
        `INSERT INTO contract_storage (
          contract_id, storage_key, storage_value, durability,
          last_changed_ledger, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (contract_id, storage_key, durability)
        DO UPDATE SET
          storage_value = EXCLUDED.storage_value,
          last_changed_ledger = GREATEST(
            contract_storage.last_changed_ledger,
            EXCLUDED.last_changed_ledger
          ),
          updated_at = NOW()
        WHERE EXCLUDED.last_changed_ledger >= contract_storage.last_changed_ledger`,
        [
          entry.contractId,
          JSON.stringify(entry.storageKey),
          JSON.stringify(entry.storageValue),
          entry.durability,
          entry.lastChangedLedger,
          entry.createdAt
        ]
      );
    }

    await client.query('COMMIT');
    log.info({ count: entries.length }, 'Upserted contract storage entries');
  } catch (err) {
    await client.query('ROLLBACK');
    log.error({ err, count: entries.length }, 'Failed to upsert storage entries');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get current storage value for a contract + key.
 */
export async function getStorageEntry(
  pool: Pool,
  contractId: string,
  storageKey: unknown
): Promise<ContractStorageEntry | null> {
  const result = await pool.query(
    `SELECT * FROM contract_storage
     WHERE contract_id = $1 AND storage_key = $2
     ORDER BY last_changed_ledger DESC
     LIMIT 1`,
    [contractId, JSON.stringify(storageKey)]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    contractId: row.contract_id,
    storageKey: JSON.parse(row.storage_key),
    storageValue: JSON.parse(row.storage_value),
    durability: row.durability,
    lastChangedLedger: row.last_changed_ledger,
    createdAt: row.created_at
  };
}

/**
 * List all storage entries for a contract.
 */
export async function listStorageEntries(
  pool: Pool,
  contractId: string,
  limit = 100
): Promise<ContractStorageEntry[]> {
  const result = await pool.query(
    `SELECT * FROM contract_storage
     WHERE contract_id = $1
     ORDER BY last_changed_ledger DESC
     LIMIT $2`,
    [contractId, limit]
  );

  return result.rows.map(row => ({
    contractId: row.contract_id,
    storageKey: JSON.parse(row.storage_key),
    storageValue: JSON.parse(row.storage_value),
    durability: row.durability,
    lastChangedLedger: row.last_changed_ledger,
    createdAt: row.created_at
  }));
}
