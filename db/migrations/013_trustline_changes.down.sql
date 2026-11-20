-- Rollback migration 013: Trustline changes tracking
--
-- The api_keys.export_enabled and api_keys.rate_limit blocks in the up
-- migration are conditional no-ops: both columns are owned by earlier
-- migrations (006_export_permissions and 005_api_keys), which always run
-- first. They are intentionally NOT dropped here, since that would destroy
-- per-key configuration this migration never created.

DROP INDEX IF EXISTS idx_trustline_changes_network;
DROP INDEX IF EXISTS idx_trustline_changes_ledger;
DROP INDEX IF EXISTS idx_trustline_changes_account;
DROP INDEX IF EXISTS idx_trustline_changes_asset;
DROP TABLE IF EXISTS trustline_changes;

DELETE FROM schema_migrations WHERE version = '013_trustline_changes';
