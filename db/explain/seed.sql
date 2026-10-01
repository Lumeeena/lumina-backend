-- Query-plan audit seed: a deterministic, production-shaped database.
--
-- ## Why this exists
--
-- EXPLAIN ANALYZE on an empty or toy table is worse than useless: on a small
-- table the planner correctly prefers a sequential scan, so every query "fails"
-- the audit and no query tells you anything. This produces a database where the
-- cardinalities are large enough that a sequential scan is a real cost and the
-- planner has to choose, so the plans it picks are the plans the queries get in
-- production.
--
-- ## Why it is deterministic
--
-- Nothing here calls random(). Every value derives from md5 of a row index, so
-- the same seed always produces the same database — which is what makes a
-- recorded plan comparable to the next run. A baseline you cannot reproduce is
-- just a screenshot.
--
-- ## Why the fixtures are computed, not hardcoded
--
-- The last section writes named values (`explain_fixtures`) drawn from the rows
-- actually loaded. A catalog that hardcoded ids would break silently the moment
-- the seed changed: the query would return zero rows, the plan would look
-- better, and the audit would report a healthy index on an empty result set.
--
-- ## Applying it
--
--   npm run explain:seed
--
-- The runner applies db/schema.sql, then this file, then db/schema.sql again
-- (the expensive indexes are dropped below so the load is not maintaining them
-- row by row; schema.sql recreates them, so their definitions cannot drift from
-- what ships), then VACUUM (ANALYZE).
--
-- Only ever run against a scratch database: it TRUNCATEs every table.

BEGIN;

-- ─── Knobs ───────────────────────────────────────────────────────────────────
-- One place to change scale. Sizes are chosen so the planner's choices are the
-- production ones: a 2M-row transactions table is past the point where the
-- index-vs-scan crossover sits for the predicates below, and the skews (see
-- each section) are what make particular queries selective or not.

CREATE TEMP TABLE seed_config AS
SELECT
    200000::int     AS n_ledgers,
    56000001::bigint AS first_ledger,
    2000000::int    AS n_tx,
    400000::int     AS n_accounts,
    1200000::int    AS n_events,
    1000000::int    AS n_custom,
    TIMESTAMPTZ '2025-06-01 00:00:00+00' AS epoch,
    2000::int       AS hot_window_ledgers,   -- recent ledgers carrying the bulk of traffic
    600::int        AS tx_per_hot_ledger,
    3::int          AS ops_per_tx;

-- Session-scoped helpers. pg_temp means they vanish with the connection and
-- never touch the database a future caller might point this at.

-- A deterministic 32-bit unsigned integer from a seed string.
CREATE FUNCTION pg_temp.h(seed text) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
    SELECT ('x' || substr(md5(seed), 1, 8))::bit(32)::bigint
$$;

-- Deterministic integer in [0, k).
CREATE FUNCTION pg_temp.hk(seed text, k int) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
    SELECT (pg_temp.h(seed) % k)::int
$$;

