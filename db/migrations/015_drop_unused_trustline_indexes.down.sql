-- Restores the four secondary indexes from 010_trustlines. A plain CREATE INDEX
-- blocks writes to trustlines for the duration of the build; on a large table
-- run these by hand with CONCURRENTLY first, and this file then only records
-- the rollback.

CREATE INDEX IF NOT EXISTS idx_trustlines_asset
    ON trustlines (asset_code, asset_issuer, network);

CREATE INDEX IF NOT EXISTS idx_trustlines_asset_active
    ON trustlines (asset_code, asset_issuer, network)
    WHERE balance <> '0';

CREATE INDEX IF NOT EXISTS idx_trustlines_account
    ON trustlines (account, network);

CREATE INDEX IF NOT EXISTS idx_trustlines_ledger
    ON trustlines (last_modified_ledger DESC);

DELETE FROM schema_migrations WHERE version = '015_drop_unused_trustline_indexes';
