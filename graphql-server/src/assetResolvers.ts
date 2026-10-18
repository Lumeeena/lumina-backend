/**
 * Asset analytics resolvers (Issue #7).
 * Lightweight implementation - full aggregation logic in separate service.
 */
import type { Pool } from 'pg';
import type { Context } from './resolvers';

export const assetResolvers = {
  Query: {
    async asset(_: any, { network, code, issuer }: any, { db }: Context) {
      const result = await db.query(
        `SELECT asset_code as code, asset_issuer as issuer, holder_count,
                first_seen_ledger, last_activity_ledger
         FROM assets
         WHERE asset_code = $1 AND asset_issuer = $2 AND network = $3`,
        [code, issuer, network || 'mainnet']
      );
      
      if (result.rows.length === 0) return null;
      
      const row = result.rows[0];
      return {
        code: row.code,
        issuer: row.issuer,
        holderCount: row.holder_count,
        circulatingSupply: null, // TODO: compute from holder balances
        volume24h: null, // TODO: sum from asset_volume_hourly
        firstSeenLedger: row.first_seen_ledger,
        lastActivityLedger: row.last_activity_ledger
      };
    },

    async assets(_: any, { network, limit, cursor, sortBy }: any, { db }: Context) {
      limit = Math.min(limit || 20, 100);
      
      let orderBy = 'holder_count DESC';
      if (sortBy === 'VOLUME') orderBy = 'last_activity_ledger DESC'; // Placeholder
      if (sortBy === 'ACTIVITY') orderBy = 'last_activity_ledger DESC';
      
      const result = await db.query(
        `SELECT asset_code as code, asset_issuer as issuer, holder_count,
                first_seen_ledger, last_activity_ledger
         FROM assets
         WHERE network = $1
         ORDER BY ${orderBy}
         LIMIT $2`,
        [network || 'mainnet', limit + 1]
      );
      
      const hasMore = result.rows.length > limit;
      const data = result.rows.slice(0, limit).map(row => ({
        code: row.code,
        issuer: row.issuer,
        holderCount: row.holder_count,
        circulatingSupply: null,
        volume24h: null,
        firstSeenLedger: row.first_seen_ledger,
        lastActivityLedger: row.last_activity_ledger
      }));
      
      return {
        data,
        hasMore,
        cursor: hasMore ? data[data.length - 1].code : null
      };
    },

    async trustlineHistory(_: any, { network, code, issuer, limit }: any, { db }: Context) {
      // Placeholder - requires trustline_changes table from migration
      return [];
    }
  }
};
