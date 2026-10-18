# Asset & Trustline Analytics Module

## Overview
Aggregation layer on top of indexed account balances providing holder counts, circulating supply, volume tracking, and trustline history.

## Schema

### Assets Table (Already Exists)
See `db/migrations/011_assets.sql`:
```sql
CREATE TABLE assets (
    asset_code TEXT,
    asset_issuer TEXT,
    holder_count INTEGER DEFAULT 0,
    first_seen_ledger BIGINT,
    last_activity_ledger BIGINT,
    network TEXT DEFAULT 'mainnet',
    PRIMARY KEY (asset_code, asset_issuer, network)
);
```

### Asset Volume Table
See `db/migrations/012_asset_volume_buckets.sql`:
```sql
CREATE TABLE asset_volume_hourly (
    asset_code TEXT,
    asset_issuer TEXT,
    bucket_time TIMESTAMPTZ,  -- Hourly bucket
    volume_sent NUMERIC(20,7),
    volume_received NUMERIC(20,7),
    payment_count INTEGER,
    network TEXT DEFAULT 'mainnet',
    PRIMARY KEY (asset_code, asset_issuer, bucket_time, network)
);
```

### Trustline Changes
```sql
CREATE TABLE trustline_changes (
    id BIGSERIAL PRIMARY KEY,
    account_address TEXT NOT NULL,
    asset_code TEXT NOT NULL,
    asset_issuer TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    ledger_sequence BIGINT NOT NULL,
    limit_before NUMERIC(20,7),
    limit_after NUMERIC(20,7),
    changed_at TIMESTAMPTZ NOT NULL,
    network TEXT NOT NULL DEFAULT 'mainnet'
);

CREATE INDEX idx_trustline_changes_asset 
    ON trustline_changes (asset_code, asset_issuer, changed_at DESC);
CREATE INDEX idx_trustline_changes_account 
    ON trustline_changes (account_address, changed_at DESC);
```

## Aggregation Pipeline

### Incremental Update Strategy

The aggregation refreshes incrementally as new ledgers are indexed, not via full table scan:

```typescript
// Pseudo-code for incremental aggregation
async function updateAssetStats(ledgerSequence: number) {
  // Find assets affected in this ledger
  const affectedAssets = await db.query(`
    SELECT DISTINCT asset_code, asset_issuer
    FROM operations
    WHERE ledger_sequence = $1
      AND type IN ('change_trust', 'payment', 'path_payment_strict_send', 'path_payment_strict_receive')
  `, [ledgerSequence]);

  for (const asset of affectedAssets) {
    // Recompute holder count for this asset only
    await db.query(`
      INSERT INTO assets (asset_code, asset_issuer, holder_count, last_activity_ledger)
      VALUES ($1, $2, (
        SELECT COUNT(*) FROM accounts
        WHERE balances @> jsonb_build_array(
          jsonb_build_object('code', $1, 'issuer', $2)
        )
      ), $3)
      ON CONFLICT (asset_code, asset_issuer, network)
      DO UPDATE SET
        holder_count = EXCLUDED.holder_count,
        last_activity_ledger = EXCLUDED.last_activity_ledger,
        updated_at = NOW()
    `, [asset.asset_code, asset.asset_issuer, ledgerSequence]);
  }
}
```

### Volume Computation

Derive from payment operations:

```sql
-- Aggregate volume into hourly buckets
INSERT INTO asset_volume_hourly (
    asset_code, asset_issuer, bucket_time,
    volume_sent, volume_received, payment_count
)
SELECT
    asset_code,
    asset_issuer,
    date_trunc('hour', closed_at) AS bucket_time,
    SUM(CASE WHEN op_type = 'payment' THEN amount ELSE 0 END) AS volume_sent,
    SUM(CASE WHEN op_type = 'payment' THEN amount ELSE 0 END) AS volume_received,
    COUNT(*) AS payment_count
FROM operations
WHERE ledger_sequence BETWEEN $1 AND $2
  AND type IN ('payment', 'path_payment_strict_send', 'path_payment_strict_receive')
GROUP BY asset_code, asset_issuer, bucket_time
ON CONFLICT (asset_code, asset_issuer, bucket_time, network)
DO UPDATE SET
    volume_sent = asset_volume_hourly.volume_sent + EXCLUDED.volume_sent,
    volume_received = asset_volume_hourly.volume_received + EXCLUDED.volume_received,
    payment_count = asset_volume_hourly.payment_count + EXCLUDED.payment_count;
```

