-- Lumina PostgreSQL Schema
-- Run this to initialize the database: psql $DATABASE_URL -f db/schema.sql

-- ─── Migrations bookkeeping ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
    version             TEXT PRIMARY KEY,
    applied_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Ledgers ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ledgers (
    sequence            BIGINT NOT NULL,
    closed_at           TIMESTAMPTZ NOT NULL,
    transaction_count   INTEGER NOT NULL DEFAULT 0,
    operation_count     INTEGER NOT NULL DEFAULT 0,
    base_fee            BIGINT NOT NULL DEFAULT 100,
    base_reserve        BIGINT NOT NULL DEFAULT 5000000,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (sequence, network),
    -- Data-quality guards for values the indexer and query layer assume are
    -- well-formed. See db/migrations/008_data_constraints.sql.
    CONSTRAINT ledgers_sequence_check          CHECK (sequence > 0),
    CONSTRAINT ledgers_transaction_count_check CHECK (transaction_count >= 0),
    CONSTRAINT ledgers_operation_count_check   CHECK (operation_count >= 0)
);

-- Serves the retention prune (`closed_at < cutoff`), not an API query. The
-- ledger listing orders by sequence and uses the primary key, so this index has
-- zero scans until retention is enabled; it is kept because after a backfill or
-- reindex the prune cannot rely on physical order. See
-- docs/LEDGERS_INDEX_REVIEW.md.
CREATE INDEX idx_ledgers_closed_at ON ledgers (closed_at DESC);
CREATE INDEX idx_ledgers_network_sequence ON ledgers (network, sequence DESC);

-- ─── Transactions ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transactions (
    hash                TEXT NOT NULL,
    ledger              BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    source_account      TEXT NOT NULL,
    fee_charged         BIGINT NOT NULL,
    operation_count     SMALLINT NOT NULL,
    successful          BOOLEAN NOT NULL,
    memo_type           TEXT,
    memo                TEXT,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (hash, network),
    FOREIGN KEY (ledger, network) REFERENCES ledgers (sequence, network),
    CONSTRAINT transactions_hash_check              CHECK (hash <> ''),
    CONSTRAINT transactions_ledger_check            CHECK (ledger > 0),
    CONSTRAINT transactions_source_account_check    CHECK (source_account <> ''),
    CONSTRAINT transactions_operation_count_check   CHECK (operation_count >= 0)
);

CREATE INDEX idx_transactions_ledger     ON transactions (ledger DESC);
CREATE INDEX idx_transactions_source     ON transactions (source_account);
CREATE INDEX idx_transactions_created_at ON transactions (created_at DESC);

-- Serves the `transactions` listing as an Index Only Scan: the key is the
-- keyset order, and INCLUDE carries every column the listing selects. See
-- db/migrations/015_transactions_listing_covering_index.sql.
CREATE INDEX idx_transactions_network_ledger_hash_covering
    ON transactions (network, ledger DESC, hash DESC)
    INCLUDE (created_at, source_account, fee_charged, operation_count, successful, memo_type, memo);

-- ─── Operations ───────────────────────────────────────────────────────────────
--
-- A plain table, not partitioned. It was range-partitioned by ledger for a
-- while (see db/migrations/006_partition_operations.sql), but a partitioned
-- table's primary key must include the partition key, and the multi-network
-- key (id, network) cannot also carry `ledger` — so the partitioning was
-- reverted and the primary key is (id, network).
--
-- A deployment that ran the *original* 006_partition_operations still has a
-- partitioned table keyed (id, ledger, network). indexer/src/db.ts inserts
-- without an ON CONFLICT inference clause precisely so one insert statement
-- works against both shapes.

CREATE TABLE IF NOT EXISTS operations (
    id                  TEXT NOT NULL,
    type                TEXT NOT NULL,
    transaction_hash    TEXT NOT NULL,
    ledger              BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    source_account      TEXT NOT NULL,
    -- JSONB column holds type-specific fields (from, to, amount, asset, etc.)
    details             JSONB NOT NULL DEFAULT '{}',
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (id, network),
    FOREIGN KEY (transaction_hash, network) REFERENCES transactions (hash, network),
    CONSTRAINT operations_id_check                CHECK (id <> ''),
    CONSTRAINT operations_type_check              CHECK (type <> ''),
    CONSTRAINT operations_transaction_hash_check  CHECK (transaction_hash <> ''),
    CONSTRAINT operations_ledger_check            CHECK (ledger > 0),
    CONSTRAINT operations_source_account_check    CHECK (source_account <> '')
);

