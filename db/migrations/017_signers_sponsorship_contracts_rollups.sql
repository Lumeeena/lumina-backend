-- Migration 017: Signers, Sponsorships, Contract Deployments, Activity Rollups
-- Issues: #226, #227, #228, #229

-- ─── #226: Account signers ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS account_signers (
  network text NOT NULL,
  account_address text NOT NULL,
  key text NOT NULL,
  type text NOT NULL,
  weight integer NOT NULL,
  last_modified_ledger integer NOT NULL,
  PRIMARY KEY (network, account_address, key)
);

CREATE INDEX IF NOT EXISTS idx_account_signers_lookup
  ON account_signers (network, account_address);

-- ─── #226: Sponsorships ────────────────────────────────────────────────────

-- The table is created by 015_operation_decoding; this adds the lookup the
-- sponsored-accounts query needs without changing its shape.
CREATE INDEX IF NOT EXISTS idx_sponsorships_by_sponsored
  ON sponsorships (network, sponsored_id);

-- ─── #227: Contract deployments ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contract_deployments (
  network text NOT NULL,
  contract_id text NOT NULL,
  deployer text NOT NULL,
  wasm_hash text NOT NULL,
  deployed_ledger integer NOT NULL,
  deployed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, contract_id)
);

CREATE INDEX IF NOT EXISTS idx_contract_deployments_by_wasm
  ON contract_deployments (network, wasm_hash);

CREATE INDEX IF NOT EXISTS idx_contract_deployments_by_ledger
  ON contract_deployments (network, deployed_ledger DESC);

CREATE INDEX IF NOT EXISTS idx_contract_deployments_by_deployer
  ON contract_deployments (network, deployer);

-- ─── #228, #229: Activity rollups ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity_rollups (
  network text NOT NULL,
  granularity text NOT NULL CHECK (granularity IN ('hour', 'day')),
  bucket_start timestamptz NOT NULL,
  transaction_count integer NOT NULL DEFAULT 0,
  operation_count integer NOT NULL DEFAULT 0,
  active_accounts integer NOT NULL DEFAULT 0,
  total_volume numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, granularity, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_activity_rollups_range
  ON activity_rollups (network, granularity, bucket_start);

COMMENT ON TABLE activity_rollups IS
  'Rolled-up activity aggregates for network statistics (#228, #229). '
  'Updated as ledgers are indexed; read by networkStats and activityRollups queries.';
