-- Rolls back migration 017_signers_sponsorship_contracts_rollups.
-- Statements are the inverse of the up migration, in reverse order.
--
-- Data loss: account_signers, contract_deployments and activity_rollups are
-- dropped with their rows. Re-applying the up migration recreates them empty;
-- they are only repopulated as ledgers are indexed (or re-indexed) again.
-- The sponsorships table belongs to 015_operation_decoding and is kept; only
-- the lookup index this migration added is dropped.

-- ─── #228, #229: Activity rollups ──────────────────────────────────────────

DROP INDEX IF EXISTS idx_activity_rollups_range;
DROP TABLE IF EXISTS activity_rollups;

-- ─── #227: Contract deployments ────────────────────────────────────────────

DROP INDEX IF EXISTS idx_contract_deployments_by_deployer;
DROP INDEX IF EXISTS idx_contract_deployments_by_ledger;
DROP INDEX IF EXISTS idx_contract_deployments_by_wasm;
DROP TABLE IF EXISTS contract_deployments;

-- ─── #226: Sponsorships ────────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_sponsorships_by_sponsored;

-- ─── #226: Account signers ──────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_account_signers_lookup;
DROP TABLE IF EXISTS account_signers;

DELETE FROM schema_migrations WHERE version = '017_signers_sponsorship_contracts_rollups';