-- Every index here names its reader; db/migrations/019_operations_index_review.sql
-- and docs/OPERATIONS_INDEX_REVIEW.md have the measurements behind the set.
--
-- transaction_hash: Transaction.operations, and the foreign-key check each
-- transactions row deleted by the retention prune makes against this table.
CREATE INDEX idx_operations_transaction   ON operations (transaction_hash);
-- A rare operation type; a common one is found faster by walking ledger order.
CREATE INDEX idx_operations_type          ON operations (type);
-- The retention prune, balance history and the asset volume series: time ranges.
CREATE INDEX idx_operations_created_at    ON operations (created_at DESC);
-- The listing's keyset order, so a page is the next 20 rows rather than a
-- sort of the network; also one ledger's operations for the subscription replay.
CREATE INDEX idx_operations_network_ledger
    ON operations (network, ledger DESC, id DESC);
-- An account's operations, already in the listing's order.
CREATE INDEX idx_operations_network_source_ledger
    ON operations (network, source_account, ledger DESC, id DESC);
-- accountLifecycle's containment match, over the two operation types it reads
-- rather than over every key of every operation.
CREATE INDEX idx_operations_lifecycle
    ON operations USING GIN (details jsonb_path_ops)
    WHERE type IN ('create_account', 'account_merge');

-- Defined for parity with db/migrations/006_partition_operations.sql, which
-- also creates it — the parity check diffs the two dumps, so the definition has
-- to appear in both. `operations` is not partitioned (see the note above), so
-- the function is never invoked: creating a partition of a plain table is an
-- error, and the initial-partition call that used to run here would fail. The
-- indexer's ensurePartitions wrapper (indexer/src/db.ts) is unused for the same
-- reason.
CREATE OR REPLACE FUNCTION ensure_operations_partitions(partitions_ahead INTEGER DEFAULT 3)
RETURNS void AS $$
DECLARE
  partition_size CONSTANT BIGINT := 2000000;
  v_max_ledger BIGINT;
  v_upper BIGINT;
  v_target BIGINT;
  v_from BIGINT;
  v_to BIGINT;
  v_name TEXT;
BEGIN
  SELECT COALESCE(MAX(ledger), 0) INTO v_max_ledger FROM operations;

  SELECT MAX((regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''?(-?\d+)''?\)'))[1]::bigint)
    INTO v_upper
  FROM pg_inherits pi JOIN pg_class c ON c.oid = pi.inhrelid
  WHERE pi.inhparent = 'operations'::regclass;

  v_from := COALESCE(v_upper, 0);
  v_target := v_max_ledger + partitions_ahead * partition_size;

  WHILE v_from < v_target LOOP
    v_to := v_from + partition_size;
    v_name := format('operations_p%s', v_from);

    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF operations FOR VALUES FROM (%L) TO (%L)',
        v_name, v_from, v_to
      );
      RAISE NOTICE 'created partition % for ledger range [%, %)', v_name, v_from, v_to;
    END IF;

    v_from := v_to;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ─── Accounts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounts (
    address             TEXT NOT NULL,
    sequence            TEXT NOT NULL,
    subentry_count      INTEGER NOT NULL DEFAULT 0,
    last_modified_ledger BIGINT NOT NULL,
    num_sponsored       INTEGER NOT NULL DEFAULT 0,
    num_sponsoring      INTEGER NOT NULL DEFAULT 0,
    balances            JSONB NOT NULL DEFAULT '[]',
    flags               JSONB NOT NULL DEFAULT '{}',
    thresholds          JSONB NOT NULL DEFAULT '{}',
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (address, network),
    CONSTRAINT accounts_address_check         CHECK (address <> ''),
    CONSTRAINT accounts_sequence_check        CHECK (sequence <> ''),
    CONSTRAINT accounts_subentry_count_check  CHECK (subentry_count >= 0),
    CONSTRAINT accounts_last_modified_ledger_check CHECK (last_modified_ledger > 0),
    CONSTRAINT accounts_num_sponsored_check   CHECK (num_sponsored >= 0),
    CONSTRAINT accounts_num_sponsoring_check  CHECK (num_sponsoring >= 0)
);

