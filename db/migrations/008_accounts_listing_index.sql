-- Migration 008: index for the accounts listing
-- Run with: psql $DATABASE_URL -f db/migrations/008_accounts_listing_index.sql
--
-- ## Why
--
-- `accounts` had exactly one index: its primary key on (address, network). That
-- serves `account(address:)` and an address-ordered listing, and nothing else.
--
-- The listing most callers actually want is "most recently active first", which
-- orders by last_modified_ledger — and with no index on that column Postgres
-- sorts every account row in the table for every page. On a populated
-- deployment that is a full scan plus a sort per page of a walk that is
-- inherently long, so the cost is paid repeatedly rather than once.
--
-- `network` leads the index because every query filters on it, and it is the
-- only index that has to serve the listing in a multi-network deployment where
-- the same address exists on each chain. `address` is included in the key
-- rather than left out because it breaks ties: several accounts are typically
-- modified in the same ledger, and without a deterministic tiebreaker a keyset
-- walk can return the same page forever.
--
-- ## Note on migration time
--
-- `CONCURRENTLY` so the build does not hold a write lock and stall the indexer.
-- It cannot run inside a transaction block, which is why this file has no
-- BEGIN/COMMIT — the statements are idempotent, and the history insert is last.

\echo 'Running migration 008: accounts listing index (this can take a while on a large database)...'

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_last_modified
    ON accounts (network, last_modified_ledger DESC, address);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('008_accounts_listing_index', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 008 complete.'
