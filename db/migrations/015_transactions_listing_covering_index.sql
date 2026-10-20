-- Migration 015: covering index for the transactions listing
-- Run with: psql $DATABASE_URL -f db/migrations/015_transactions_listing_covering_index.sql
--
-- ## Why
--
-- `getTransactions` already finds its page through
-- idx_transactions_network_ledger_hash (migration 010), but every row it
-- returns still costs a heap visit, because the columns it selects are not in
-- that index. The listing selects a bounded set of narrow columns
-- (TRANSACTION_COLUMNS in graphql-server/src/db.ts), so an `INCLUDE` list can
-- carry all of them and the planner can answer the page — first page, keyset
-- pages, both directions — with an Index Only Scan.
--
-- This *replaces* idx_transactions_network_ledger_hash rather than sitting
-- beside it: the key is identical, so the old index is strictly redundant and
-- the added write cost is the INCLUDE payload, not a second index. Measured on
-- 3M rows: the index grows from 443 MB to 872 MB (+14% on the table's total
-- footprint), WAL per 500k inserted rows goes up ~7.7%, and insert time showed
-- no difference above run-to-run noise. docs/QUERY_PLANS.md has the details.
--
-- ## What was deliberately left out
--
-- - `ledgers`: rows are written in sequence order, so the 20 rows of a page sit
--   on one heap page and ledgers_pkey already reads a page in 3 buffers. A
--   covering index was measured and the planner kept the primary key.
-- - `operations`, `contract_events`, `contract_storage_entries`, `accounts`:
--   each selects a JSONB column. Copying that into an index roughly duplicates
--   the table on the indexer's hottest write path.
-- - `trades` selects 21 columns — the whole row.
--
-- ## Visibility map
--
-- An index-only scan skips the heap only for pages the visibility map marks
-- all-visible, and only vacuum sets that. The insert-triggered vacuum from
-- migration 006 fires after 5000 rows *plus 5% of the table*, so the gap grows
-- with the table — on 100M rows it is 5M rows, hours of chain time, and the
-- newest pages (exactly the ones the first page reads) stay unmarked. A fixed
-- threshold keeps the gap constant. Vacuuming an insert-only table is cheap: it
-- only visits pages the map does not already cover.
--
-- ## Note on migration time
--
-- `CONCURRENTLY` so the build does not hold a write lock and stall the indexer.
-- It cannot run inside a transaction block, which is why this file has no
-- BEGIN/COMMIT — the statements are idempotent, and the history insert is last.
-- The old index is dropped only after its replacement exists, so there is no
-- window in which the listing has no index to use.

\echo 'Running migration 015: transactions listing covering index (this can take a while on a large database)...'

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_network_ledger_hash_covering
    ON transactions (network, ledger DESC, hash DESC)
    INCLUDE (created_at, source_account, fee_charged, operation_count, successful, memo_type, memo);

DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_network_ledger_hash;

ALTER TABLE transactions SET (
    autovacuum_vacuum_insert_threshold = 50000,
    autovacuum_vacuum_insert_scale_factor = 0
);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('015_transactions_listing_covering_index', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 015 complete.'