-- Durable outbox for account state lookups. It is written with each ledger so
-- committed ledger data always has recoverable account refresh work.
CREATE TABLE IF NOT EXISTS account_refresh_queue (
    network                 TEXT NOT NULL,
    address                 TEXT NOT NULL,
    last_requested_ledger   BIGINT NOT NULL,
    queued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (network, address)
);
CREATE INDEX idx_account_refresh_queue_pending
    ON account_refresh_queue (network, queued_at);

-- Serves the `accounts` listing ordered by recent activity. `network` leads
-- because every query filters on it, and `address` is in the key rather than
-- left out because several accounts are typically modified in the same ledger —
-- without a deterministic tiebreaker a keyset walk repeats the same page.
CREATE INDEX idx_accounts_last_modified ON accounts (network, last_modified_ledger DESC, address);

-- Stored copies of an account, one per observed last-modified ledger. Written by
-- the indexer on each account refresh; read by account(asOfLedger:). See
-- docs/ACCOUNT_STATE_HISTORY.md for what a copy does and does not capture.
CREATE TABLE IF NOT EXISTS account_state_history (
    address              TEXT NOT NULL,
    network              TEXT NOT NULL DEFAULT 'mainnet',
    last_modified_ledger BIGINT NOT NULL,
    sequence             TEXT NOT NULL,
    subentry_count       INTEGER NOT NULL DEFAULT 0,
    num_sponsored        INTEGER NOT NULL DEFAULT 0,
    num_sponsoring       INTEGER NOT NULL DEFAULT 0,
    balances             JSONB NOT NULL DEFAULT '[]',
    flags                JSONB NOT NULL DEFAULT '{}',
    thresholds           JSONB NOT NULL DEFAULT '{}',
    recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (address, network, last_modified_ledger),
    CONSTRAINT account_state_history_address_check         CHECK (address <> ''),
    CONSTRAINT account_state_history_sequence_check        CHECK (sequence <> ''),
    CONSTRAINT account_state_history_last_modified_check   CHECK (last_modified_ledger > 0),
    CONSTRAINT account_state_history_subentry_count_check  CHECK (subentry_count >= 0),
    CONSTRAINT account_state_history_num_sponsored_check   CHECK (num_sponsored >= 0),
    CONSTRAINT account_state_history_num_sponsoring_check  CHECK (num_sponsoring >= 0)
);

CREATE INDEX idx_account_state_history_recorded_at ON account_state_history (recorded_at);

-- ─── Contract Events (Soroban) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contract_events (
    id                  TEXT NOT NULL,
    type                TEXT NOT NULL DEFAULT 'contract',
    contract_id         TEXT NOT NULL,
    ledger              BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    paging_token        TEXT NOT NULL,
    topics              TEXT[] NOT NULL DEFAULT '{}',
    value               JSONB,
    transaction_hash    TEXT,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (id, network),
    CONSTRAINT contract_events_id_check          CHECK (id <> ''),
    CONSTRAINT contract_events_contract_id_check  CHECK (contract_id <> ''),
    CONSTRAINT contract_events_ledger_check       CHECK (ledger > 0),
    CONSTRAINT contract_events_paging_token_check CHECK (paging_token <> '')
);

CREATE INDEX idx_events_contract_id  ON contract_events (contract_id);
CREATE INDEX idx_events_ledger       ON contract_events (ledger DESC);
CREATE INDEX idx_events_created_at   ON contract_events (created_at DESC);
CREATE INDEX idx_events_topics       ON contract_events USING GIN (topics);
CREATE INDEX idx_events_transaction  ON contract_events (transaction_hash, network);

