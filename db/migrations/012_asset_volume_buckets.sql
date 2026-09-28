-- Migration 012: Asset volume tracking over time
--
-- Time-bucketed volume aggregates per asset, written as payment operations are
-- indexed. Enables efficient volume charts without scanning all payments on
-- every request. Issue #73.
--
-- Bucket size: 1 hour (3600 seconds). This balances granularity with row count:
-- - Daily charts: ~24 buckets per day, efficient single read
-- - Weekly/monthly charts: aggregated from hourly buckets server-side
-- - Real-time updates: sub-day resolution for recent activity
-- - Storage: ~8760 rows per asset per year (manageable for indexes)

CREATE TABLE IF NOT EXISTS asset_volume_buckets (
    asset_code          TEXT NOT NULL,
    asset_issuer        TEXT NOT NULL,
    bucket_time         TIMESTAMPTZ NOT NULL,
    volume              NUMERIC(20, 7) NOT NULL DEFAULT 0,
    operation_count     INTEGER NOT NULL DEFAULT 0,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (asset_code, asset_issuer, bucket_time, network),
    CONSTRAINT asset_volume_buckets_asset_code_check    CHECK (asset_code <> ''),
    CONSTRAINT asset_volume_buckets_asset_issuer_check  CHECK (asset_issuer <> ''),
    CONSTRAINT asset_volume_buckets_volume_check        CHECK (volume >= 0),
    CONSTRAINT asset_volume_buckets_operation_count_check CHECK (operation_count >= 0)
);

-- Index for time-range queries on a specific asset (e.g., chart data fetch)
CREATE INDEX IF NOT EXISTS idx_asset_volume_buckets_asset_time
    ON asset_volume_buckets (asset_code, asset_issuer, network, bucket_time DESC);

-- Index for network-wide volume queries
CREATE INDEX IF NOT EXISTS idx_asset_volume_buckets_time
    ON asset_volume_buckets (bucket_time DESC);

-- Function to round timestamp down to the nearest hour bucket
CREATE OR REPLACE FUNCTION bucket_hour(ts TIMESTAMPTZ)
RETURNS TIMESTAMPTZ AS $$
    SELECT date_trunc('hour', ts);
$$ LANGUAGE SQL IMMUTABLE;
