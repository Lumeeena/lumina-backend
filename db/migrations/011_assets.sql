-- Migration 011: Assets table with holder counts
--
-- A materialized view of which assets exist on the network, derived from
-- trustlines. Maintains holder counts incrementally as trustlines are
-- created/updated/removed. Issue #72.

CREATE TABLE IF NOT EXISTS assets (
    asset_code          TEXT NOT NULL,
    asset_issuer        TEXT NOT NULL,
    holder_count        INTEGER NOT NULL DEFAULT 0,
    first_seen_ledger   BIGINT NOT NULL,
    last_activity_ledger BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (asset_code, asset_issuer, network),
    CONSTRAINT assets_asset_code_check          CHECK (asset_code <> ''),
    CONSTRAINT assets_asset_issuer_check        CHECK (asset_issuer <> ''),
    CONSTRAINT assets_holder_count_check        CHECK (holder_count >= 0),
    CONSTRAINT assets_first_seen_ledger_check   CHECK (first_seen_ledger > 0),
    CONSTRAINT assets_last_activity_ledger_check CHECK (last_activity_ledger > 0)
);

-- Index for holder count sorting (descending, most holders first)
CREATE INDEX IF NOT EXISTS idx_assets_holder_count
    ON assets (holder_count DESC, asset_code, asset_issuer);

-- Index for activity recency
CREATE INDEX IF NOT EXISTS idx_assets_activity
    ON assets (last_activity_ledger DESC);

-- Index for network-scoped queries
CREATE INDEX IF NOT EXISTS idx_assets_network
    ON assets (network);