-- ─── Custom per-contract event schemas ───────────────────────────────────
-- One row per contract that has registered a schema. The definition is stored
-- as JSONB rather than shredded into tables because it is read whole, once per
-- indexer start, and never queried by its parts.
CREATE TABLE IF NOT EXISTS contract_schemas (
    contract_id     TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    definition      JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network         TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (contract_id, network)
);
-- Decoded events live in one shared table keyed by JSONB payload, rather than a
-- generated table per contract/event.
--
-- The alternative — CREATE TABLE custom_<contract>_<event> with real columns —
-- buys native column types and loses more than it gains: DDL on the indexing
-- hot path, table sprawl that grows with registrations, an ALTER TABLE
-- migration story every time a project revises a schema, and identifiers
-- derived from third-party input reaching SQL as identifiers rather than as
-- bind parameters.
--
-- Here a schema revision is a metadata update, one project's schema cannot
-- collide with another's table, and field names never leave the JSONB layer.
-- The cost is that ordered comparison needs a cast, which the query layer does
-- using the type the schema declares.
CREATE TABLE IF NOT EXISTS custom_events (
    event_id        TEXT NOT NULL,
    contract_id     TEXT NOT NULL,
    event_name      TEXT NOT NULL,
    ledger          BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    schema_version  INTEGER NOT NULL,
    fields          JSONB NOT NULL DEFAULT '{}',
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network         TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (event_id, event_name, network),
    CONSTRAINT custom_events_event_id_check      CHECK (event_id <> ''),
    CONSTRAINT custom_events_contract_id_check   CHECK (contract_id <> ''),
    CONSTRAINT custom_events_event_name_check    CHECK (event_name <> ''),
    CONSTRAINT custom_events_ledger_check        CHECK (ledger > 0)
);
CREATE INDEX IF NOT EXISTS idx_custom_events_contract_event
    ON custom_events (contract_id, event_name, ledger DESC);
CREATE INDEX IF NOT EXISTS idx_custom_events_ledger
    ON custom_events (ledger DESC);
-- Chain-time index, serving the retention prune (db/migrations/010_retention_prune_indexes.sql).
-- Every other prunable table has one; without it this prune is a sequential scan.
CREATE INDEX IF NOT EXISTS idx_custom_events_created_at
    ON custom_events (created_at DESC);
-- Containment queries on exact-match filters go through the payload directly.
CREATE INDEX IF NOT EXISTS idx_custom_events_fields
    ON custom_events USING GIN (fields);

-- ─── Contract storage entries (Soroban) ────────────────────────────────────
--
-- One row per contract storage entry the indexer has fetched, addressed by the
-- full LedgerKey XDR that `getLedgerEntries` was called with. `state` is the
-- archival distinction: Soroban archives a persistent entry once its TTL
-- expires (it becomes inaccessible, not deleted), so an archived entry keeps
-- its row with `state = 'archived'` rather than being removed — which is what
-- lets a client tell "archived" apart from "absent" (no row at all).
--
-- `key` is the base64 XDR LedgerKey, so it round-trips back into a
-- getLedgerEntries call and is what the `keyPrefix` filter matches against.
-- `value` is the decoded native value (JSONB); `value_xdr` is the raw
-- LedgerEntryData XDR. Both are null when the entry is not currently live.
CREATE TABLE IF NOT EXISTS contract_storage_entries (
    contract_id          TEXT NOT NULL,
    key                  TEXT NOT NULL,
    durability           TEXT NOT NULL,
    state                TEXT NOT NULL DEFAULT 'active',
    value                JSONB,
    value_xdr            TEXT,
    live_until_ledger    BIGINT,
    last_modified_ledger BIGINT NOT NULL,
    indexed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network              TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (contract_id, key, network),
    CONSTRAINT contract_storage_entries_durability_check CHECK (durability IN ('persistent', 'temporary')),
    CONSTRAINT contract_storage_entries_state_check      CHECK (state IN ('active', 'archived')),
    CONSTRAINT contract_storage_entries_ledger_check     CHECK (last_modified_ledger > 0)
);
-- Keyset pagination orders by (last_modified_ledger, key); this index serves
-- the contract-scoped, durability-filtered, cursor-paginated read.
CREATE INDEX IF NOT EXISTS idx_contract_storage_entries_lookup
    ON contract_storage_entries (contract_id, network, last_modified_ledger DESC, key DESC);

-- ─── Trustlines (Asset Analytics) ────────────────────────────────────────────

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

-- No secondary indexes, on purpose. Every statement that touches this table is
-- an indexer write keyed by the full primary key, and no API query reads it;
-- the four indexes 010_trustlines created were dropped by
-- 015_drop_unused_trustline_indexes on measured usage. See
-- docs/TRUSTLINES_INDEX_REVIEW.md before adding one back: an index here must
-- come with the query that reads it.