## GraphQL Schema

```graphql
type AssetStats {
  code: String!
  issuer: String!
  holderCount: Int!
  circulatingSupply: String
  volume24h: String
  firstSeenLedger: Int!
  lastActivityLedger: Int!
}

type AssetStatsPage {
  data: [AssetStats!]!
  cursor: String
  hasMore: Boolean!
}

type TrustlineChange {
  accountAddress: String!
  assetCode: String!
  assetIssuer: String!
  operationId: String!
  ledgerSequence: Int!
  limitBefore: String
  limitAfter: String!
  changedAt: String!
}

type Query {
  asset(code: String!, issuer: String!): AssetStats
  assets(
    limit: Int = 20
    cursor: String
    sortBy: AssetSortField = HOLDERS
  ): AssetStatsPage!
  trustlineHistory(
    code: String!
    issuer: String!
    limit: Int = 20
    cursor: String
  ): [TrustlineChange!]!
}

enum AssetSortField {
  HOLDERS
  VOLUME
  ACTIVITY
}
```

## Resolvers

### Asset Queries
```typescript
// graphql-server/src/resolvers.ts
export const resolvers = {
  Query: {
    asset: async (_: any, { code, issuer }: any, { db }: Context) => {
      const result = await db.query(
        'SELECT * FROM assets WHERE asset_code = $1 AND asset_issuer = $2',
        [code, issuer]
      );
      return result.rows[0] || null;
    },
    
    assets: async (_: any, { limit, cursor, sortBy }: any, { db }: Context) => {
      const orderBy = sortBy === 'VOLUME' 
        ? 'ORDER BY volume_24h DESC'
        : sortBy === 'ACTIVITY'
        ? 'ORDER BY last_activity_ledger DESC'
        : 'ORDER BY holder_count DESC';
      
      const result = await db.query(`
        SELECT * FROM assets ${orderBy} LIMIT $1
      `, [limit]);
      
      return {
        data: result.rows,
        hasMore: result.rows.length === limit,
        cursor: result.rows[result.rows.length - 1]?.id
      };
    },
    
    trustlineHistory: async (_: any, { code, issuer, limit }: any, { db }: Context) => {
      const result = await db.query(`
        SELECT * FROM trustline_changes
        WHERE asset_code = $1 AND asset_issuer = $2
        ORDER BY changed_at DESC
        LIMIT $3
      `, [code, issuer, limit]);
      
      return result.rows;
    }
  }
};
```

## Scheduler

The aggregation pipeline runs as a separate process from the main indexer:

```typescript
// Option 1: pg_cron (database-native)
SELECT cron.schedule(
  'refresh-asset-stats',
  '*/5 * * * *',  -- Every 5 minutes
  $$SELECT refresh_asset_stats()$$
);

// Option 2: Application-level scheduler
import { schedule } from 'node-cron';

schedule('*/5 * * * *', async () => {
  const lastProcessedLedger = await getLastProcessedLedger();
  const currentLedger = await getCurrentLedger();
  await updateAssetStats(lastProcessedLedger, currentLedger);
});
```

## Performance Considerations

- **Refresh latency**: 5-minute delay typical (configurable)
- **Impact on indexer**: Runs in separate process, no direct impact
- **Database load**: Incremental updates only touch affected assets
- **Index strategy**: Holder count computed from JSONB containment (@>)

## Testing Checklist

- [ ] Holder count matches manual COUNT(*) for known asset
- [ ] Volume aggregates correctly across payment types
- [ ] Trustline changes match underlying change_trust operations
- [ ] Incremental refresh only recomputes affected assets
- [ ] Scheduler doesn't degrade indexer throughput (benchmark)
- [ ] Circulating supply calculation handles account merges

## Implementation Status

- [x] Assets table (011_assets.sql)
- [x] Asset volume buckets (012_asset_volume_buckets.sql)
- [ ] Trustline changes table migration
- [ ] Incremental aggregation logic
- [ ] Scheduler integration
- [ ] GraphQL resolvers
- [ ] Comprehensive tests
