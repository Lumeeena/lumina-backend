-- Existing rows may contain NULLs after the forward migration, so callers must
-- repair them before applying this rollback.
ALTER TABLE soroban_ttl ALTER COLUMN contract_id SET NOT NULL;
ALTER TABLE soroban_ttl ALTER COLUMN live_until_ledger SET NOT NULL;
DELETE FROM schema_migrations WHERE version = '025_soroban_ttl_unknown_expiry';
