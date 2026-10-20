-- Migration 015: Decode bump_sequence, manage_data, revoke_sponsorship, restore_footprint, extend_footprint_ttl, and contract interfaces
-- Run with: psql $DATABASE_URL -f db/migrations/015_operation_decoding.sql

-- ─── 1. Sponsorship Tracking (Issue #261) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS sponsorships (
    sponsor              TEXT NOT NULL,
    sponsored_id         TEXT NOT NULL,
    sponsored_type       TEXT NOT NULL,
    ledger               BIGINT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL,
    network              TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (sponsored_id, network)
);

CREATE INDEX IF NOT EXISTS idx_sponsorships_sponsor ON sponsorships (sponsor, network);
CREATE INDEX IF NOT EXISTS idx_sponsorships_type ON sponsorships (sponsored_type, network);

-- ─── 2. Soroban TTL Tracking (Issue #262) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS soroban_ttl (
    key                  TEXT NOT NULL,
    contract_id          TEXT NOT NULL,
    live_until_ledger    BIGINT NOT NULL,
    last_ledger          BIGINT NOT NULL,
    operation_type       TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL,
    network              TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (key, network)
);

CREATE INDEX IF NOT EXISTS idx_soroban_ttl_contract ON soroban_ttl (contract_id, network);
CREATE INDEX IF NOT EXISTS idx_soroban_ttl_expiry ON soroban_ttl (live_until_ledger, network);

-- ─── 3. Contract Interfaces (Issue #263) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contract_interfaces (
    contract_id          TEXT NOT NULL,
    wasm_hash            TEXT NOT NULL,
    functions            JSONB NOT NULL DEFAULT '[]',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network              TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (contract_id, network)
);

CREATE INDEX IF NOT EXISTS idx_contract_interfaces_wasm ON contract_interfaces (wasm_hash, network);

-- ─── 4. Record migration ───────────────────────────────────────────────────────

INSERT INTO schema_migrations (version, applied_at)
VALUES ('015_operation_decoding', NOW())
ON CONFLICT (version) DO NOTHING;