-- ─── Assets (Asset Analytics) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS assets (
    asset_code          TEXT NOT NULL,
    asset_issuer        TEXT NOT NULL,
    holder_count        INTEGER NOT NULL DEFAULT 0,
    first_seen_ledger   BIGINT NOT NULL,
    last_activity_ledger BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    issuer_home_domain  TEXT,
    issuer_metadata     JSONB,
    is_lookalike        BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (asset_code, asset_issuer, network),
    CONSTRAINT assets_asset_code_check          CHECK (asset_code <> ''),
    CONSTRAINT assets_asset_issuer_check        CHECK (asset_issuer <> ''),
    CONSTRAINT assets_holder_count_check        CHECK (holder_count >= 0),
    CONSTRAINT assets_first_seen_ledger_check   CHECK (first_seen_ledger > 0),
    CONSTRAINT assets_last_activity_ledger_check CHECK (last_activity_ledger > 0)
);

-- The assets listing: one network, most holders first, keyset-paged on
-- (holder_count, asset_code, asset_issuer). Point lookups use the primary key.
-- Every other secondary index this table had was measured unused and dropped in
-- 016_assets_index_review; see docs/ASSETS_INDEX_REVIEW.md before adding one
-- back. holder_count is written on the indexer's path, so this index already
-- keeps those updates from being HOT; another index here must come with the
-- query that reads it.
CREATE INDEX IF NOT EXISTS idx_assets_network_holders
    ON assets (network, holder_count DESC, asset_code, asset_issuer);

