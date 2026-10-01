# Query plans

Every main query in this repository, run under `EXPLAIN ANALYZE` against a
production-shaped database, with the plans recorded so that a query quietly
losing its index shows up as a diff rather than as a latency graph months later.

The reason this document exists: an index being *created* is not the same as the
planner *using* it. The mistakes that matter are structural —

- a keyset comparison (`(ledger, id) < (SELECT …)`) can only use an index whose
  leading columns match the comparison exactly, so a single-column index beside
  it does nothing;
- an expression index (`(details->>'asset_code')`) is only usable if the query
  spells the expression the same way, and an `OR` across three roles cannot be
  served by an index on one of them;
- a GIN index on a JSONB column serves containment (`@>`, `?`), never `->>`, so
  a filter written as `fields->>'to' = $1` cannot use it however the index is
  declared.

None of those fail a test. They pass every correctness test there is.

## Method

The harness is `db/explain/`. It does not contain SQL: the catalog names
application functions (`getOperations`, `searchTransactions`, …) and the harness
hands each a `Pool` whose `query` runs the statement under
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and then runs it for real.

Two consequences worth the indirection:

- **The recorded plan is for the statement the server sends.** A hand-copied
  statement drifts the first time somebody edits a `WHERE` clause, and the audit
  keeps passing while the real query regresses.
- **The rows are real.** Keyset pages are captured by taking the cursor from the
  previous page's last row, which is only possible if page one actually returned
  rows. A harness that returned empty results could not capture a cursor page at
  all, and a hand-written cursor would be a claim about the server rather than a
  measurement of it.

Each entry is captured twice: a warm-up pass whose plans are discarded, then the
recorded pass, so the plan reflects a warm cache. `EXPLAIN ANALYZE` executes the
statement, so every catalog entry is read-only and the harness refuses to
intercept anything that is not a `SELECT` or `WITH`.

Statistics are frozen for the duration: the seed `VACUUM (ANALYZE)`s every table
and disables autovacuum on it. A check that can be disturbed by an autovacuum
landing between two runs is a check nobody will trust.

### What is compared, and what is not

`db/explain/baseline.json` records, per query: a hash of the statement text, the
top plan node, a histogram of node types, every scan with the index it used
where it used one, the relations scanned sequentially, and the number of rows
returned.

Timings, costs, row *estimates* and buffer counts are deliberately excluded. Two
runs of the same query on the same database differ in every one of them, so
including them would make the check fail constantly — and a check that cries
wolf is worse than none, because it looks like coverage. They are still captured
into the (gitignored) `db/explain/plans/*.json`, where somebody investigating a
diff can read them.

The baseline also records the index inventory for the seeded tables. That is the
one regression a small database *can* catch — an index dropped or renamed by a
migration — so a cheap CI step could check it without seeding ten million rows.

## The dataset

`db/explain/seed.sql`, deterministic (nothing calls `random()`; every value
derives from `md5` of a row index), so a recorded plan is comparable to the next
run:

| table | rows | shape |
|---|---|---|
| `ledgers` | 200,000 | 5s apart; 60% of all traffic lands in the newest 2,000 (~600 tx each), the rest spreads over the other 198,000 (~4 each) |
| `transactions` | 2,000,000 | memos on 30% (the trigram index is partial); one whale at 2%, 50 warm accounts at 15%, a uniform long tail; ~1% failed |
| `operations` | 6,000,000 | 3 per transaction, ids in Horizon's toid shape so id order agrees with ledger order; payments 55%, offers 12%, path payments 10%, … , `manage_data` 1% |
| `contract_events` | 1,200,000 | one hot contract at 40%, one warm at 5%, ~5,000 long-tail contracts |
| `custom_events` | 1,000,000 | one registered schema: a hot `transfer` event at 70%, a 300-row `swap`, the rest across other contracts |
| `accounts` | 400,000 | |

