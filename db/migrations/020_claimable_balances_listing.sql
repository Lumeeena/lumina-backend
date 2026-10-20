-- Migration 020: indexes for the claimableBalances query (issue #224)
-- Run with: psql $DATABASE_URL -f db/migrations/020_claimable_balances_listing.sql
--
-- claimableBalances pages newest first by (created_ledger, balance_id) and
-- filters by claimant, sponsor or asset.
--
--   claimant  idx_cb_claimants_dest (014) finds the account's balances; the
--             handful one account holds are sorted after the lookup.
--   asset     nothing served it. One asset (XLM) can hold most of the table,
--             so the index carries the page order and a page is a range read.
--   sponsor   idx_claimable_balances_sponsor (014) found the rows but not in
--             page order; the replacement does both, so the old one goes.
--
-- CONCURRENTLY so neither the builds nor the drop block the indexer.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_claimable_balances_asset_page
    ON claimable_balances (asset, network, created_ledger DESC, balance_id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_claimable_balances_sponsor_page
    ON claimable_balances (sponsor, network, created_ledger DESC, balance_id DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_claimable_balances_sponsor;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('020_claimable_balances_listing', NOW())
ON CONFLICT (version) DO NOTHING;