-- A well-formed Stellar account address (G, 56 chars) from a seed string.
CREATE FUNCTION pg_temp.addr(seed text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT 'G' || upper(substr(md5('addr:' || seed), 1, 32) || substr(md5('addr2:' || seed), 1, 23))
$$;

-- A well-formed Soroban contract address (C, 56 chars) from a seed string.
CREATE FUNCTION pg_temp.contract(seed text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT 'C' || upper(substr(md5('ctr:' || seed), 1, 32) || substr(md5('ctr2:' || seed), 1, 23))
$$;

-- Horizon-style toid: ledger in the high bits, so id order tracks ledger order.
CREATE FUNCTION pg_temp.toid(ledger bigint, lo bigint) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT lpad(((ledger << 32) | (lo % 4294967296))::text, 20, '0')
$$;

-- The named accounts the catalog filters on. Whale is deliberately 2% of
-- transactions: on a 2M-row table the crossover where an index stops paying is
-- roughly (rows x random_page_cost) vs the table's page count, about 12k rows —
-- an account with a few thousand rows would leave the index in place and the
-- audit would draw the wrong conclusion from an undersized fixture.
CREATE TEMP TABLE seed_faces AS
SELECT
    pg_temp.addr('whale')       AS whale,
    pg_temp.addr('cold')        AS cold,
    pg_temp.contract('hot')     AS hot_contract,
    pg_temp.contract('warm')    AS warm_contract,
    pg_temp.contract('cold')    AS cold_contract,
    pg_temp.addr('usdc_issuer') AS usdc_issuer,
    pg_temp.addr('aqua_issuer') AS aqua_issuer,
    pg_temp.addr('zz_issuer')   AS zz_issuer;

-- ─── Reset ───────────────────────────────────────────────────────────────────

TRUNCATE operations, transactions, ledgers, contract_events, custom_events,
         contract_schemas, accounts;

-- ─── Indexes down for the load ───────────────────────────────────────────────
-- These are the GIN indexes plus the partial expression indexes: building them
-- row by row during a 10M-row load is most of the wall clock.
--
-- Their definitions are read back out of the catalogue first and re-executed
-- afterwards, rather than being re-applied from db/schema.sql. schema.sql is
-- not idempotent (its earlier CREATE INDEX statements have no IF NOT EXISTS, so
-- re-running it on a populated database errors), and copying the definitions
-- here would let them drift from what ships. Reading them from the database
-- means they are the shipped definitions by construction — they got there by
-- being run from schema.sql.

CREATE TEMP TABLE seed_indexes AS
SELECT indexname, indexdef
FROM pg_indexes
WHERE indexname IN (
    'idx_operations_details',
    'idx_transactions_memo_trgm',
    'idx_events_topics',
    'idx_operations_asset_code',
    'idx_operations_asset_issuer',
    'idx_operations_asset_type',
    'idx_custom_events_fields'
);

DROP INDEX IF EXISTS idx_operations_details;
DROP INDEX IF EXISTS idx_transactions_memo_trgm;
DROP INDEX IF EXISTS idx_events_topics;
DROP INDEX IF EXISTS idx_operations_asset_code;
DROP INDEX IF EXISTS idx_operations_asset_issuer;
DROP INDEX IF EXISTS idx_operations_asset_type;
DROP INDEX IF EXISTS idx_custom_events_fields;

-- ─── Ledgers ─────────────────────────────────────────────────────────────────
-- 200k ledgers, five seconds apart, starting at a mainnet-shaped sequence.

INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count, base_fee, base_reserve)
SELECT
    c.first_ledger + g - 1,
    c.epoch + (g - 1) * interval '5 seconds',
    -- Matches the transaction skew below, so ledger.transaction_count is not a
    -- number that contradicts the rows.
    CASE WHEN g > c.n_ledgers - c.hot_window_ledgers THEN c.tx_per_hot_ledger
         ELSE 4 END,
    CASE WHEN g > c.n_ledgers - c.hot_window_ledgers THEN c.tx_per_hot_ledger * c.ops_per_tx
         ELSE 4 * c.ops_per_tx END,
    100,
    5000000
FROM seed_config c, generate_series(1, c.n_ledgers) g;

-- ─── Accounts ────────────────────────────────────────────────────────────────
-- 400k accounts: a handful of named ones the queries filter on, then a long tail.

INSERT INTO accounts (address, sequence, subentry_count, last_modified_ledger, num_sponsored, num_sponsoring, balances, flags, thresholds)
SELECT
    a.address,
    lpad((100000000000 + pg_temp.h('seq:' || a.address) % 900000000)::text, 18, '0'),
    pg_temp.hk('sub:' || a.address, 6),
    c.first_ledger + c.n_ledgers - 1 - pg_temp.hk('lastmod:' || a.address, 100000),
    0,
    0,
    jsonb_build_array(jsonb_build_object(
        'asset_type', 'native',
        'balance', (pg_temp.h('bal:' || a.address) % 100000000000)::text
    )),
    '{}'::jsonb,
    '{"low_threshold":1,"med_threshold":2,"high_threshold":3}'::jsonb
FROM seed_config c,
     LATERAL (SELECT pg_temp.addr('whale') AS address
      UNION ALL SELECT pg_temp.addr('cold')
      UNION ALL SELECT pg_temp.addr('usdc_issuer')
      UNION ALL SELECT pg_temp.addr('aqua_issuer')
      UNION ALL SELECT pg_temp.addr('zz_issuer')
      UNION ALL SELECT pg_temp.addr('warm_' || (g % 50)) FROM generate_series(1, 50) g
      UNION ALL SELECT pg_temp.addr('acct_' || g) FROM generate_series(1, c.n_accounts) g) a
ON CONFLICT (address) DO NOTHING;

-- ─── Transactions ────────────────────────────────────────────────────────────
-- 2M, with a deliberately uneven ledger distribution: 60% of traffic lands in
-- the newest 2000 ledgers (600 each), the remaining 40% spreads over the other
-- 198k (~4 each). Uniform 10-per-ledger would make the recent-history queries
-- unrealistically cheap and the subscription-replay path unrepresentative —
-- real networks have busy periods, and that is where these queries live.

CREATE TEMP TABLE seed_tx AS
SELECT
    n,
    md5('tx:' || n) AS hash,
    CASE
        WHEN n <= 1200000 THEN c.first_ledger + (c.n_ledgers - c.hot_window_ledgers) + (n % c.hot_window_ledgers)
        ELSE c.first_ledger + (n % (c.n_ledgers - c.hot_window_ledgers))
    END AS ledger,
    CASE
        -- 2% one whale, 15% a 50-address warm set, 83% uniform long tail.
        WHEN pg_temp.hk('src:' || n, 100) < 2  THEN pg_temp.addr('whale')
        WHEN pg_temp.hk('src:' || n, 100) < 17 THEN pg_temp.addr('warm_' || (n % 50))
        ELSE pg_temp.addr('acct_' || (pg_temp.hk('acct:' || n, c.n_accounts) + 1))
    END AS source_account,
    m.memo,
    -- Derived from the memo rather than decided separately: the two drifting
    -- apart is a data bug that no plan would ever reveal.
    CASE WHEN m.memo IS NULL THEN NULL ELSE 'text' END AS memo_type
FROM seed_config c, generate_series(1, c.n_tx) n,
     LATERAL (
         SELECT CASE
             -- Named fixtures come first, so they land regardless of the
             -- 30%-of-transactions bucket below. Behind it, a memo the search
             -- catalog queries for could be dropped silently, and the captured
             -- plan would be the plan for a query that matches nothing —
             -- without ever saying so.
             WHEN n = 2 THEN 'ORDER-4471'
             WHEN n = 3 THEN 'ORDER-4471-REFUND'
             WHEN n = 4 THEN 'ORDR-4471'
             WHEN n = 5 THEN 'INVOICE-9920'
             WHEN n = 6 THEN 'coffee money'
             -- Most transactions carry no memo at all, and the trigram index is
             -- partial for exactly that reason.
             WHEN pg_temp.hk('memo:' || n, 100) >= 30 THEN NULL
             -- A set of shared shapes, so a search matches thousands of rows...
             WHEN pg_temp.hk('memoform:' || n, 100) < 40 THEN 'ORDER-' || lpad((pg_temp.hk('memoa:' || n, 9000) + 1000)::text, 4, '0')
             WHEN pg_temp.hk('memoform:' || n, 100) < 70 THEN 'INV-' || lpad((pg_temp.hk('memob:' || n, 9000) + 1000)::text, 4, '0')
             -- ...and a long tail of distinct ones, so the index's selectivity
             -- is realistic rather than one giant posting list.
             ELSE 'REF-' || upper(substr(md5('ref:' || n), 1, 12))
         END AS memo
     ) m;

INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo)
SELECT
    t.hash,
    t.ledger,
    c.epoch + (t.ledger - c.first_ledger) * interval '5 seconds' + (t.n % 600) * interval '1 millisecond',
    t.source_account,
    100 + (t.n % 5) * 100,
    c.ops_per_tx,
    t.n % 100 <> 0,          -- ~1% failed, as a real network has
    t.memo_type,
    t.memo