Sizes and skews are chosen so the planner is genuinely choosing: at 2M rows, a
sequential scan of `transactions` (~30k pages at `random_page_cost = 4`) costs
roughly what fetching ~120k rows through an index costs, so an account with a
few thousand rows leaves the index in place while the whale does not. A fixture
below that crossover would produce an audit that says "the index is used" about
a table too small for the question to have been asked.

Two rules kept the numbers honest:

- **Fixtures are computed, not hardcoded.** The named values the catalog filters
  on (`explain_fixtures`) are read back out of the rows that actually landed, so
  a query can never point at a row that is not there — which would produce a
  plan for an empty result that looks *better* than the real one.
- **Predictions are written before the capture.** Each catalog entry carries an
  `expectSeqScan` written in advance, so a surprise is investigated rather than
  published: either the prediction was wrong or the seed is.

## Re-running

```bash
npm run explain:seed     # build the scratch database (slow, one time)
npm run explain          # capture and report against the baseline
npm run explain:check    # compare only; non-zero exit on a regression
npm run explain:update   # re-record the baseline
```

`EXPLAIN_DATABASE_URL` (falling back to `DATABASE_URL`) points at the database;
the seed truncates every table, so it must be a scratch one. `docker compose -f
docker/docker-compose.yml up postgres` provides one. The environment used for
the plans below was an embedded PostgreSQL 16.14 on Windows — the same major
version as the `postgres:16-alpine` image the project ships.

The seed records the hash of `seed.sql` as the baseline's `seed.version`; a
capture against a database seeded from a different revision exits with a
"re-baseline required" message rather than reporting differences that mean
nothing.

## Limitations

- **The plan shapes are the finding; the absolute numbers are not.** Costs,
  timings and buffer counts depend on `shared_buffers`, `random_page_cost` and
  the machine, none of which match a production deployment. Every conclusion
  below is about *which access path the planner chose*, and every one of them
  was checked against the direction the crossover moves at larger sizes.
- **Scale is a model, not the network.** These tables are 2–6M rows; Stellar
  mainnet is far larger. Every sequential scan found here gets *worse* at
  production size, and every index-driven plan stays index-driven — the
  crossover arithmetic is in the dataset section so that claim is auditable
  rather than asserted.
- **This does not run in CI, and cannot.** On a small table the sequential scan
  is the correct plan, so a CI-sized database would report exactly the queries
  this document is about as healthy. It is a run-on-demand audit, not a test.

## The plans

45 entries, captured against the database described above. "Rows read" is the
work the plan actually did — the table size for a sequential scan, the heap rows
for an index path — because it is deterministic where the milliseconds are not.
(The same query measured 1.5s on one run and 5.9s on the next on this machine;
the row counts were identical. That variance is why timings are not compared.)

