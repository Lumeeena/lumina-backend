-- Rollback migration 013: Index Horizon trades

DROP INDEX IF EXISTS idx_trades_ledger_close_time;
DROP INDEX IF EXISTS idx_trades_counter_account;
DROP INDEX IF EXISTS idx_trades_base_account;
DROP INDEX IF EXISTS idx_trades_counter_asset;
DROP INDEX IF EXISTS idx_trades_base_asset;
DROP INDEX IF EXISTS idx_trades_pair;
DROP TABLE IF EXISTS trades;

DELETE FROM schema_migrations WHERE version = '013_trades';