FROM seed_tx t, seed_config c;

-- ─── Operations ──────────────────────────────────────────────────────────────
-- Three per transaction, ids in Horizon's toid shape so id order agrees with
-- ledger order — the keyset comparisons and the replay path's ORDER BY id ASC
-- both depend on that agreement being real.

INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details)
SELECT
    pg_temp.toid(t.ledger, t.n * 4 + i),
    ot.type,
    t.hash,
    t.ledger,
    c.epoch + (t.ledger - c.first_ledger) * interval '5 seconds' + (t.n % 600) * interval '1 millisecond' + i * interval '100 microseconds',
    t.source_account,
    ot.details
FROM seed_tx t
CROSS JOIN seed_config c
CROSS JOIN generate_series(0, (SELECT ops_per_tx - 1 FROM seed_config)) i
CROSS JOIN LATERAL (
    SELECT
        -- Type mix roughly following mainnet: payments and offers dominate,
        -- manage_data is the rare type the audit uses to show an index that is
        -- actually used (60k rows against 6M).
        CASE
            WHEN b.type_bucket < 55 THEN 'payment'
            WHEN b.type_bucket < 67 THEN 'manage_offer'
            WHEN b.type_bucket < 77 THEN 'path_payment'
            WHEN b.type_bucket < 85 THEN 'create_account'
            WHEN b.type_bucket < 91 THEN 'set_options'
            WHEN b.type_bucket < 96 THEN 'change_trust'
            WHEN b.type_bucket < 97 THEN 'manage_data'
            ELSE 'bump_sequence'
        END AS type,
        CASE
            WHEN b.type_bucket < 55 THEN
                -- Payments: the counterparty fields the replay path matches on.
                jsonb_strip_nulls(jsonb_build_object(
                    'from', t.source_account,
                    -- The whale and the cold account appear as recipients far
                    -- more often than their share, so the replay query's OR
                    -- branches actually match rows rather than being measured
                    -- against an empty result.
                    'to', CASE
                            WHEN pg_temp.hk('to:' || t.n || ':' || i, 100) < 6 THEN (SELECT whale FROM seed_faces)
                            WHEN pg_temp.hk('to:' || t.n || ':' || i, 100) < 20 THEN (SELECT cold FROM seed_faces)
                            ELSE pg_temp.addr('acct_' || (pg_temp.hk('toacct:' || t.n || ':' || i, c.n_accounts) + 1))
                          END,
                    'amount', ((pg_temp.h('amt:' || t.n || ':' || i) % 100000000) / 100.0)::text,
                    'asset_type', b.asset_type,
                    'asset_code', b.asset_code,
                    'asset_issuer', b.asset_issuer
                ))
            WHEN b.type_bucket < 67 THEN
                -- Offers carry both sides, which is why the asset filter's three
                -- roles cannot be collapsed into one indexed column.
                jsonb_strip_nulls(jsonb_build_object(
                    'selling_asset_type', b.asset_type,
                    'selling_asset_code', b.asset_code,
                    'selling_asset_issuer', b.asset_issuer,
                    'buying_asset_type', b.buying_asset_type,
                    'buying_asset_code', b.buying_asset_code,
                    'buying_asset_issuer', bi.buying_asset_issuer,
                    'amount', ((pg_temp.h('offamt:' || t.n || ':' || i) % 1000000) / 100.0)::text,
                    'price', ((pg_temp.h('price:' || t.n) % 10000) / 10000.0)::text
                ))
            WHEN b.type_bucket < 77 THEN
                jsonb_strip_nulls(jsonb_build_object(
                    'from', t.source_account,
                    'to', pg_temp.addr('acct_' || (pg_temp.hk('ptoa:' || t.n || ':' || i, c.n_accounts) + 1)),
                    'amount', ((pg_temp.h('pamt:' || t.n || ':' || i) % 100000000) / 100.0)::text,
                    'asset_type', b.asset_type,
                    'asset_code', b.asset_code,
                    'asset_issuer', b.asset_issuer,
                    'source_amount', ((pg_temp.h('samt:' || t.n || ':' || i) % 100000000) / 100.0)::text,
                    'source_asset_type', 'native'
                ))
            WHEN b.type_bucket < 85 THEN
                jsonb_build_object(
                    'account', pg_temp.addr('newacct_' || (pg_temp.hk('new:' || t.n || ':' || i, 100000) + 1)),
                    'funder', t.source_account,
                    'starting_balance', ((pg_temp.h('sb:' || t.n) % 100000) / 100.0)::text
                )
            WHEN b.type_bucket < 91 THEN jsonb_build_object('home_domain', 'example' || (t.n % 500)::text || '.org')
            WHEN b.type_bucket < 96 THEN
                jsonb_strip_nulls(jsonb_build_object(
                    'asset_type', b.asset_type,
                    'asset_code', b.asset_code,
                    'asset_issuer', b.asset_issuer,
                    'limit', ((pg_temp.h('lim:' || t.n) % 1000000) / 100.0)::text
                ))
            WHEN b.type_bucket < 97 THEN jsonb_build_object('name', 'k' || (t.n % 20)::text, 'value', substr(md5('md:' || t.n), 1, 8))
            ELSE jsonb_build_object('bump_to', '0')
        END AS details
    FROM LATERAL (
        SELECT
            pg_temp.hk('optype:' || t.n || ':' || i, 100) AS type_bucket,
            pg_temp.hk('asset:' || t.n || ':' || i, 1000) AS asset_bucket,
            -- Asset mix: one hot asset, a couple of mid ones, a rare one, and
            -- mostly the native asset. The rare one (0.5% of payments) is the
            -- decisive fixture: a predicate that matches ~16k of 6M rows is one
            -- an index would obviously help, so a scan there is unambiguous.
            CASE
                WHEN pg_temp.hk('asset:' || t.n || ':' || i, 1000) < 400 THEN 'USDC'
                WHEN pg_temp.hk('asset:' || t.n || ':' || i, 1000) < 450 THEN 'AQUA'
                WHEN pg_temp.hk('asset:' || t.n || ':' || i, 1000) < 455 THEN 'ZZ'
                ELSE NULL
            END AS asset_code
    ) ab,
    LATERAL (
        SELECT
            ab.type_bucket,
            ab.asset_bucket,
            CASE
                WHEN ab.asset_code IS NULL THEN 'native'
                ELSE 'credit_alphanum4'
            END AS asset_type,
            ab.asset_code,
            CASE ab.asset_code
                WHEN 'USDC' THEN (SELECT usdc_issuer FROM seed_faces)
                WHEN 'AQUA' THEN (SELECT aqua_issuer FROM seed_faces)
                WHEN 'ZZ'   THEN (SELECT zz_issuer FROM seed_faces)
                ELSE NULL
            END AS asset_issuer,
            -- The buying side of an offer: a different, commonly-quoted asset.
            CASE
                WHEN pg_temp.hk('basset:' || t.n || ':' || i, 100) < 30 THEN 'native'
                WHEN pg_temp.hk('basset:' || t.n || ':' || i, 100) < 60 THEN 'credit_alphanum4'
                ELSE 'credit_alphanum12'
            END AS buying_asset_type,
            CASE
                WHEN pg_temp.hk('basset:' || t.n || ':' || i, 100) < 30 THEN NULL
                WHEN pg_temp.hk('basset:' || t.n || ':' || i, 100) < 60 THEN 'USDC'
                ELSE 'AQUA'
            END AS buying_asset_code
    ) b,
    LATERAL (
        SELECT
            CASE b.buying_asset_code
                WHEN 'USDC' THEN (SELECT usdc_issuer FROM seed_faces)
                WHEN 'AQUA' THEN (SELECT aqua_issuer FROM seed_faces)
                ELSE NULL
            END AS buying_asset_issuer
    ) bi
) ot;