-- ─── Asset Volume Buckets (Asset Analytics) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS asset_volume_buckets (
    asset_code          TEXT NOT NULL,
    asset_issuer        TEXT NOT NULL,
    bucket_time         TIMESTAMPTZ NOT NULL,
    volume              NUMERIC(20, 7) NOT NULL DEFAULT 0,
    operation_count     INTEGER NOT NULL DEFAULT 0,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (asset_code, asset_issuer, bucket_time, network),
    CONSTRAINT asset_volume_buckets_asset_code_check    CHECK (asset_code <> ''),
    CONSTRAINT asset_volume_buckets_asset_issuer_check  CHECK (asset_issuer <> ''),
    CONSTRAINT asset_volume_buckets_volume_check        CHECK (volume >= 0),
    CONSTRAINT asset_volume_buckets_operation_count_check CHECK (operation_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_asset_volume_buckets_asset_time
    ON asset_volume_buckets (asset_code, asset_issuer, network, bucket_time DESC);

CREATE INDEX IF NOT EXISTS idx_asset_volume_buckets_time
    ON asset_volume_buckets (bucket_time DESC);

CREATE OR REPLACE FUNCTION bucket_hour(ts TIMESTAMPTZ)
RETURNS TIMESTAMPTZ AS $$
    SELECT date_trunc('hour', ts);
$$ LANGUAGE SQL IMMUTABLE;

-- ─── Search and asset-filter indexes ──────────────────────────────────────
--
-- Trigram rather than tsvector for memos: Stellar memos are order references
-- and short codes rather than prose, and stemming an identifier is actively
-- wrong. One GIN trigram index serves both similarity ranking and ILIKE.
--
-- The index definitions here omit CONCURRENTLY, which migration 004 uses —
-- this file builds an empty database where the lock does not matter, and
-- CONCURRENTLY cannot run inside the transaction psql wraps a script in.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_transactions_memo_trgm
    ON transactions USING GIN (memo gin_trgm_ops)
    WHERE memo IS NOT NULL;

-- Migration 004 also built expression indexes on operations' asset_code,
-- asset_issuer and asset_type. Migration 019 dropped them: the asset filter
-- matches three roles with an OR, which no single-role index can serve, so
-- they were never read. See docs/OPERATIONS_INDEX_REVIEW.md.

-- ─── API Keys ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
    id                  SERIAL PRIMARY KEY,
    key_hash            TEXT NOT NULL UNIQUE,
    key_prefix          TEXT NOT NULL,
    label               TEXT NOT NULL,
    rate_limit          INTEGER NOT NULL DEFAULT 60, -- requests per minute
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at          TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    export_enabled      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at ON api_keys (revoked_at);

-- ─── Ledger Retry Queue ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ledger_retry_queue (
    ledger              BIGINT NOT NULL,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error          TEXT,
    first_failed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempted_at   TIMESTAMPTZ,
    permanently_failed  BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (ledger, network)
);

-- `network` leads because the retry worker polls one network at a time; see
-- db/migrations/015_retry_queue_network_index.sql.
CREATE INDEX IF NOT EXISTS idx_retry_queue_network_next_attempt
    ON ledger_retry_queue (network, next_attempt_at)
    WHERE NOT permanently_failed;

-- ─── Failed Ledgers ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS failed_ledgers (
    sequence        BIGINT NOT NULL,
    network         TEXT NOT NULL DEFAULT 'mainnet',
    error           TEXT,
    attempt_count   INTEGER NOT NULL DEFAULT 1,
    failed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sequence, network)
);

CREATE INDEX IF NOT EXISTS idx_failed_ledgers_sequence ON failed_ledgers (sequence, network);

CREATE TABLE IF NOT EXISTS dead_letter_operations (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL,
    ledger BIGINT NOT NULL,
    operation_id TEXT,
    payload JSONB NOT NULL,
    error TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    CONSTRAINT dead_letter_operations_status_check CHECK (status IN ('pending', 'processed'))
);
CREATE INDEX IF NOT EXISTS idx_dead_letter_operations_pending
    ON dead_letter_operations (network, created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS indexer_cursors (
    network TEXT NOT NULL,
    purpose TEXT NOT NULL,
    cursor BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (network, purpose),
    CONSTRAINT indexer_cursors_purpose_check CHECK (purpose IN ('forward', 'backfill', 'events'))
);

-- ─── Liquidity Pools (Issue #201) ─────────────────────────────────────────────

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

-- ─── Claimable Balances (Issue #202) ──────────────────────────────────────────

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
-- Page order for claimableBalances(asset:) / (sponsor:); see migrations/020_claimable_balances_listing.sql.
CREATE INDEX IF NOT EXISTS idx_claimable_balances_asset_page
    ON claimable_balances (asset, network, created_ledger DESC, balance_id DESC);
CREATE INDEX IF NOT EXISTS idx_claimable_balances_sponsor_page
    ON claimable_balances (sponsor, network, created_ledger DESC, balance_id DESC);
CREATE INDEX IF NOT EXISTS idx_cb_claimants_dest ON claimable_balance_claimants (destination, network);

-- ─── Path Payments (Issue #206) ──────────────────────────────────────────────

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

-- ─── Set Options: Signer & Threshold Changes (Issue #207) ────────────────────

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

-- ─── Admin Operations ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_operations (
    id              BIGSERIAL PRIMARY KEY,
    network         TEXT NOT NULL,
    command         TEXT NOT NULL,
    arguments       JSONB NOT NULL,
    success         BOOLEAN NOT NULL,
    details         TEXT,
    executed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_operations_network ON admin_operations (network, executed_at DESC);

-- Lower insert-triggered vacuum/analyze thresholds for the append-heavy tables.
-- transactions vacuums on a fixed row count so the visibility map keeps up with
-- the newest pages, which the covering listing index needs to skip the heap.
ALTER TABLE transactions SET (
    autovacuum_analyze_threshold = 5000,
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_vacuum_insert_threshold = 50000,
    autovacuum_vacuum_insert_scale_factor = 0
);

ALTER TABLE operations SET (
    autovacuum_vacuum_insert_threshold = 5000,
    autovacuum_vacuum_insert_scale_factor = 0.05,
    autovacuum_analyze_threshold = 5000,
    autovacuum_analyze_scale_factor = 0.02
);

-- ─── Consolidated from migrations ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_usage (
    id BIGSERIAL PRIMARY KEY,
    key_id INTEGER REFERENCES api_keys(id) ON DELETE CASCADE,
    operation_name TEXT,
    response_time_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network TEXT NOT NULL DEFAULT 'mainnet'
);

CREATE INDEX IF NOT EXISTS idx_api_usage_key_time
    ON api_usage (key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backfill_progress (
    network             TEXT NOT NULL,
    start_ledger        BIGINT NOT NULL,
    end_ledger          BIGINT NOT NULL,
    current_ledger      BIGINT NOT NULL,
    completed_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (network, start_ledger, end_ledger),
    CONSTRAINT backfill_progress_range_check CHECK (start_ledger <= end_ledger),
    CONSTRAINT backfill_progress_current_check CHECK (current_ledger >= start_ledger - 1 AND current_ledger <= end_ledger)
);

CREATE INDEX IF NOT EXISTS idx_backfill_progress_network
    ON backfill_progress (network)
    WHERE completed_at IS NULL;

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

CREATE TABLE IF NOT EXISTS contract_storage_history (
    contract_id          TEXT NOT NULL,
    key                  TEXT NOT NULL,
    durability           TEXT NOT NULL,
    value                JSONB,
    value_xdr            TEXT,
    live_until_ledger    BIGINT,
    last_modified_ledger BIGINT NOT NULL,
    indexed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network              TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (contract_id, key, last_modified_ledger, network),
    CONSTRAINT contract_storage_history_durability_check CHECK (durability IN ('persistent', 'temporary')),
    CONSTRAINT contract_storage_history_ledger_check     CHECK (last_modified_ledger > 0)
);

CREATE INDEX IF NOT EXISTS idx_contract_storage_history_time_range
    ON contract_storage_history (contract_id, network, last_modified_ledger DESC);

CREATE INDEX IF NOT EXISTS idx_contract_storage_history_key_lookup
    ON contract_storage_history (contract_id, key, network, last_modified_ledger DESC);

CREATE TABLE IF NOT EXISTS export_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
    filters JSONB,
    format TEXT NOT NULL CHECK (format IN ('csv', 'parquet')),
    output_location TEXT,
    error_message TEXT,
    row_count INTEGER,
    network TEXT NOT NULL DEFAULT 'mainnet',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CONSTRAINT export_jobs_completion_check CHECK (
        (status = 'complete' AND completed_at IS NOT NULL) OR
        (status != 'complete')
    )
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_status
    ON export_jobs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_export_jobs_requested_by
    ON export_jobs (requested_by, created_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_trades_pair
    ON trades (base_asset_code, counter_asset_code, network, ledger_close_time DESC);

CREATE INDEX IF NOT EXISTS idx_trades_base_asset
    ON trades (base_asset_type, base_asset_code, base_asset_issuer, network);

CREATE INDEX IF NOT EXISTS idx_trades_counter_asset
    ON trades (counter_asset_type, counter_asset_code, counter_asset_issuer, network);

CREATE INDEX IF NOT EXISTS idx_trades_base_account
    ON trades (base_account, network, ledger_close_time DESC);

CREATE INDEX IF NOT EXISTS idx_trades_counter_account
    ON trades (counter_account, network, ledger_close_time DESC);

CREATE INDEX IF NOT EXISTS idx_trades_ledger_close_time
    ON trades (ledger_close_time DESC);

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

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_network_successful_page
    ON transactions (network, successful, ledger DESC, hash DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_network_source_page
    ON transactions (network, source_account, ledger DESC, hash DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_network_created_at
    ON transactions (network, created_at DESC);


-- ─── Signers, contract deployments, activity rollups (017) ───────────────────

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

CREATE INDEX IF NOT EXISTS idx_sponsorships_by_sponsored
  ON sponsorships (network, sponsored_id);

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

-- Horizon effects, read by the `effects` GraphQL query (#225); populated by the
-- indexer (#203). See migrations/020_effects.sql for the column notes.
CREATE TABLE IF NOT EXISTS effects (
    id            TEXT NOT NULL,
    paging_token  TEXT NOT NULL,
    operation_id  TEXT NOT NULL,
    ledger        BIGINT NOT NULL,
    account       TEXT NOT NULL,
    type          TEXT NOT NULL,
    type_i        INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL,
    details       JSONB NOT NULL DEFAULT '{}'::jsonb,
    network       TEXT NOT NULL DEFAULT 'mainnet',
    indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, network),
    CONSTRAINT effects_id_check   CHECK (id <> ''),
    CONSTRAINT effects_type_check CHECK (type <> '')
);

-- effects(account): one account's feed, newest first, resumed by (ledger, id).
CREATE INDEX IF NOT EXISTS idx_effects_account
    ON effects (account, network, ledger DESC, id DESC);

-- effects(account, type): the same feed narrowed to one effect type.
CREATE INDEX IF NOT EXISTS idx_effects_account_type
    ON effects (account, type, network, ledger DESC, id DESC);
