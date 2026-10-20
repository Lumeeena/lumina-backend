-- Migration 016: replace the assets indexes with the one the listing reads
-- Run with: psql $DATABASE_URL -f db/migrations/016_assets_index_review.sql
--
-- ## Why
--
-- Two API queries read assets: assetByKey (the primary key) and the assets
-- listing, which filters by network and sorts by holder_count. The indexer
-- writes it on every credit payment, always by the full primary key. Measured
-- by seeding 43,426 real mainnet and testnet assets, replaying 28,686 mainnet
-- asset operations (ledgers 65007300-65007467) through processAssetOperation,
-- then running getAssets and getAssetByKey (median of three runs):
--
--   idx_assets_activity            0 scans. Its only reader is the ACTIVITY sort
--                                  in assetResolvers.ts, which nothing mounts.
--                                  Indexes last_activity_ledger, which the
--                                  indexer rewrites on every asset's first
--                                  payment in each ledger.
--   idx_assets_issuer_home_domain  0 scans. No query filters on either column.
--   idx_assets_lookalike           0 scans. No query filters on is_lookalike.
--   idx_assets_network             Scanned only by plans that are faster
--                                  without it (VOLUME listing 23.7 -> 13.2 ms).
--                                  Its key is the leading column of the
--                                  replacement below.
--   idx_assets_holder_count        Serves the listing, but without network: a
--                                  testnet page walks past every mainnet asset
--                                  with more holders (page 1: 1,824 -> 65
--                                  buffers with network leading).
--
--   WAL for the replay             56.8 MB -> 47.0 MB
--   index size                     18.8 MB -> 17.5 MB
--
-- Full measurements: docs/ASSETS_INDEX_REVIEW.md.
--
-- ## Note on migration time
--
-- `CONCURRENTLY` so neither the build nor the drops block the indexer's writes.
-- It cannot run inside a transaction block, which is why this file has no
-- BEGIN/COMMIT. The statements are idempotent and the history insert is last.
-- The new index is built before the old one is dropped, so the listing always
-- has an index to use.

\echo 'Running migration 016: assets index review...'

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_network_holders
    ON assets (network, holder_count DESC, asset_code, asset_issuer);

DROP INDEX CONCURRENTLY IF EXISTS idx_assets_holder_count;

DROP INDEX CONCURRENTLY IF EXISTS idx_assets_activity;

DROP INDEX CONCURRENTLY IF EXISTS idx_assets_network;

DROP INDEX CONCURRENTLY IF EXISTS idx_assets_issuer_home_domain;

DROP INDEX CONCURRENTLY IF EXISTS idx_assets_lookalike;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('016_assets_index_review', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 016 complete.'
