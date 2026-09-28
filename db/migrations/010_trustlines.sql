-- Migration 010: Trustlines table
--
-- Track trustlines to enable asset analytics: holder counts, supply tracking,
-- and every asset statistic depends on knowing which accounts hold which assets.
--
-- Populated from change_trust operations. This is the foundation for issues #71, #72, #73.

CREATE TABLE IF NOT EXISTS trustlines (
    account             TEXT NOT NULL,
    asset_code          TEXT NOT NULL,
    asset_issuer        TEXT NOT NULL,
    trust_limit         TEXT NOT NULL DEFAULT '922337203685.4775807',
    balance             TEXT NOT NULL DEFAULT '0',
    authorized          BOOLEAN NOT NULL DEFAULT TRUE,
    last_modified_ledger BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (account, asset_code, asset_issuer, network),
    CONSTRAINT trustlines_account_check           CHECK (account <> ''),
    CONSTRAINT trustlines_asset_code_check        CHECK (asset_code <> ''),
    CONSTRAINT trustlines_asset_issuer_check      CHECK (asset_issuer <> ''),
    CONSTRAINT trustlines_last_modified_ledger_check CHECK (last_modified_ledger > 0)
);

-- Index for asset-centric queries (e.g., all holders of an asset)
CREATE INDEX IF NOT EXISTS idx_trustlines_asset
    ON trustlines (asset_code, asset_issuer, network);

-- Index for balance queries (filter out zero balances for holder counts)
CREATE INDEX IF NOT EXISTS idx_trustlines_asset_active
    ON trustlines (asset_code, asset_issuer, network)
    WHERE balance <> '0';

-- Index for account-centric queries
CREATE INDEX IF NOT EXISTS idx_trustlines_account
    ON trustlines (account, network);

-- Index for ledger-ordered queries
CREATE INDEX IF NOT EXISTS idx_trustlines_ledger
    ON trustlines (last_modified_ledger DESC);
