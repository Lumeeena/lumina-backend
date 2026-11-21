-- Rollback recreates the unused trustline history table empty.
CREATE TABLE IF NOT EXISTS trustline_changes (
  id BIGSERIAL PRIMARY KEY,
  account_address TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  asset_issuer TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  limit_before NUMERIC(20,7),
  limit_after NUMERIC(20,7),
  changed_at TIMESTAMPTZ NOT NULL,
  network TEXT NOT NULL DEFAULT 'mainnet'
);
CREATE INDEX IF NOT EXISTS idx_trustline_changes_asset ON trustline_changes (asset_code, asset_issuer, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trustline_changes_account ON trustline_changes (account_address, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trustline_changes_ledger ON trustline_changes (ledger_sequence);
CREATE INDEX IF NOT EXISTS idx_trustline_changes_network ON trustline_changes (network);

ALTER TABLE sponsorships DROP CONSTRAINT IF EXISTS sponsorships_pkey;
ALTER TABLE sponsorships ADD PRIMARY KEY (sponsored_id, network);
ALTER TABLE assets
  DROP COLUMN IF EXISTS issuer_metadata_error,
  DROP COLUMN IF EXISTS issuer_metadata_attempted_at,
  DROP COLUMN IF EXISTS issuer_metadata_fetched_at;
DELETE FROM schema_migrations WHERE version = '025_sponsorship_metadata_and_trustline_cleanup';