-- ─── Soroban contract events ─────────────────────────────────────────────────
-- 1.2M events: one contract carries 40% of them, one 5%, and ~5000 share the
-- rest. The hot contract is what makes the "first page for a busy contract"
-- plan interesting; the long tail is what makes it noisy.

CREATE TEMP TABLE seed_events AS
SELECT
    g AS n,
    CASE
        WHEN g <= 480000 THEN (SELECT hot_contract FROM seed_faces)
        WHEN g <= 540000 THEN (SELECT warm_contract FROM seed_faces)
        ELSE pg_temp.contract('cold_' || (g % 5000))
    END AS contract_id,
    CASE WHEN g <= 480000
         THEN 56000001 + 198000 + (g % 2000)
         ELSE 56000001 + (g % 198000)
    END AS ledger,
    g % 5 AS topic_shape
FROM seed_config c, generate_series(1, c.n_events) g;

INSERT INTO contract_events (id, type, contract_id, ledger, created_at, paging_token, topics, value)
SELECT
    pg_temp.toid(e.ledger, e.n),
    'contract',
    e.contract_id,
    e.ledger,
    c.epoch + (e.ledger - c.first_ledger) * interval '5 seconds',
    pg_temp.toid(e.ledger, e.n),
    CASE e.topic_shape
        WHEN 0 THEN ARRAY['transfer', pg_temp.addr('evt_from_' || e.n), pg_temp.addr('evt_to_' || e.n)]
        WHEN 1 THEN ARRAY['transfer', pg_temp.addr('evt_from_' || e.n), pg_temp.addr('evt_to_' || e.n)]
        WHEN 2 THEN ARRAY['swap', pg_temp.addr('evt_from_' || e.n)]
        WHEN 3 THEN ARRAY['mint', pg_temp.addr('evt_to_' || e.n)]
        ELSE ARRAY['transfer', pg_temp.addr('evt_from_' || e.n), pg_temp.addr('evt_to_' || e.n)]
    END,
    jsonb_build_object(
        'amount', (pg_temp.h('evamt:' || e.n) % 100000000)::text,
        'to', pg_temp.addr('evt_to_' || e.n)
    )