| query | plan | rows read | returned | ms |
|---|---|---|---|---|
| `tx.first-page` | idx_transactions_ledger | 601 | 20 | 16 |
| `tx.cursor-page` | idx_transactions_ledger, transactions_pkey | 582 | 20 | 3 |
| `tx.deep-cursor` | idx_transactions_ledger, transactions_pkey | 201 | 20 | 9 |
| `tx.by-hash` | transactions_pkey | 1 | 1 | 1 |
| `tx.by-ledger-busy` | idx_transactions_ledger | 600 | 600 | 1 |
| `tx.by-ledger-quiet` | idx_transactions_ledger | 4 | 4 | 0 |
| `op.first-page` | **Seq Scan** operations | 6,000,000 | 20 | 5004 |
| `op.hot-account` | idx_operations_source | 121,263 | 20 | 1606 |
| `op.warm-account` | idx_operations_source | 18,432 | 20 | 496 |
| `op.hot-type` | **Seq Scan** operations | 6,000,000 | 20 | 5089 |
| `op.cursor-page-unfiltered` | **Seq Scan** operations, operations_pkey | 6,000,000 | 20 | 4882 |
| `op.rare-type` | idx_operations_type | 59,809 | 20 | 5920 |
| `op.cold-account` | idx_operations_source | 3 | 3 | 1 |
| `op.by-transaction` | idx_operations_transaction | 3 | 3 | 2 |
| `op.cursor-page` | idx_operations_source, operations_pkey | 18,413 | 20 | 594 |
| `asset.hot` | **Seq Scan** operations | 6,000,000 | 20 | 5493 |
| `asset.rare` | **Seq Scan** operations | 6,000,000 | 20 | 5393 |
| `asset.native` | **Seq Scan** operations | 6,000,000 | 20 | 5275 |
| `asset.by-account` | idx_operations_source | 6,409 | 20 | 23 |
| `replay.whale` | **Seq Scan** operations | 6,000,000 | 90 | 4938 |
| `replay.warm` | **Seq Scan** operations | 6,000,000 | 0 | 5047 |
| `ev.hot-contract` | idx_events_ledger | 241 | 20 | 25 |
| `ev.cold-contract` | idx_events_contract_id | 132 | 20 | 12 |
| `ev.mid-contract-cursor` | contract_events_pkey, idx_events_ledger | 22 | 20 | 112 |
| `ev.topic` | idx_events_ledger | 241 | 20 | 1 |
| `search.first` | idx_transactions_memo_trgm | 239,823 | 20 | 5277 |
| `search.typo` | idx_transactions_memo_trgm | 3,424 | 20 | 1449 |
| `search.cursor-page` | idx_transactions_memo_trgm | 239,802 | 20 | 2650 |
| `custom.first` | idx_custom_events_ledger | 351 | 20 | 42 |
| `custom.string-filter` | idx_custom_events_ledger | 115 | 20 | 2 |
| `custom.numeric-filter` | idx_custom_events_ledger | 39 | 20 | 2 |
| `custom.selective-event` | idx_custom_events_contract_event | 21 | 20 | 1 |
| `custom.cursor-page` | custom_events_pkey, idx_custom_events_ledger | 332 | 20 | 2 |
| `ledger.by-sequence` | ledgers_pkey | 1 | 1 | 2 |
| `ledger.latest` | ledgers_pkey | 1 | 1 | 1 |
| `account.by-address` | accounts_pkey | 1 | 1 | 1 |
| `account.tx-whale` | idx_transactions_ledger | 10 | 10 | 6 |
| `account.tx-warm` | idx_transactions_ledger | 10 | 10 | 37 |
| `account.tx-cold` | idx_transactions_source | 1 | 1 | 1 |
| `account.ops-whale` | idx_operations_source | 121,263 | 10 | 2542 |
| `account.ops-warm` | idx_operations_source | 18,432 | 10 | 1245 |
| `indexer.max-ledger` | ledgers_pkey (Index Only Scan) | 1 | 1 | 1 |
| `indexer.max-event-ledger` | idx_events_ledger | 1 | 1 | 1 |
| `indexer.load-schemas` | Seq Scan contract_schemas (intended) | 1 | 1 | 0 |

## Unintended sequential scans

Four, and they are one problem with four faces: **no index on `operations`
provides the `(ledger DESC, id DESC)` ordering that every operations query
orders by**, so the planner has only the two bad options — read the whole table,
or read a lot of it through some other index and sort.

### 1. `operations` unfiltered — a full sweep for every first page

`getOperations` with no filter (`db.ts:203`) plans a `Seq Scan` over 6,000,000
rows to return 20 (4.9s). There is no index on `operations.ledger` at all, and
the keyset form is no better — it is captured too, and also scans: the plan for
the second page shows `operations_pkey`, but only for the `(SELECT ledger, id
FROM operations WHERE id = $3)` lookup that resolves the cursor. The outer scan
is still sequential, because the row comparison `(ledger, id) < (…)` can only be
served by an index whose *leading* columns are `(ledger, id)`, and the only
index on this table starting with `id` is the primary key.

Both pages of `operations` scan, and the keyset — built to make deep pages cheap
— buys nothing here.

