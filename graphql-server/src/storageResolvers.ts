/**
 * Contract storage resolvers (Issue #9).
 * Lightweight stubs - full XDR parsing in indexer/contractStorage.ts
 */
import type { Context } from './resolvers';

export const storageResolvers = {
  Query: {
    async contractStorage(_: any, { network, contractId, key }: any, { db }: Context) {
      const result = await db.query(
        `SELECT contract_id, storage_key, storage_value, durability, last_changed_ledger
         FROM contract_storage
         WHERE contract_id = $1 AND storage_key = $2 AND network = $3
         LIMIT 1`,
        [contractId, JSON.stringify(key), network || 'mainnet']
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        contractId: row.contract_id,
        storageKey: JSON.parse(row.storage_key),
        storageValue: JSON.parse(row.storage_value),
        durability: row.durability.toUpperCase(),
        lastChangedLedger: row.last_changed_ledger
      };
    },

    async contractStorageEntries(_: any, { network, contractId, limit }: any, { db }: Context) {
      limit = Math.min(limit || 100, 1000);

      const result = await db.query(
        `SELECT contract_id, storage_key, storage_value, durability, last_changed_ledger
         FROM contract_storage
         WHERE contract_id = $1 AND network = $2
         ORDER BY last_changed_ledger DESC
         LIMIT $3`,
        [contractId, network || 'mainnet', limit + 1]
      );

      const hasMore = result.rows.length > limit;
      const data = result.rows.slice(0, limit).map(row => ({
        contractId: row.contract_id,
        storageKey: JSON.parse(row.storage_key),
        storageValue: JSON.parse(row.storage_value),
        durability: row.durability.toUpperCase(),
        lastChangedLedger: row.last_changed_ledger
      }));

      return {
        data,
        hasMore,
        cursor: hasMore ? data[data.length - 1].lastChangedLedger.toString() : null
      };
    }
  }
};
