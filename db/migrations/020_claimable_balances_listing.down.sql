-- Restores 014's sponsor index and drops the claimableBalances page indexes.

CREATE INDEX IF NOT EXISTS idx_claimable_balances_sponsor ON claimable_balances (sponsor, network);

DROP INDEX IF EXISTS idx_claimable_balances_sponsor_page;

DROP INDEX IF EXISTS idx_claimable_balances_asset_page;

DELETE FROM schema_migrations WHERE version = '020_claimable_balances_listing';
