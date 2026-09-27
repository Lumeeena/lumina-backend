-- Volume seed for the migration test (graphql-server/src/migrations.integration.test.ts).
--
-- ## Why this is not db/seed.sql
--
-- db/seed.sql is ten hand-written rows for local development, mounted into the
-- docker postgres image. It answers "is there something to look at". This file
-- answers a different question — "does a migration still work when the tables
-- are not empty" — and for that the row *count* is the point: an index rebuild
-- or a validating constraint takes milliseconds on ten rows and minutes on ten
-- million, and only the second number tells anyone anything.
--
-- ## Why it is deterministic
--
-- Nothing calls random(). Every value derives from md5 of a row index, so two
-- runs produce byte-identical tables. That is what lets the test compare a
-- checksum before and after a migration: if the data is regenerated differently
-- each run, a checksum mismatch would mean nothing.
--
-- ## Why `network` is not listed
--
-- Every table has a DEFAULT for it, so omitting the column works whether this
-- seed lands before or after 007_networks.sql adds it. The seed is applied to
-- the schema as it stands after the pre-data migrations, and should keep
-- working if the chain is reordered.
--
-- ## Sizes
--
-- Chosen so the data-touching migrations are measurable but the whole test
-- still fits in a CI job. Scale them with the variables in the `scale` CTE
-- below; the test reports the row counts it actually used alongside the
-- durations, so a recorded duration is always attributable to a row count.

BEGIN;

-- ─── Knobs ───────────────────────────────────────────────────────────────────

CREATE TEMP TABLE migration_seed_scale AS
SELECT
    30000::int  AS n_ledgers,
    60000::int  AS n_transactions,
    200000::int AS n_operations,
    20000::int  AS n_accounts,
    50000::int  AS n_events,
    50000::int  AS n_custom_events,
    TIMESTAMPTZ '2026-01-01 00:00:00+00' AS epoch;

-- Deterministic helpers, session-scoped so they vanish with the connection.

CREATE FUNCTION pg_temp.seed_hash(seed text) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
    SELECT ('x' || substr(md5(seed), 1, 8))::bit(32)::bigint
$$;

CREATE FUNCTION pg_temp.seed_int(seed text, k int) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
    SELECT (pg_temp.seed_hash(seed) % k)::int
$$;

CREATE FUNCTION pg_temp.seed_account(seed text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT 'G' || upper(substr(md5('acct:' || seed), 1, 32) || substr(md5('acct2:' || seed), 1, 23))
$$;

CREATE FUNCTION pg_temp.seed_contract(seed text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT 'C' || upper(substr(md5('ctr:' || seed), 1, 32) || substr(md5('ctr2:' || seed), 1, 23))
$$;

CREATE FUNCTION pg_temp.seed_toid(ledger bigint, lo bigint) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT lpad(((ledger << 32) | (lo % 4294967296))::text, 20, '0')
$$;

-- ─── Ledgers ─────────────────────────────────────────────────────────────────

INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count, base_fee, base_reserve)
SELECT
    1 + g,
    c.epoch + g * interval '5 seconds',
    2,
    6,
    100,
    5000000
FROM migration_seed_scale c, generate_series(0, c.n_ledgers - 1) g;

-- ─── Accounts ────────────────────────────────────────────────────────────────

INSERT INTO accounts (address, sequence, subentry_count, last_modified_ledger, num_sponsored, num_sponsoring, balances, flags, thresholds)
SELECT
    pg_temp.seed_account(g::text),
    lpad((100000000000 + pg_temp.seed_hash('seq:' || g) % 900000000)::text, 18, '0'),
    pg_temp.seed_int('sub:' || g, 6),
    1 + pg_temp.seed_int('lm:' || g, 29999),
    0,
    0,
    jsonb_build_array(jsonb_build_object('asset_type', 'native', 'balance', (pg_temp.seed_hash('bal:' || g) % 100000000)::text)),
    '{}'::jsonb,
    '{"low_threshold":1,"med_threshold":2,"high_threshold":3}'::jsonb
FROM migration_seed_scale c, generate_series(1, c.n_accounts) g;

-- ─── Transactions ────────────────────────────────────────────────────────────

CREATE TEMP TABLE migration_seed_tx AS
SELECT
    g AS n,
    md5('tx:' || g) AS hash,
    1 + (g % (SELECT n_ledgers FROM migration_seed_scale)) AS ledger,
    CASE
        WHEN pg_temp.seed_int('src:' || g, 100) < 3 THEN pg_temp.seed_account('hot')
        ELSE pg_temp.seed_account((pg_temp.seed_int('acct:' || g, (SELECT n_accounts FROM migration_seed_scale)) + 1)::text)
    END AS source_account,
    CASE
        WHEN pg_temp.seed_int('memo:' || g, 100) < 30
            THEN 'ORDER-' || lpad((pg_temp.seed_int('memoform:' || g, 9000) + 1000)::text, 4, '0')
        ELSE NULL
    END AS memo
FROM migration_seed_scale c, generate_series(1, c.n_transactions) g;

INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo)
SELECT
    t.hash,
    t.ledger,
    c.epoch + t.ledger * interval '5 seconds',
    t.source_account,
    100,
    3,
    t.n % 100 <> 0,
    CASE WHEN t.memo IS NULL THEN NULL ELSE 'text' END,
    t.memo