FROM seed_events e, seed_config c;

-- ─── Custom (decoded) events ─────────────────────────────────────────────────
-- 1M rows for one registered schema: 70% a single hot event, and a long tail
-- across other contracts. Every value is a string, matching what the decoder
-- stores (indexer/src/customDecode.ts) — amounts as exact decimal text, which
-- is why the numeric filter has to cast.

CREATE TEMP TABLE seed_custom AS
SELECT
    g AS n,
    CASE
        WHEN g <= 700000 THEN (SELECT hot_contract FROM seed_faces)
        WHEN g <= 700300 THEN (SELECT hot_contract FROM seed_faces)
        ELSE pg_temp.contract('cother_' || (g % 200))
    END AS contract_id,
    CASE
        WHEN g <= 700000 THEN 'transfer'
        WHEN g <= 700300 THEN 'swap'
        ELSE 'transfer'
    END AS event_name,
    CASE WHEN g <= 700000
         THEN 56000001 + 198000 + (g % 2000)
         ELSE 56000001 + (g % 198000)
    END AS ledger
FROM seed_config c, generate_series(1, c.n_custom) g;

INSERT INTO custom_events (event_id, contract_id, event_name, ledger, created_at, schema_version, fields)
SELECT
    pg_temp.toid(e.ledger, e.n),
    e.contract_id,
    e.event_name,
    e.ledger,
    c.epoch + (e.ledger - c.first_ledger) * interval '5 seconds',
    1,
    CASE
        WHEN e.event_name = 'swap' THEN jsonb_build_object(
            'from', pg_temp.addr('cev_from_' || e.n),
            'amount', (pg_temp.h('cevamt:' || e.n) % 1000000)::text
        )
        ELSE jsonb_build_object(
            'from', pg_temp.addr('cev_from_' || e.n),
            -- A recipient shared by ~30% of rows: the unselective filter the
            -- audit uses to show a filter no index on this table can serve.
            'to', CASE WHEN pg_temp.hk('cevto:' || e.n, 100) < 30
                       THEN pg_temp.addr('cev_common_recipient')
                       ELSE pg_temp.addr('cev_to_' || e.n) END,
            'amount', (pg_temp.h('cevamt:' || e.n) % 1000000)::text
        )
    END
