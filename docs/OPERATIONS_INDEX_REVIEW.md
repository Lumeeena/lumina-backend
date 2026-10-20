# Operations index review

`operations` is the table the indexer writes most — every operation of every
ledger, a few hundred every five seconds on mainnet — and the one the API reads
most. It had a primary key and nine secondary indexes, each added for its own
feature, and nothing had reviewed them as a set. Every index is paid for on
every one of those writes, and the indexer's write path is the system's
bottleneck. This review measures what reads and writes each index, which
queries scan the table when they should not, and how the table grows.

The outcome is migration 019: five indexes dropped and three added, two of
them replacing what was dropped. On identical mainnet traffic it cuts the
indexer's WAL by 54%, its write time by 25% and the table's index footprint by
65%, and turns every sequential scan the API made on this table except the
credit asset filter into an index scan.

- [What touches the table](#what-touches-the-table)
- [Method](#method)
- [Results: index usage](#results-index-usage)
- [Results: reads](#results-reads)
- [Results: writes](#results-writes)
- [Decision](#decision)
- [Growth](#growth)
- [Re-running it on a deployment](#re-running-it-on-a-deployment)
- [Found along the way](#found-along-the-way)

## What touches the table

Read from the code, not assumed. "Before" is the index the planner used before
migration 019, measured below; "after" is the one it uses now.

| Statement | Where | Before | After |
| --- | --- | --- | --- |
| `INSERT … ON CONFLICT DO NOTHING` | `indexLedger` | every index | every index |
| listing: `network = $1 ORDER BY ledger, id LIMIT`, keyset pages | `getOperations` | **seq scan** | `idx_operations_network_ledger` |
| `+ source_account = $2` | `getOperations`, `Account.operations` | `idx_operations_source` + sort; a busy account bitmap-scans all its rows | `idx_operations_network_source_ledger` |
| `+ type = $2` | `getOperations` | common type: **seq scan**; rare type: `idx_operations_type` | common: `idx_operations_network_ledger`; rare: `idx_operations_type` |
| `transaction_hash = $1` / `= ANY($1)` | `Transaction.operations` | `idx_operations_transaction` | unchanged |
| `ledger = $1 AND (source_account OR details->>…)` | `accountActivity` replay | **seq scan** | `idx_operations_network_ledger` |
| `type IN (…) AND details @> {account}` | `accountLifecycle` | `idx_operations_details` (GIN over every row) | `idx_operations_lifecycle` (GIN over the two types read) |
| three-role asset `OR` | `operations(asset:)`, asset volume series | seq scan; the three asset indexes are **never** used | native: `idx_operations_network_ledger`; credit: seq scan (below) |
| `created_at` range | balance history, volume series, CSV export by date | `idx_operations_created_at` | unchanged |
| `ledger BETWEEN` (no network) | CSV export by ledger | **seq scan** | full scan of `idx_operations_network_ledger` |
| `ledger > $1 ORDER BY id OFFSET` | incremental export | `operations_pkey` | unchanged |
| `DELETE … WHERE created_at < $1` | retention prune | `idx_operations_created_at` | unchanged |
| FK check per deleted `transactions` row | retention prune (`transactions`) | `idx_operations_transaction` | unchanged |

## Method

There was no production deployment available to this review. To keep the
result from being an assumption, the measurement replays real chain history
through the real code (`db/audit/operations.ts`, `npm run audit:operations`):

- **Data**: 1,000 consecutive mainnet ledgers (65,039,178–65,040,177, fetched
  from Horizon on 2026-10-20): 364,273 operations, every type in the proportions
  the chain produced them, with their ledgers and transactions.
- **Writes**: every ledger through the indexer's own `indexLedger`, which writes
  `details` as Horizon's payload, exactly as a deployment does.
- **Reads**: the API's own functions — `getOperations` (unfiltered, by the
  busiest account, a warm one at the 1st percentile and a cold one, by the most
  and least common type, each with keyset pages), `Transaction.operations`
  single and batched, `Account.operations`, `accountLifecycle`, the
  `accountActivity` replay, `operations(asset:)` for the busiest asset, a cold
  one and XLM, the asset volume series, balance history, and both exports.
  Every statement is captured as sent and `EXPLAIN (ANALYZE, BUFFERS)`-ed.
- **Retention**: one real prune round — expired operations, then a batch of
  transactions whose foreign-key checks read this table — inside a transaction
  that is rolled back. The statistics counters are not transactional, so the
  index scans survive the rollback and the rows do not.
- **Two variants**: the indexes before migration 019, and after, each built from
  scratch. Write cost is compared on the first 300 of those ledgers (93,633
  operations) replayed into two fresh databases after a `CHECKPOINT`, with
  `pg_current_wal_lsn()` diffed and nothing else running on the cluster.
- PostgreSQL 16.14 on Linux; `pg_stat_user_indexes` and `pg_stat_user_tables`
  read after `pg_stat_force_next_flush()`.

Timings are reported but not relied on: two runs of the same plan differ by
several times on a laptop. The comparison is in plans, buffers and bytes, as in
[QUERY_PLANS.md](QUERY_PLANS.md).

## Results: index usage

Index scans during the read workload (411 statements) and the retention round,
before migration 019, with each index's size at 364,273 rows. (The counters
also include the workload's own parameter-picking queries, which use no index.)

| Index | Reads | Prune | Size | Bytes per row |
| --- | ---: | ---: | ---: | ---: |
| `idx_operations_details` (GIN, all of `details`) | 50 | 0 | **436 MB** | 1,197 |
| `idx_operations_transaction` | 601 | 10,000 | 26 MB | 72 |
| `operations_pkey` | 2 | 0 | 18 MB | 50 |
| `idx_operations_source` | 18 | 0 | 4.9 MB | 13 |
| `idx_operations_created_at` | 11 | 5 | 4.6 MB | 13 |
| `idx_operations_type` | 113 | 0 | 2.5 MB | 7 |
| `idx_operations_asset_type` | **0** | 0 | 0.5 MB | 1 |
| `idx_operations_asset_code` | **0** | 0 | 0.5 MB | 1 |
| `idx_operations_asset_issuer` | **0** | 0 | 0.4 MB | 1 |

Of the 27 distinct statements the workload sends, **10 planned a sequential
scan of the whole table**: both listing pages, both common-type pages, the
replay, all three asset filters, the volume series and the CSV export by ledger.

- **The GIN index on `details` is 74% of the table's heap size and 88% of its
  index bytes**, and its only reader is `accountLifecycle`, which needs the two
  operation types that name an account (`create_account`, `account_merge`) —
  0.6% of rows.
- **The three asset expression indexes are never read.** The asset filter
  matches an asset in any of three roles with an `OR`, two of whose branches
  have no index, and a `BitmapOr` cannot include an unindexed branch — as
  [QUERY_PLANS.md](QUERY_PLANS.md#2-the-asset-filter-cannot-use-any-of-the-three-indexes-built-for-it)
  predicted on synthetic data.
- **Nothing serves the listing's order.** Every listing sorts by
  `(ledger, id)` within a network, and no index starts that way.

After migration 019, **3 do**: the two credit asset filters and the volume
series, which share the asset `OR` (below).

## Results: reads

Buffers per statement, the first page and a keyset page where there is one:

| Query | Before | After |
| --- | ---: | ---: |
| `operations()` page 1 / page n | 72,439 / 72,465 (seq scan) | 134 / 9 |
| `operations(account: busiest)` page 1 / n | 23,955 / 23,955 (bitmap of all its rows) | 14 / 13 |
| `operations(account: warm)` page 1 / n | 199 / 199 | 24 / 24 |
| `operations(type: manage_sell_offer)` page 1 / n | 72,273 / 72,215 (seq scan) | 49 / 29 |
| `operations(type: liquidity_pool_withdraw)` | 10 | 10 |
| `Account.operations` (busiest) | 23,955 | 8 |
| `accountActivity` replay | 72,351 (seq scan) | 209 |
| `accountLifecycle` | 17 | 4 |
| `operations(asset: XLM)` | 109,718 (seq scan) | 73 |
| `operations(asset: busiest credit)` | 147,083 (seq scan) | 147,094 (seq scan) |
| CSV export by ledger range | 72,185 (seq scan) | 5,616 |
| `Transaction.operations`, exports by date, incremental export | unchanged | unchanged |

The unfiltered listing — the API's default operations page — reads 0.2% of what
it read. The `accountActivity` replay matters more than its single number
suggests: it has no `LIMIT`, and every subscriber runs it on connect.

### The credit asset filter still scans

`operations(asset: "CODE:ISSUER")` and the volume series still read the whole
table: matching an asset in three roles with an `OR` is the shape of the
problem, and no index fixes it. The fix is the query — a `UNION` of the three
roles, each with its own index — which is a change to the API's SQL and to three
new indexes' write cost, and is left as its own decision. What this review
changes is that the three indexes that could never serve it are gone. XLM is
served now only because the network/ledger index finds 20 native-asset rows
within the first few pages.

## Results: writes

The same 300 ledgers (93,633 operations) replayed into two fresh databases:

| | Before | After | Change |
| --- | ---: | ---: | ---: |
| WAL | 732.0 MB | 333.9 MB | **−54%** |
| replay time | 112.6 s | 84.5 s | **−25%** |
| `operations` indexes | 129.2 MB | 42.2 MB | **−67%** |

At the full 364,273 rows: indexes 494 MB before, 171 MB after (−65%); the heap
is the same 591 MB either way. The two composites added (39 MB and 80 MB) are
about a quarter of the size of the GIN index they replace.

Time falls by less than WAL because `indexLedger` also does per-operation work
no index on `operations` affects — ledgers, transactions, trustlines, assets and
the other side tables, each its own round trip.
On the 300 ledgers that is 832 operations a second before and 1,108 after, on a
laptop, against the chain's ~75; the full 1,000 ledgers took 17.5 minutes after
the migration.

## Decision

Migration 019, built `CONCURRENTLY` (new indexes first, so no query is ever
without one):

| Index | | Why |
| --- | --- | --- |
| `idx_operations_network_ledger (network, ledger DESC, id DESC)` | **added** | the listing's keyset order; one ledger for the replay; common types and XLM by walking it |
| `idx_operations_network_source_ledger (network, source_account, ledger DESC, id DESC)` | **replaces** `idx_operations_source` | an account's operations already in listing order; a busy account no longer sorts every row it has |
| `idx_operations_lifecycle` GIN `(details jsonb_path_ops) WHERE type IN ('create_account','account_merge')` | **replaces** `idx_operations_details` | the one containment query, over the two types it reads: 0.9 MB instead of 436 MB, with no change to the query |
| `idx_operations_asset_code`, `_asset_issuer`, `_asset_type` | **dropped** | 0 scans; the query cannot use them |
| `idx_operations_transaction` | kept | `Transaction.operations`, and the foreign-key check for every `transactions` row the prune deletes |
| `idx_operations_created_at` | kept | the retention prune, balance history, the volume series, CSV export by date |
| `idx_operations_type` | kept | a rare type (the network/ledger walk serves a common one) |

`network` leads both composites, as in every key in this schema
([ADR 0004](adr/0004-network-in-every-key.md)): every API query filters on it.
The CSV export by ledger range is the one query without it, and it now scans
the 39 MB index instead of the 591 MB heap.

Measured and not adopted:

- **A bare `(ledger)` index** for that export and the replay. The composite
  serves both, and a fourth index would be write cost for an export rate-limited
  to two a minute.
- **`(network, type, ledger, id)`**. The kept single-column `type` index and the
  network/ledger walk between them serve rare and common types in 10 and 49
  buffers; a composite would add an index the size of the other two for that.

## Growth

**`operations` grows without bound by default, and fast.**

- The sample averaged **364 operations per ledger** (the 2,884 ledgers before it
  averaged 413). At 17,280 ledgers a day that is **6.3–7.1 million rows a day**
  per network, from successful transactions alone (the indexer, like Horizon's
  default, does not store failed transactions' operations).
- A row costs **2,141 bytes** after migration 019 — 1,624 of heap (`details` is
  Horizon's whole payload, almost always stored inline), 49 of TOAST and 469 of
  index — against 3,028 before.
- So one mainnet network adds about **13.5–15.3 GB a day, 4.9–5.6 TB a year**
  (it was 19.1–21.6 GB a day). Nothing else in the schema is within two orders
  of magnitude of it.

**The retention story exists, but its defaults cannot keep up with mainnet.**
`RETENTION_OPERATIONS_DAYS` (default `0`, keep everything) prunes by
`created_at` in chain time, in batches, using `idx_operations_created_at` — see
[RETENTION.md](RETENTION.md). But a round deletes at most
`RETENTION_PRUNE_BATCH_SIZE` × 20 rows per table (200,000 at the default
10,000) once every `RETENTION_PRUNE_INTERVAL_MS` (an hour), and mainnet adds
**262,000–297,000 operations an hour**. With the defaults the prune falls
further behind every hour and the table never stops growing. A mainnet
deployment that sets a window should raise the batch size to at least 25,000 or
run the prune every 20 minutes; the measured round (24,862 operations and 10,000
transactions) took 45 s after this migration and 76 s before it.

Partitioning by ledger would make the prune a `DROP` instead of a `DELETE`, and
was reverted for reasons recorded on the table in `db/schema.sql`. Shrinking
`details` is the other lever, and is the subject of
[OPERATIONS_DETAILS_STORAGE_TUNING.md](OPERATIONS_DETAILS_STORAGE_TUNING.md) —
constrained now by the keys the server reads, which
[OPERATIONS_DETAILS_CONTRACT.md](OPERATIONS_DETAILS_CONTRACT.md) lists.

## Re-running it on a deployment

The issue's collection step is `db/audit/operations.sql`, read-only:

```bash
psql "$DATABASE_URL" -f db/audit/operations.sql
npm run audit:operations -- report    # the same, through Node
```

Record `stats_reset` with the output. On a healthy deployment after migration
019, over at least a day of indexing and API traffic:

- `rows_per_seq_scan` should be far below `n_live_tup`; a sequential scan of
  the whole table is the credit asset filter, and nothing else.
- `idx_operations_network_ledger` and `idx_operations_network_source_ledger`
  should carry most API scans, `idx_operations_transaction` the nested
  resolver and the prune's foreign-key checks, `idx_operations_created_at` the
  prune and the time-range readers.
- `idx_operations_lifecycle` should stay under a megabyte per 300,000 rows.
- `growth by day` should show 6–7 million rows a day per mainnet network;
  `retention` should show the oldest row about the window behind the newest, and
  falling further behind is the prune not keeping up.

To repeat the measurement on scratch databases:

```bash
npm run audit:operations -- fetch 1000                  # cache mainnet ledgers from Horizon (once)
npm run audit:operations -- run <label>                 # replay, read, prune, EXPLAIN
AUDIT_LEDGER_LIMIT=300 npm run audit:operations -- replay <label>   # write cost only
```

## Found along the way

- **The prune cannot keep up with mainnet at its defaults** (above).
- **The credit asset filter is a sequential scan at any size**, and its three
  indexes were dead weight; the query rewrite is the fix, not more indexes.
- **The incremental export pages with `OFFSET`** (`writeDatabaseExport`), so
  each page re-reads every row before it: 80,000 buffers for the first page of
  operations above a ledger near the tip. A keyset on `id` would fix it; it is
  outside this table's indexes.
