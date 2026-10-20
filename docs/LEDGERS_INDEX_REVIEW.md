# Ledgers index review

`ledgers` has a primary key on `(sequence, network)` and one secondary index on
`closed_at`. This review measures what reads and writes each of them, checks the
ledger queries for scans that should not happen, and records how the table
grows. The outcome is a query fix for the indexed tip and no index change: the
primary key serves every API read, and `idx_ledgers_closed_at` is kept for the
retention prune even though an API-only workload never reads it.

- [What touches the table](#what-touches-the-table)
- [Method](#method)
- [Results: index usage](#results-index-usage)
- [Results: reads](#results-reads)
- [Results: writes and retention](#results-writes-and-retention)
- [Decision](#decision)
- [Growth](#growth)
- [Re-running it on a deployment](#re-running-it-on-a-deployment)
- [Found along the way](#found-along-the-way)

## What touches the table

Read from the code, not assumed. Every ledger query filters by `network`; the
ones that return a page also order by `sequence`.

| Statement | Where | Key | Index |
| --- | --- | --- | --- |
| `INSERT … ON CONFLICT (sequence, network) DO NOTHING` | `indexLedger`, once per ledger | full PK | `ledgers_pkey` |
| `SELECT MAX(sequence)` | `getLatestIndexedLedger` | `network` + sequence order | `ledgers_pkey` |
| `SELECT MIN(sequence)` | `getEarliestIndexedLedger` | `network` + sequence order | `ledgers_pkey` |
| `SELECT … WHERE network = $1 ORDER BY sequence DESC LIMIT` | `getLedgers` | `network` + sequence order | `ledgers_pkey` |
| keyset pages: `AND sequence < $2` / `> $2` | `getLedgers` | `network` + sequence | `ledgers_pkey` |
| `SELECT … WHERE sequence = $1 AND network = $2` | `getLedgerBySequence` | full PK | `ledgers_pkey` |
| `SELECT … WHERE sequence = ANY($1) AND network = $2` | `getLedgersBySequences` | full PK | `ledgers_pkey` |
| `SELECT … WHERE network = $1 ORDER BY sequence DESC LIMIT 1` | `getLatestLedgerFromDb` | `network` + sequence order | `ledgers_pkey` |
| `SELECT sequence, indexed_at … ORDER BY sequence DESC LIMIT 1` | `getIndexedTip` (**changed**) | `network` + sequence order | `ledgers_pkey` |
| `SELECT COUNT(*) WHERE network = $1` | exact `totalCount` for the `ledgers` listing | `network` | sequential scan or PK |
| `DELETE … WHERE closed_at < cutoff LIMIT batch` | retention prune | `closed_at` | `idx_ledgers_closed_at` |

The table is append-only in normal operation. The only deleter is the retention
prune, and the only writer is the indexer.

## Method

There was no production deployment available to this review. To keep the result
from being an assumption, the measurement uses a scratch database built from
`db/schema.sql` and shaped like a deployment:

- PostgreSQL 16.15, the same major version as the shipped `postgres:16-alpine`.
- 2,500,000 ledger rows: 2,000,000 mainnet and 500,000 testnet, five seconds
  apart. A 200-ledger sample from Horizon on 2026-10-20 measured exactly 5.0
  seconds per ledger on both networks, which is 17,280 ledgers/day.
- The testnet range deliberately trails mainnet by 1.5M ledgers, to exercise
  the multi-network case where the two chains are not at the same sequence.
- The API workload imports the real functions from `graphql-server/src/db.ts`:
  200 point lookups, 50 first pages and 20-page keyset walks, mid-table pages in
  both directions, 100 latest-ledger reads, 100 indexed-tip reads and 10 exact
  counts, per network. `pg_stat_reset()` runs first.
- Index write cost is measured by inserting 500,000 ledgers into three fresh
  databases that differ only in their indexes, after a `CHECKPOINT`, and
  diffing `pg_current_wal_lsn()`. Table and index sizes are measured after
  `VACUUM (ANALYZE)`.
- Retention is measured separately: an ordered table (forward indexing only)
  and a shuffled table (the shape a backfill or reindex leaves), 500,000 rows
  each, with and without `idx_ledgers_closed_at`.

`db/audit/ledgers.sql` is the read-only collection step for a real deployment.

## Results: index usage

After the API workload on the 2.5M-row database:

| Index | Scans | Size | Reads |
| --- | ---: | ---: | --- |
| `ledgers_pkey` `(sequence, network)` | 4,074 | 90 MB | every point lookup, listing, keyset page, latest ledger and indexed tip |
| `idx_ledgers_closed_at` `(closed_at DESC)` | **0** | 80 MB | retention only; not reached by the API workload |

The heap is 201 MB, so 2.5M rows cost about 80 bytes of heap and 68 bytes of
index each. There are no updates and no HOT updates to measure: a ledger row is
inserted once.

Zero scans on `idx_ledgers_closed_at` is not evidence that it is unused. It is
the index the retention prune needs, and a deployment that leaves
`RETENTION_LEDGERS_DAYS` at its default of `0` will never read it. The trade is
one index entry per ledger inserted — cheap at one ledger per five seconds, and
measured below.

## Results: reads

Every normal read is an index scan. Median buffer counts from `EXPLAIN
(ANALYZE, BUFFERS)` on the 2.5M-row dataset:

| Query | Plan | Buffers | Time |
| --- | --- | ---: | ---: |
| `ledger(sequence:)` | `ledgers_pkey` | 4 | 0.1 ms |
| `ledgers` first page, mainnet | `ledgers_pkey` backward | 4 | 0.1 ms |
| `ledgers` keyset page, mainnet | `ledgers_pkey` backward | 4–5 | 0.1 ms |
| `latestLedger`, mainnet | `ledgers_pkey` backward | 4 | 1.0 ms |
| `indexerStatus` tip, **before** | parallel sequential scan | **25,773** | **734 ms** |
| `indexerStatus` tip, **after** | `ledgers_pkey` backward | **4** | **0.1 ms** |
| exact `totalCount`, mainnet | parallel sequential scan | 25,774 | 515 ms |
| exact `totalCount`, testnet | parallel sequential scan | 25,774 | 325 ms |

### The indexed tip was scanning the whole table

`getIndexedTip` used:

```sql
SELECT MAX(sequence) AS sequence, MAX(indexed_at) AS indexed_at
FROM ledgers WHERE network = $1
```

`MAX(indexed_at)` has no index, so the planner ran a parallel sequential scan
of every row on every `indexerStatus` call. At 2.5M ledgers that was 734 ms and
25,773 buffers; the cost grows with the chain.

It was also reading two independent maxima. A backfill writing an old ledger
updates that row's `indexed_at`, so `MAX(indexed_at)` can name a different row
from `MAX(sequence)`. The function's contract is "the highest ledger it has
written and when that write happened", which is the tip row, not either maximum
separately. It now reads that row directly:

```sql
SELECT sequence, indexed_at FROM ledgers
WHERE network = $1 ORDER BY sequence DESC LIMIT 1
```

That is an index scan on the primary key: 4 buffers and 0.1 ms for mainnet in
the same dataset. It does not add an index.

### The exact count still scans, on purpose

`ledgers` is the one table whose `totalCount` is always exact:
`getTableCountEstimateOrExact` runs `COUNT(*)` instead of using `reltuples`.
The count is opt-in via `includeTotalCount`, and exactness is the documented
contract, so this review leaves it alone. It is the source of the remaining
sequential scans in the workload: about 0.3–0.5 seconds per count at 2.5M rows.
If exact counts become a hot path, an index on `(network)` would make this an
index-only scan but would add another entry to every ledger write; that has not
been measured as worth it.

### Multi-network lag: a candidate index, not adopted

The default deployment indexes one network; the primary key is then exactly the
right index and every listing reads 4 buffers. When two networks are far out of
step, the primary key's leading column is `sequence`, not `network`, so a
lagging network's page walks past the leading chain's entries first. In the
2.5M-row dataset with testnet 1.5M ledgers behind mainnet:

| | `ledgers_pkey` | `(network, sequence DESC)` candidate |
| --- | ---: | ---: |
| testnet first page | 5,752 buffers, 83 ms | **5 buffers**, 0.2 ms |
| testnet latest ledger | 5,751 buffers, 86 ms | **4 buffers**, 0.1 ms |
| testnet exact count | 25,774 buffers, 325 ms | **1,922 buffers**, 208 ms |

The candidate index was built and measured. On 500,000 inserts it adds 27 MB of
index and raises WAL from 128 MB to 175 MB (+37%, about 94 bytes per ledger
insert). On a single-network deployment it would be paid for on every write and
never chosen. It is therefore **not adopted**. A deployment that runs several
networks far out of step can justify it from its own `pg_stat_user_indexes` and
`EXPLAIN` output; the DDL is one statement:

```sql
CREATE INDEX CONCURRENTLY idx_ledgers_network_sequence
    ON ledgers (network, sequence DESC);
```

## Results: writes and retention

Ledger rows are inserted in sequence order at one row per five seconds, so the
index write cost is small in steady state but not zero. 500,000 ledger inserts
into fresh databases:

| Variant | WAL | Index size | Indexes |
| --- | ---: | ---: | --- |
| PK + `closed_at` (current) | 128 MB | 34 MB | pkey 15 MB, closed_at 19 MB |
| PK only | **90 MB** | **15 MB** | pkey 15 MB |
| PK + `closed_at` + `(network, sequence)` candidate | 175 MB | 61 MB | pkey 15 MB, closed_at 19 MB, candidate 27 MB |

So `idx_ledgers_closed_at` is about 38 MB of WAL and 19 MB of index per 500,000
ledgers — roughly 76 bytes of WAL and 38 bytes of disk per row. That is the
price of keeping retention available, not a read the API makes.

### Why the index stays when retention is off

The prune is a batched `DELETE … WHERE closed_at < cutoff LIMIT n`. With rows in
chain order and a forward-only indexer, the expired rows sit at the front of the
heap, so a sequential scan can stop after the first batch and is competitive.
That is the ordered measurement: 10,000 expired rows out of 500,000 read 156
buffers through `idx_ledgers_closed_at` and 104 through a sequential scan; the
delete itself was dominated by the foreign-key check in both cases.

After a backfill or a range reindex, physical order no longer follows
`closed_at`. The same 10,000-row batch then finds old rows scattered through the
heap:

| 500,000 shuffled rows, 10,000 expired | Buffers scanned |
| --- | ---: |
| `idx_ledgers_closed_at` (bitmap) | **4,111** |
| no index (sequential scan) | **5,154** |

The gap grows with the table, and retention is exactly the operation that runs
on a deployment after it has been indexing for a while. Dropping the index would
make the first prune after backfill read the table instead of the old rows, so
it stays. The same test is why [RETENTION.md](RETENTION.md) treats `ledgers` as
prunable and why the prune needs a chain-time index.

## Decision

| Index / query | Evidence | Action |
| --- | --- | --- |
| `ledgers_pkey` | 4,074 scans; every API read and the insert's conflict target | keep |
| `idx_ledgers_closed_at` | 0 API scans, but the retention prune needs it; ordered scans are cheap without it, shuffled/backfilled scans are not | keep |
| `(network, sequence DESC)` | Fixes a lagging network's page (5,752 → 5 buffers) but costs +37% WAL and +27 MB per 500k inserts on every deployment | not adopted |
| `getIndexedTip` aggregate | 734 ms / 25,773 buffers at 2.5M rows; the two maxima can come from different rows | replace with a tip-row lookup |

No migration is needed. `db/audit/ledgers.sql` collects the same numbers from a
deployment, and the schema comment on `idx_ledgers_closed_at` now says which
query reads it.

## Growth

**`ledgers` grows without bound by default, and the growth is entirely
predictable.** It is one row per closed ledger per network:

- Stellar closes a ledger about every five seconds; Horizon measured 5.0 s on
  both mainnet and testnet on 2026-10-20.
- That is **17,280 rows/day**, **518,400 rows/month** and **6.3M rows/year per
  network**.
- At the measured 149 bytes per row (80 heap + 68 index), one network adds about
  2.6 MB/day and **0.94 GB/year** before vacuum overhead. The footprint is
  linear; there is no periodic spike.
- Rows are never updated in normal operation, and nothing deletes them unless
  retention is enabled. An admin range reindex deletes and reinserts its range,
  which is the one source of `n_tup_del` outside retention.

The retention story already exists: `RETENTION_LEDGERS_DAYS` defaults to `0`
(keep everything) and can be set to a window in days of **chain time**, using
`closed_at`. It cannot be enabled alone — the foreign-key chain means
`transactions` and `operations` must keep at least as much history; see
[RETENTION.md](RETENTION.md#the-chain-has-to-be-ordered). The prune runs in
bounded batches, children first, so enabling it on a multi-year index does not
remove the backlog in one transaction.

Deleting rows frees space for reuse by later inserts, but does not shrink the
heap files on disk; a deployment that needs the file size back requires a
`VACUUM FULL` or a rebuild, and should plan that separately from turning the
window on.

## Re-running it on a deployment

The issue's collection step is `db/audit/ledgers.sql`:

```bash
psql "$DATABASE_URL" -f db/audit/ledgers.sql
```

Record `stats_reset` with the output, because the counters are cumulative since
then. On a healthy deployment:

- `ledgers_pkey` should hold essentially all the scans. `idx_ledgers_closed_at`
  should be at or near zero unless retention is enabled and has run.
- `seq_scan` should stay flat as API traffic grows. Exact `totalCount`
  (`includeTotalCount: true`) will add one scan per call; anything else doing a
  sequential scan should be explained.
- `rows_per_day` should be about 17,280 per network, and `chain_days` should
  match the age of the index. A lower rate means the index does not cover the
  whole span or retention has removed old rows.
- `older_30d`, `older_90d` and `older_365d` are the first backlog a window of
  that length would have to prune.

If the deployment runs multiple networks far out of step, compare the lagging
network's page plan before considering the network-first index above. Do not add
it on a single-network deployment, where it is an unused write cost.

## Found along the way

- **`getIndexedTip` returned two different rows' maxima.** Fixed with the tip
  lookup above. `latestIndexedAt` now belongs to the ledger named by
  `latestIndexedLedger`.
- **Exact `totalCount` for ledgers is a full scan.** It is opt-in and documented
  as exact; the audit records it rather than changing the API contract.
- **A lagging network pays for the other network's rows.** The primary key is
  ordered by `sequence, network`, so the listing scans the leading chain's
  entries until it reaches the lagging chain's tip. The candidate index above is
  the measured fix; it is not worth its write cost on the common single-network
  deployment.
