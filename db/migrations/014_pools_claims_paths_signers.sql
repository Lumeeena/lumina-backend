-- Migration 014: Index liquidity pools, claimable balances, path payments, and set_options operations
-- Run with: psql $DATABASE_URL -f db/migrations/014_pools_claims_paths_signers.sql

-- ─── 1. Liquidity Pools (Issue #201) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS liquidity_pools (
    pool_id             TEXT NOT NULL,
    asset_a             TEXT NOT NULL,
    asset_b             TEXT NOT NULL,
    fee_bp              INTEGER NOT NULL DEFAULT 30,
    reserve_a           NUMERIC(20, 7) NOT NULL DEFAULT 0,
    reserve_b           NUMERIC(20, 7) NOT NULL DEFAULT 0,
    total_shares        NUMERIC(20, 7) NOT NULL DEFAULT 0,
    last_ledger         BIGINT NOT NULL DEFAULT 0,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (pool_id, network)
);

CREATE TABLE IF NOT EXISTS liquidity_pool_shares (
    pool_id             TEXT NOT NULL,
    account             TEXT NOT NULL,
    shares              NUMERIC(20, 7) NOT NULL DEFAULT 0,
    last_ledger         BIGINT NOT NULL DEFAULT 0,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (pool_id, account, network)
);

CREATE INDEX IF NOT EXISTS idx_lp_shares_account ON liquidity_pool_shares (account, network);

-- ─── 2. Claimable Balances (Issue #202) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS claimable_balances (
    balance_id          TEXT NOT NULL,
    asset               TEXT NOT NULL,
    amount              NUMERIC(20, 7) NOT NULL,
    sponsor             TEXT,
    claimants           JSONB NOT NULL DEFAULT '[]'::jsonb,
    status              TEXT NOT NULL DEFAULT 'unclaimed',
    claimed_by          TEXT,
    claimed_at          TIMESTAMPTZ,
    claimed_ledger      BIGINT,
    created_ledger      BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (balance_id, network)
);

CREATE TABLE IF NOT EXISTS claimable_balance_claimants (
    balance_id          TEXT NOT NULL,
    destination         TEXT NOT NULL,
    predicate_type      TEXT NOT NULL DEFAULT 'unconditional',
    predicate_details   JSONB,
    abs_before          TIMESTAMPTZ,
    rel_before          BIGINT,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (balance_id, destination, network)
);

CREATE INDEX IF NOT EXISTS idx_claimable_balances_status ON claimable_balances (status, network);
CREATE INDEX IF NOT EXISTS idx_claimable_balances_sponsor ON claimable_balances (sponsor, network);
CREATE INDEX IF NOT EXISTS idx_cb_claimants_dest ON claimable_balance_claimants (destination, network);

-- ─── 3. Path Payments (Issue #206) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS path_payments (
    operation_id        TEXT NOT NULL,
    transaction_hash    TEXT NOT NULL,
    ledger              BIGINT NOT NULL,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    payment_type        TEXT NOT NULL,
    from_account        TEXT NOT NULL,
    to_account          TEXT NOT NULL,
    source_asset        TEXT NOT NULL,
    source_amount       NUMERIC(20, 7) NOT NULL,
    dest_asset          TEXT NOT NULL,
    dest_amount         NUMERIC(20, 7) NOT NULL,
    path_assets         TEXT[] NOT NULL DEFAULT '{}',
    hop_count           INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (operation_id, network)
);

CREATE TABLE IF NOT EXISTS path_payment_hops (
    operation_id        TEXT NOT NULL,
    hop_index           INTEGER NOT NULL,
    asset               TEXT NOT NULL,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (operation_id, hop_index, network)
);

CREATE INDEX IF NOT EXISTS idx_path_payments_from ON path_payments (from_account, network);
CREATE INDEX IF NOT EXISTS idx_path_payments_to ON path_payments (to_account, network);
CREATE INDEX IF NOT EXISTS idx_path_payments_source_asset ON path_payments (source_asset, network);
CREATE INDEX IF NOT EXISTS idx_path_payments_dest_asset ON path_payments (dest_asset, network);
CREATE INDEX IF NOT EXISTS idx_path_payments_path_assets ON path_payments USING GIN (path_assets);
CREATE INDEX IF NOT EXISTS idx_path_payments_tx ON path_payments (transaction_hash, network);
CREATE INDEX IF NOT EXISTS idx_path_hops_asset ON path_payment_hops (asset, network);

-- ─── 4. Set Options: Signer & Threshold Changes (Issue #207) ─────────────────

CREATE TABLE IF NOT EXISTS account_signer_changes (
    id                  BIGSERIAL PRIMARY KEY,
    account             TEXT NOT NULL,
    operation_id        TEXT NOT NULL,
    transaction_hash    TEXT NOT NULL,
    ledger              BIGINT NOT NULL,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    signer_key          TEXT NOT NULL,
    weight              INTEGER NOT NULL,
    action              TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signer_changes_account
    ON account_signer_changes (account, network, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signer_changes_key
    ON account_signer_changes (signer_key, network);
CREATE INDEX IF NOT EXISTS idx_signer_changes_op
    ON account_signer_changes (operation_id, network);

CREATE TABLE IF NOT EXISTS account_threshold_changes (
    id                  BIGSERIAL PRIMARY KEY,
    account             TEXT NOT NULL,
    operation_id        TEXT NOT NULL,
    transaction_hash    TEXT NOT NULL,
    ledger              BIGINT NOT NULL,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    master_weight       INTEGER,
    low_threshold       INTEGER,
    med_threshold       INTEGER,
    high_threshold      INTEGER,
    home_domain         TEXT,
    set_flags           TEXT[],
    clear_flags         TEXT[],
    created_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threshold_changes_account
    ON account_threshold_changes (account, network, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_threshold_changes_op
    ON account_threshold_changes (operation_id, network);
