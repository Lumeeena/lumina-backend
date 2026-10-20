-- Restores the five operations indexes migration 019 dropped (from
-- db/schema.sql and 004_search_indexes) and removes the three it added. A
-- plain CREATE INDEX blocks writes to operations for the duration of the
-- build, and the GIN index over every row of details is the slowest of them;
-- on a large table run these by hand with CONCURRENTLY first, and this file
-- then only records the rollback.

CREATE INDEX IF NOT EXISTS idx_operations_source ON operations (source_account);

CREATE INDEX IF NOT EXISTS idx_operations_details ON operations USING GIN (details);

CREATE INDEX IF NOT EXISTS idx_operations_asset_code
    ON operations ((details->>'asset_code'))
    WHERE details->>'asset_code' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_asset_issuer
    ON operations ((details->>'asset_issuer'))
    WHERE details->>'asset_issuer' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_asset_type
    ON operations ((details->>'asset_type'))
    WHERE details->>'asset_type' IS NOT NULL;

DROP INDEX IF EXISTS idx_operations_network_ledger;
DROP INDEX IF EXISTS idx_operations_network_source_ledger;
DROP INDEX IF EXISTS idx_operations_lifecycle;

DELETE FROM schema_migrations WHERE version = '019_operations_index_review';