FROM seed_custom e, seed_config c;

-- The one registered schema. Kept in step with the fields above; the runner
-- re-registers it through the production upsertContractSchema so the validator,
-- not this file, has the last word on whether it is well-formed.
INSERT INTO contract_schemas (contract_id, version, definition, updated_at)
SELECT
    f.hot_contract,
    1,
    jsonb_build_object(
        'contractId', f.hot_contract,
        'version', 1,
        'events', jsonb_build_array(
            jsonb_build_object(
                'name', 'transfer', 'topic', 'transfer',
                'fields', jsonb_build_array(
                    jsonb_build_object('name', 'from', 'type', 'address', 'source', 'topic[1]'),
                    jsonb_build_object('name', 'to', 'type', 'address', 'source', 'topic[2]'),
                    jsonb_build_object('name', 'amount', 'type', 'i128', 'source', 'value.amount')
                )
            ),
            jsonb_build_object(
                'name', 'swap', 'topic', 'swap',
                'fields', jsonb_build_array(
                    jsonb_build_object('name', 'from', 'type', 'address', 'source', 'topic[1]'),
                    jsonb_build_object('name', 'amount', 'type', 'i128', 'source', 'value.amount')
                )
            )
        )
    ),
    NOW()
FROM seed_faces f
ON CONFLICT (contract_id) DO UPDATE SET definition = EXCLUDED.definition, updated_at = NOW();

