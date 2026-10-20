-- Migration 019: replace the operations indexes nothing reads with the ones the API's queries need
-- Run with: psql $DATABASE_URL -f db/migrations/019_operations_index_review.sql
--
-- ## Why
--
-- Measured by replaying 1,000 mainnet ledgers (65039178-65040177, 364,273
-- operations) through indexLedger and running the API's own operation queries:
--
--   idx_operations_details        GIN over every key of every row: 436 MB, 88%
--                                 of the table's index bytes. Its one reader is
--                                 accountLifecycle, which needs two operation
--                                 types (0.6% of rows). Replaced by a partial
--                                 jsonb_path_ops GIN over those types: 0.9 MB,
--                                 same query.
--   idx_operations_asset_code,    0 scans. The asset filter ORs three roles and
--   _asset_issuer, _asset_type    two have no index, so no plan can use them.
--   idx_operations_source         Replaced by (network, source_account, ledger,
--                                 id): a busy account's first page was a bitmap
--                                 of all its rows, 23,955 buffers -> 14.
--   (new) network, ledger, id     The listing's keyset order. The unfiltered
--                                 first page was a sequential scan, 72,439
--                                 buffers -> 134; the subscription replay
--                                 72,351 -> 209.
--
--   WAL for 300 ledgers           732.0 MB -> 333.9 MB
--   replay time                   112.6 s -> 84.5 s
--   index size at 364k rows       494 MB -> 171 MB
--
-- Full measurements: docs/OPERATIONS_INDEX_REVIEW.md.
--
-- ## Note on migration time
--
-- `CONCURRENTLY` so neither the builds nor the drops block the indexer's
-- writes; it cannot run inside a transaction block, which is why this file has
-- no BEGIN/COMMIT. The three new indexes are built before anything is dropped,
-- so no query is left without an index, and the history insert is last.

\echo 'Running migration 019: operations index review...'

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operations_network_ledger
    ON operations (network, ledger DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operations_network_source_ledger
    ON operations (network, source_account, ledger DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operations_lifecycle
    ON operations USING GIN (details jsonb_path_ops)
    WHERE type IN ('create_account', 'account_merge');

DROP INDEX CONCURRENTLY IF EXISTS idx_operations_source;

DROP INDEX CONCURRENTLY IF EXISTS idx_operations_details;

DROP INDEX CONCURRENTLY IF EXISTS idx_operations_asset_code;

DROP INDEX CONCURRENTLY IF EXISTS idx_operations_asset_issuer;

DROP INDEX CONCURRENTLY IF EXISTS idx_operations_asset_type;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('019_operations_index_review', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 019 complete.'