FROM migration_seed_tx t, migration_seed_scale c;

-- ─── Operations ──────────────────────────────────────────────────────────────
-- Ids are in Horizon's toid shape (ledger in the high bits), so id order agrees
-- with ledger order — which is what the keyset queries and the partition bounds
-- both assume.

INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details)
SELECT
    pg_temp.seed_toid(t.ledger, t.n * 4 + i),
    CASE pg_temp.seed_int('type:' || t.n || ':' || i, 100)
        WHEN 0 THEN 'manage_offer'
        WHEN 1 THEN 'create_account'
        ELSE 'payment'
    END,
    t.hash,
    t.ledger,
    c.epoch + t.ledger * interval '5 seconds',
    t.source_account,
    CASE
        WHEN pg_temp.seed_int('type:' || t.n || ':' || i, 100) = 0 THEN
            jsonb_build_object(
                'selling_asset_type', 'credit_alphanum4',
                'selling_asset_code', 'USDC',
                'buying_asset_type', 'native',
                'amount', (pg_temp.seed_hash('amt:' || t.n) % 100000)::text
            )
        WHEN pg_temp.seed_int('type:' || t.n || ':' || i, 100) = 1 THEN
            jsonb_build_object(
                'account', pg_temp.seed_account('new:' || t.n),
                'funder', t.source_account,
                'starting_balance', '2.0000000'
            )
        ELSE
            jsonb_build_object(
                'from', t.source_account,
                'to', pg_temp.seed_account((pg_temp.seed_int('to:' || t.n || ':' || i, (SELECT n_accounts FROM migration_seed_scale)) + 1)::text),
                'amount', (pg_temp.seed_hash('pamt:' || t.n) % 100000)::text,
                'asset_type', CASE WHEN pg_temp.seed_int('asset:' || t.n, 100) < 40 THEN 'credit_alphanum4' ELSE 'native' END
            )
    END
FROM migration_seed_tx t
CROSS JOIN migration_seed_scale c
CROSS JOIN generate_series(0, 2) i;

-- ─── Contract events ─────────────────────────────────────────────────────────

INSERT INTO contract_events (id, type, contract_id, ledger, created_at, paging_token, topics, value)
SELECT
    pg_temp.seed_toid(1 + (g % (SELECT n_ledgers FROM migration_seed_scale)), g),
    'contract',
    CASE WHEN pg_temp.seed_int('evctr:' || g, 100) < 40
         THEN pg_temp.seed_contract('hot')
         ELSE pg_temp.seed_contract((g % 500)::text)
    END,
    1 + (g % (SELECT n_ledgers FROM migration_seed_scale)),
    c.epoch + (1 + (g % (SELECT n_ledgers FROM migration_seed_scale))) * interval '5 seconds',
    pg_temp.seed_toid(1 + (g % (SELECT n_ledgers FROM migration_seed_scale)), g),
    ARRAY['transfer', pg_temp.seed_account('evfrom:' || g)],
    jsonb_build_object('amount', (pg_temp.seed_hash('evamt:' || g) % 100000)::text)
FROM migration_seed_scale c, generate_series(1, c.n_events) g;

-- ─── Registered schema and decoded custom events ─────────────────────────────

INSERT INTO contract_schemas (contract_id, version, definition)
SELECT
    pg_temp.seed_contract('hot'),
    1,
    jsonb_build_object(
        'contractId', pg_temp.seed_contract('hot'),
        'version', 1,
        'events', jsonb_build_array(
            jsonb_build_object(
                'name', 'transfer', 'topic', 'transfer',
                'fields', jsonb_build_array(
                    jsonb_build_object('name', 'from', 'type', 'address', 'source', 'topic[1]'),
                    jsonb_build_object('name', 'amount', 'type', 'i128', 'source', 'value.amount')
                )
            )
        )
    );

INSERT INTO custom_events (event_id, contract_id, event_name, ledger, created_at, schema_version, fields)
SELECT
    pg_temp.seed_toid(1 + (g % (SELECT n_ledgers FROM migration_seed_scale)), g),
    pg_temp.seed_contract('hot'),
    'transfer',
    1 + (g % (SELECT n_ledgers FROM migration_seed_scale)),
    c.epoch + (1 + (g % (SELECT n_ledgers FROM migration_seed_scale))) * interval '5 seconds',
    1,
    jsonb_build_object(
        'from', pg_temp.seed_account('cevfrom:' || g),
        'amount', (pg_temp.seed_hash('cevamt:' || g) % 100000)::text
    )
FROM migration_seed_scale c, generate_series(1, c.n_custom_events) g;

COMMIT;

ANALYZE ledgers;
ANALYZE transactions;
ANALYZE operations;
ANALYZE accounts;
ANALYZE contract_events;
ANALYZE contract_schemas;
ANALYZE custom_events;