-- ─── Indexes back up ─────────────────────────────────────────────────────────
-- Verbatim the definitions read back at the start, so a plan captured after a
-- re-seed is a plan against the indexes the project actually ships.

DO $$
DECLARE definition text;
BEGIN
    FOR definition IN SELECT indexdef FROM seed_indexes LOOP
        EXECUTE definition;
    END LOOP;
END $$;

COMMIT;

-- ─── Fixtures ────────────────────────────────────────────────────────────────
-- Named values drawn from the rows just loaded, so the catalog can never point
-- at a row that is not there. Audit-only table; it exists in this scratch
-- database and nowhere else.

CREATE TABLE IF NOT EXISTS explain_fixtures (
    name        TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    note        TEXT
);

TRUNCATE explain_fixtures;

INSERT INTO explain_fixtures (name, value, note)
-- Read back from the rows that landed, not written as a literal: if the seed
-- ever stops producing the exact-match memo, this fails the NOT NULL constraint
-- here rather than letting the search entries capture a plan over zero rows.
SELECT 'search.query', (SELECT memo FROM transactions WHERE memo = 'ORDER-4471' LIMIT 1),
       'a memo with an exact match and many fuzzy neighbours'
UNION ALL
SELECT 'search.typo.query', (SELECT memo FROM transactions WHERE memo = 'ORDR-4471' LIMIT 1),
       'a transposed memo: matches on similarity alone'
UNION ALL
SELECT 'tx.new', (SELECT hash FROM transactions ORDER BY ledger DESC, hash DESC LIMIT 1), 'head of the (ledger, hash) order'
UNION ALL
-- Relative to the row count rather than a fixed offset, so the fixture still
-- means "the middle of the order" if the seed's scale is changed.
SELECT 'tx.deep', (SELECT hash FROM transactions ORDER BY ledger DESC, hash DESC
                   OFFSET (SELECT (COUNT(*) / 2)::int FROM transactions) LIMIT 1),
       'halfway down the order: a deep keyset page'
