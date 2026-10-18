-- Migration 013: Index Horizon trades
--
-- Consumes Horizon's /trades endpoint to record executed DEX trades.
-- Deriving trades from operations is unreliable because a single path payment
-- or offer operation can cross several offers and produce multiple trades.
--
-- Indexes allow querying by asset pair and by account. Issue #200.

CREATE TABLE IF NOT EXISTS trades (
    id                  TEXT NOT NULL,
    paging_token        TEXT NOT NULL,
    ledger_close_time   TIMESTAMPTZ NOT NULL,
    trade_type          TEXT NOT NULL DEFAULT 'orderbook',
    base_account        TEXT NOT NULL,
    base_amount         NUMERIC(20, 7) NOT NULL,
    base_asset_type     TEXT NOT NULL,
    base_asset_code     TEXT,
    base_asset_issuer   TEXT,
    base_offer_id       TEXT,
    counter_account     TEXT,
    counter_amount      NUMERIC(20, 7) NOT NULL,
    counter_asset_type  TEXT NOT NULL,
    counter_asset_code  TEXT,
    counter_asset_issuer TEXT,
    counter_offer_id    TEXT,
    base_is_seller      BOOLEAN,
    price_n             BIGINT,
    price_d             BIGINT,
    price               NUMERIC(20, 7),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, network),
    CONSTRAINT trades_id_check           CHECK (id <> ''),
    CONSTRAINT trades_base_account_check CHECK (base_account <> ''),
    CONSTRAINT trades_base_amount_check  CHECK (base_amount >= 0),
    CONSTRAINT trades_counter_amount_check CHECK (counter_amount >= 0)
);

-- Index for querying by asset pair
CREATE INDEX IF NOT EXISTS idx_trades_pair
    ON trades (base_asset_code, counter_asset_code, network, ledger_close_time DESC);

CREATE INDEX IF NOT EXISTS idx_trades_base_asset
    ON trades (base_asset_type, base_asset_code, base_asset_issuer, network);

CREATE INDEX IF NOT EXISTS idx_trades_counter_asset
    ON trades (counter_asset_type, counter_asset_code, counter_asset_issuer, network);

-- Indexes for querying by account (base or counter)
CREATE INDEX IF NOT EXISTS idx_trades_base_account
    ON trades (base_account, network, ledger_close_time DESC);

CREATE INDEX IF NOT EXISTS idx_trades_counter_account
    ON trades (counter_account, network, ledger_close_time DESC);

-- Index for chronological queries
CREATE INDEX IF NOT EXISTS idx_trades_ledger_close_time
    ON trades (ledger_close_time DESC);
