-- Migration 013: Trustline changes tracking
-- Issue #7: Asset & trustline analytics module

CREATE TABLE IF NOT EXISTS trustline_changes (
    id BIGSERIAL PRIMARY KEY,
    account_address TEXT NOT NULL,
    asset_code TEXT NOT NULL,
    asset_issuer TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    ledger_sequence BIGINT NOT NULL,
    limit_before NUMERIC(20,7),
    limit_after NUMERIC(20,7) NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL,
    network TEXT NOT NULL DEFAULT 'mainnet',
    CONSTRAINT trustline_changes_ledger_check CHECK (ledger_sequence > 0),
    CONSTRAINT trustline_changes_limit_check CHECK (limit_after >= 0)
);

CREATE INDEX IF NOT EXISTS idx_trustline_changes_asset
    ON trustline_changes (asset_code, asset_issuer, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_trustline_changes_account
    ON trustline_changes (account_address, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_trustline_changes_ledger
    ON trustline_changes (ledger_sequence);

CREATE INDEX IF NOT EXISTS idx_trustline_changes_network
    ON trustline_changes (network);

-- Add export_enabled flag to api_keys if not exists (Issue #8, #10)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'api_keys' AND column_name = 'export_enabled'
    ) THEN
        ALTER TABLE api_keys ADD COLUMN export_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END$$;

-- Add rate_limit column to api_keys if not exists (Issue #8)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'api_keys' AND column_name = 'rate_limit'
    ) THEN
        ALTER TABLE api_keys ADD COLUMN rate_limit INTEGER DEFAULT 60;
        COMMENT ON COLUMN api_keys.rate_limit IS 'Requests per minute allowed for this key (null = unlimited)';
    END IF;
END$$;
