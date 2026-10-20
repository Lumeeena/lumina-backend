-- Restores the five secondary indexes from 011_assets and
-- 015_asset_issuer_metadata. A plain CREATE INDEX blocks writes to assets for
-- the duration of the build; on a large table run these by hand with
-- CONCURRENTLY first, and this file then only records the rollback.

CREATE INDEX IF NOT EXISTS idx_assets_holder_count
    ON assets (holder_count DESC, asset_code, asset_issuer);

CREATE INDEX IF NOT EXISTS idx_assets_activity
    ON assets (last_activity_ledger DESC);

CREATE INDEX IF NOT EXISTS idx_assets_network
    ON assets (network);

CREATE INDEX IF NOT EXISTS idx_assets_issuer_home_domain
    ON assets (issuer_home_domain, network);

CREATE INDEX IF NOT EXISTS idx_assets_lookalike
    ON assets (is_lookalike, network) WHERE is_lookalike = TRUE;

DROP INDEX IF EXISTS idx_assets_network_holders;

DELETE FROM schema_migrations WHERE version = '016_assets_index_review';
