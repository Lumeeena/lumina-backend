-- Migration 015: drop the secondary indexes on trustlines
-- Run with: psql $DATABASE_URL -f db/migrations/015_drop_unused_trustline_indexes.sql
--
-- ## Why
--
-- Every statement that touches trustlines is an indexer write keyed by the full
-- primary key (account, asset_code, asset_issuer, network): the change_trust
-- upsert and delete, and the payment balance upsert with its old-balance
-- subquery. No API query reads the table — holder counts come from
-- accounts.balances and assets.holder_count.
--
-- Replaying 50,877 mainnet asset operations (ledgers 65002303-65002408) through
-- processAssetOperation, with and without these indexes:
--
--   idx_trustlines_asset_active, idx_trustlines_ledger   0 scans
--   idx_trustlines_asset, idx_trustlines_account         2,270 scans, all of
--     them full-key lookups the planner routed to a narrower index plus a
--     filter; without them trustlines_pkey takes exactly those 2,270 scans
--     and no sequential scan is added
--   HOT updates                                          0% -> 96.8%
--   WAL written                                          2.95 MB -> 1.47 MB
--   index size                                           311 KB -> 106 KB
--
-- The HOT figure is the important one. idx_trustlines_ledger indexes
-- last_modified_ledger and idx_trustlines_asset_active's predicate reads
-- balance, and every balance update writes both, so no update could be HOT:
-- each one wrote a new entry into all five indexes.
--
-- Full measurements: docs/TRUSTLINES_INDEX_REVIEW.md.
--
-- ## Locking
--
-- DROP INDEX takes an ACCESS EXCLUSIVE lock on trustlines for the instant of
-- the drop. It does not scan the table.

\echo 'Running migration 015: drop unused trustlines indexes...'

DROP INDEX IF EXISTS idx_trustlines_asset;
DROP INDEX IF EXISTS idx_trustlines_asset_active;
DROP INDEX IF EXISTS idx_trustlines_account;
DROP INDEX IF EXISTS idx_trustlines_ledger;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('015_drop_unused_trustline_indexes', NOW())
ON CONFLICT (version) DO NOTHING;