UNION ALL
SELECT 'ledger.recent', (SELECT MAX(sequence)::text FROM ledgers), 'the busiest ledger: ~600 transactions'
UNION ALL
SELECT 'ledger.quiet', (SELECT sequence::text FROM ledgers WHERE sequence < 56000001 + 198000 ORDER BY sequence DESC LIMIT 1), 'a sparse ledger: a handful of transactions'
UNION ALL
SELECT 'account.whale', (SELECT whale FROM seed_faces), '2% of all transactions'
UNION ALL
SELECT 'account.cold', (SELECT cold FROM seed_faces), 'appears as a recipient, never a source'
UNION ALL
-- The smallest non-empty history in the table. The interesting question for an
-- ordering query is not the median account but the floor: an account the
-- planner thinks has ~5 rows, because that is where walking an ordering index
-- to find them turns into a full pass over the index.
SELECT 'account.tail', (
    SELECT source_account FROM transactions
    GROUP BY source_account HAVING COUNT(*) > 0
    ORDER BY COUNT(*), source_account LIMIT 1
), 'the long tail: the account with the fewest transactions'
UNION ALL
SELECT 'account.warm', (SELECT addr FROM (SELECT pg_temp.addr('warm_' || k) AS addr FROM generate_series(0, 49) k) w
                        WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.source_account = w.addr)
                        ORDER BY (SELECT COUNT(*) FROM transactions t WHERE t.source_account = w.addr) DESC LIMIT 1),
       'one of the 50 warm addresses, ~6000 transactions'
UNION ALL
SELECT 'op.recent', (SELECT id FROM operations ORDER BY ledger DESC, id DESC LIMIT 1), 'head of the (ledger, id) order'
UNION ALL
SELECT 'tx.whale', (SELECT hash FROM transactions WHERE source_account = (SELECT whale FROM seed_faces) ORDER BY ledger DESC, hash DESC LIMIT 1), 'a whale transaction'
UNION ALL
SELECT 'tx.warm', (SELECT hash FROM transactions WHERE source_account = (SELECT addr FROM (SELECT pg_temp.addr('warm_' || k) AS addr FROM generate_series(0, 49) k) w
                        WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.source_account = w.addr)
                        ORDER BY (SELECT COUNT(*) FROM transactions t WHERE t.source_account = w.addr) DESC LIMIT 1)
                   ORDER BY ledger DESC LIMIT 1), 'a transaction from the warm account'
UNION ALL
SELECT 'event.cursor', (SELECT id FROM contract_events ORDER BY ledger DESC, id DESC
                        OFFSET (SELECT (COUNT(*) / 2)::int FROM contract_events) LIMIT 1),
       'a mid-page event id for the keyset'
UNION ALL
SELECT 'contract.hot', (SELECT hot_contract FROM seed_faces), '40% of all contract events'
UNION ALL
SELECT 'contract.warm', (SELECT warm_contract FROM seed_faces), '5% of all contract events'
UNION ALL
SELECT 'contract.cold', (SELECT pg_temp.contract('cold_' || 1)), 'a long-tail contract'
UNION ALL
SELECT 'custom.contract', (SELECT hot_contract FROM seed_faces), 'the contract with a registered schema'
UNION ALL
SELECT 'custom.contract.cold', (SELECT pg_temp.contract('cother_' || 1)), 'a contract with events but no schema'
UNION ALL
SELECT 'custom.event.hot', 'transfer', '70% of the custom events'
UNION ALL
SELECT 'custom.event.cold', 'swap', '300 rows'
UNION ALL
SELECT 'custom.common.to', (SELECT pg_temp.addr('cev_common_recipient')), 'a filter value matching ~30% of the hot event'
UNION ALL
SELECT 'asset.hot', 'USDC:' || (SELECT usdc_issuer FROM seed_faces), 'the most common non-native asset'
UNION ALL
SELECT 'asset.rare', 'ZZ:' || (SELECT zz_issuer FROM seed_faces), 'a selective asset: ~0.5% of payments'
UNION ALL
SELECT 'asset.native', 'XLM', 'the native asset, carried only as asset_type';
