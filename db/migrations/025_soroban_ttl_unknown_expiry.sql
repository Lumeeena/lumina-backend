-- Allow restore operations and unsupported ledger keys to be recorded without
-- fabricating an expiry or contract id.
ALTER TABLE soroban_ttl ALTER COLUMN contract_id DROP NOT NULL;
ALTER TABLE soroban_ttl ALTER COLUMN live_until_ledger DROP NOT NULL;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('025_soroban_ttl_unknown_expiry', NOW())
ON CONFLICT (version) DO NOTHING;