*Fix:* `CREATE INDEX ... ON operations (ledger DESC, id DESC)`.

### 2. The asset filter cannot use any of the three indexes built for it

`idx_operations_asset_code`, `idx_operations_asset_issuer` and
`idx_operations_asset_type` exist for exactly these queries, and no query in the
catalog uses any of them. `getOperationsByAsset` (`search.ts:193`) matches an
asset across three roles — payment, and either side of an offer — as a
disjunction:

```sql
(details->>'asset_code' = $1 AND details->>'asset_issuer' = $2)
 OR (details->>'selling_asset_code' = $1 AND details->>'selling_asset_issuer' = $2)
 OR (details->>'buying_asset_code' = $1 AND details->>'buying_asset_issuer' = $2)
```

Two of those three branches have no index behind them at all, and a `BitmapOr`
cannot include a branch that is only a filter. So the whole disjunction degrades
to a filter over a sequential scan. The decisive measurement is `asset.rare`: the
predicate matches **24,546 rows out of 6,000,000** — a selectivity of 0.4%, the
kind of predicate an index obviously helps — and the plan reads all 6,000,000
rows anyway (5.4s) to return 20.

*Fix:* `UNION ALL` of the three roles with a `DISTINCT` (or `UNION`) over the
result set, which lets each branch use its own index — the asset roles that do
have indexes (`asset_code`, `asset_issuer`, `asset_type`) are usable *one branch
at a time*. Another index would not help; the shape of the predicate is the
problem.

### 3. The subscription replay path sweeps the table per subscriber

`getAccountOperationsInLedger` (`db.ts:332`) is what a websocket subscriber runs
when it connects, and it has **no `LIMIT`**. It filters `ledger = $1` (unindexed
on `operations`) and five `OR`'d JSONB `->>` comparisons. It plans a `Seq Scan`
over 6,000,000 rows, returning 90 (4.9s). Note the second variant,
`replay.warm`, returns **zero** rows and costs the same 5.0s: selectivity does
not enter into it.

*Fix:* `(ledger)` — or better, since the account is the selective part,
`(source_account, ledger)`, which the `source_account = $2` branch of the
disjunction can use.

### 4. Sorted-in-memory filters on `operations`

When the filter *is* selective enough to use an index, the plan still reads every
matching row and sorts it, because no index carries the ordering:

| query | rows read | returned | ms |
|---|---|---|---|
| `op.rare-type` (`type = 'manage_data'`, 1% of the table) | 59,809 | 20 | 5920 |
| `op.hot-account` (an account with 2% of the table) | 121,263 | 20 | 1606 |
| `account.ops-whale` (the same, `LIMIT 10`) | 121,263 | 10 | 2542 |

`account.ops-whale` is the one that compounds: it is a per-row resolver
(`resolvers.ts:203`), so a page of 20 transactions issues it **20 times**, and
there is no `DataLoader` in the repository despite the dependency being
declared. A 2.5s query becomes ~50s of work for one GraphQL page.

*Fix:* the same `(…, ledger DESC, id DESC)` composites —
`(type, ledger DESC, id DESC)` and `(source_account, ledger DESC, id DESC)`.

### Sequential scans that are *correct*

Two, recorded so the intended ones are on the record too: `op.hot-type`
(`type = 'payment'` is 55% of the table, so scanning beats an index) and
`indexer.load-schemas` (a statement that reads every row of a one-row table on
purpose). Neither is a finding, and an audit that only lists scans cannot tell
them apart from the four above.

## Indexes that exist and serve nothing

No captured query uses any of these. They cost write throughput on the indexer's
hot path and storage, and the first three are the subject of the ticket — they
were added for a feature whose query cannot use them:

| index | why nothing uses it |
|---|---|
| `idx_operations_asset_code` `_issuer` `_type` | the three-role `OR` (finding 2) |
| `idx_operations_details` (GIN) | nothing queries `details` with containment (`@>`); every JSONB predicate is `->>` |
| `idx_custom_events_fields` (GIN) | same: the filters are `fields->>'x' = $1`, which `jsonb_ops` cannot serve |
| `idx_events_topics` (GIN) | the one query that could use it (`ev.topic`) prefers `idx_events_ledger`, which finds 20 rows in 241 |
| `idx_transactions_created_at`, `idx_operations_created_at`, `idx_events_created_at`, `idx_ledgers_closed_at` | no application query orders by `created_at`/`closed_at`; they may serve operational queries outside this repository, which is why removing them is a separate decision from the four above |

## Secondary observations

### The search similarity threshold is not what the code says it is

`search.ts:110` says the explicit `MIN_SIMILARITY = 0.15` filter "keeps the
behaviour independent of the session's `pg_trgm.similarity_threshold`". It does
not. The `%` operator *is* that session setting, nothing in the repository sets
it, so it runs at the default **0.3** — stricter than 0.15, and the filter is
therefore not what excludes anything; the operator is. For the fixture query the
seed holds 600,339 memos, of which 240,011 reach similarity 0.15 and 239,823
reach 0.3: **188 memos are matched by the filter and dropped by the operator**.
The impact on this dataset is small; the claim in the comment is what is wrong,
and if anyone lowers the session threshold the results will change while the
code says they cannot.

The measurement also cross-checks the plan: the trigram index produced exactly
239,823 candidate rows — the `%` set and nothing else. The index is used, so the
ticket's worry does not apply to search. But the candidate set is far larger than
"most memos are not prose" suggests, because order references resemble each
other: 20 rows come back after 239,823 are ranked and sorted, which is where
5.3s goes.

### `ledger.latest` is an Index Scan, its sibling an Index Only Scan

`getLatestLedgerFromDb` selects `*`, so it needs the heap; `getLatestIndexedLedger`
selects `MAX(sequence)` and is served entirely from `ledgers_pkey`. Both are
correct, and recording them next to each other is what makes the difference
legible rather than suspicious.

## Recommended DDL (not applied)

Recorded, not executed — this pass changes no index and no query.

```sql
-- op.first-page, op.cursor-page — the ordering every operations query asks
-- for, which nothing on this table currently provides. One composite covers
-- both the unfiltered page and the keyset; a bare (ledger) index would be
-- redundant beside it.
CREATE INDEX idx_operations_ledger_id ON operations (ledger DESC, id DESC);

-- op.rare-type, op.hot-account, op.cursor-page — filter and order from one
-- index, so the 59,809 / 121,263 rows currently read and sorted come back in
-- ledger order instead.
CREATE INDEX idx_operations_type_order    ON operations (type, ledger DESC, id DESC);
CREATE INDEX idx_operations_account_order ON operations (source_account, ledger DESC, id DESC);

-- replay.whale, replay.warm — the subscription path filters on ledger and
-- ORs five JSONB fields; the account index above serves the account branch,
-- and this covers the ledger itself.
CREATE INDEX idx_operations_ledger ON operations (ledger);

-- account.tx-warm, account.tx-whale — the per-account transaction resolver,
-- which currently walks the ledger index and filters.
CREATE INDEX idx_transactions_account_order ON transactions (source_account, ledger DESC);

-- ev.hot-contract, ev.mid-contract-cursor — the keyset is (ledger, id)
-- filtered by contract, and no index carries that pair.
CREATE INDEX idx_events_contract_order ON contract_events (contract_id, ledger DESC, id DESC);

-- custom.first, custom.cursor-page — idx_custom_events_contract_event stops
-- at ledger; the keyset also orders by event_id.
CREATE INDEX idx_custom_events_contract_order ON custom_events (contract_id, event_name, ledger DESC, event_id DESC);
```

Plus the `UNION ALL` rewrite for `getOperationsByAsset` (finding 2) and the
decision on the unused indexes above. Each recommendation is evidenced by the
catalog entry named beside it, and by the `npm run explain` output that changes
when it lands.
