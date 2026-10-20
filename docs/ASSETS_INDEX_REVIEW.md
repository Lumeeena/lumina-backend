# Assets index review

`assets` had a primary key and five secondary indexes, added by `011_assets` and
`015_asset_issuer_metadata`. This review measures what they cost, what reads
them, and how the table grows. The outcome is `016_assets_index_review`. It
drops four of them and replaces the fifth with a version that leads with
`network`. A one-line change to the listing's keyset predicate lets that index
seek to the cursor.

- [What touches the table](#what-touches-the-table)
- [Method](#method)
- [Results: writes](#results-writes)
- [Results: reads](#results-reads)
- [Decision](#decision)
- [Growth](#growth)
- [Re-running it on a deployment](#re-running-it-on-a-deployment)
- [Found along the way](#found-along-the-way)

## What touches the table

This list comes from the code, not from assumptions. `grep -rnE "(FROM|INTO|UPDATE|JOIN)\s+assets\b"`
finds these statements:

| Statement | Where | Key | Live? |
| --- | --- | --- | --- |
| `INSERT … ON CONFLICT DO UPDATE` (holder +0/+1, `last_activity_ledger`) | `upsertTrustline` | full PK | yes |
| `UPDATE … holder_count - 1` | `upsertTrustline` (limit `0`) | full PK | yes |
| `INSERT … ON CONFLICT DO UPDATE` (`last_activity_ledger`) | `updateTrustlineBalance`, every credit payment, twice | full PK | yes |
| `UPDATE … holder_count ± 1` | `updateTrustlineBalance` | full PK | yes |
| `SELECT … WHERE code, issuer, network` | `getAssetByKey` (`assetByKey`) | full PK | yes |
| `SELECT … WHERE network [AND code ILIKE] ORDER BY holder_count DESC, code, issuer` | `getAssets` `HOLDERS` (`assets`) | network + sort | yes |
| `SELECT … LEFT JOIN volume_agg … ORDER BY recent_volume DESC` | `getAssets` `VOLUME` | network | yes |
| `ORDER BY last_activity_ledger DESC` | `assetResolvers.ts` | network + sort | **no**: `assetResolvers` is never imported |
| `UPDATE … SET issuer_home_domain, issuer_metadata` | `updateIssuerMetadata` | full PK | **no**: never called |
| `UPDATE … SET is_lookalike WHERE asset_code AND issuer <>` | `flagLookalikeAssets` | code | **no**: never called |

Nothing reads `last_activity_ledger`, `issuer_home_domain` or `is_lookalike` in a
`WHERE` or `ORDER BY` that can actually run. The indexer writes the table on
almost every credit payment. Each payment calls `updateTrustlineBalance` twice,
once for the sender and once for the receiver, and each call upserts the asset
row. So the table is small, read rarely and written constantly, and every index
on it is paid for on the indexer's write path.

## Method

There is no production deployment to collect `pg_stat_user_indexes` from yet.
As with the [trustlines review](TRUSTLINES_INDEX_REVIEW.md), the measurement
replays real traffic through the real code. Unlike `trustlines`, `assets` has
API reads, and read plans on a few hundred replayed rows mean nothing. So each
run does three things:

1. **Seeds a real asset population.** `npm run audit:assets -- fetch-assets 4`
   samples Horizon's `/assets` on mainnet (24,296 assets) and testnet (19,130),
   four pages from each leading character so the sample covers the whole
   alphabet. `holder_count` comes from Horizon's authorized trustline count, so
   the distribution is real: on mainnet the median is 2 holders, p99 is 1,308
   and the maximum is 181,464. Both networks go into one database, as
   [MULTI_NETWORK.md](MULTI_NETWORK.md) allows.
2. **Replays real writes.** `npm run audit:assets -- fetch 400` caches 80,000
   mainnet operations (ledgers 65007300–65007467). That is the same cache and
   code `audit:trustlines` uses, now shared in `db/audit/horizonOps.ts`. The
   28,686 asset operations go through `processAssetOperation` from
   `indexer/src/db.ts`, one transaction per ledger. A `CHECKPOINT` comes first,
   so full-page writes are the same in every variant.
3. **Runs the API's own reads.** These are `getAssetByKey` and `getAssets` from
   `graphql-server/src/assets.ts`, imported directly, so the SQL is exactly
   what the resolvers send:
   - 200 point lookups per network;
   - ten keyset pages of each sort;
   - one page from the middle of the table;
   - five searches: `USD`, `BTC`, `AQUA`, `yUSDC`, and `zzqx`, which matches
     nothing.

   Each distinct statement is then `EXPLAIN (ANALYZE, BUFFERS)`ed five times.

The same caches were run against five databases that differ only in the indexes
on `assets`. Each was built fresh from `db/schema.sql`, so the counters start
at zero:

| Variant | Secondary indexes |
| --- | --- |
| current | `holder_count`, `activity`, `network`, `issuer_home_domain`, `lookalike` |
| drop unused | `holder_count` only |
| **proposed** | `(network, holder_count DESC, asset_code, asset_issuer)` only |
| proposed + trigram | proposed + GIN `asset_code gin_trgm_ops` |
| PK only | none |

PostgreSQL 16.13 (Homebrew build, defaults, autovacuum on). Each variant ran
three times. Write figures are medians, and the three raw values are shown
where they vary.

## Results: writes

The replay made 85,703 updates and 211 inserts in every variant, about three
asset updates per operation.

| | current | drop unused | **proposed** | + trigram | PK only |
| --- | ---: | ---: | ---: | ---: | ---: |
| HOT updates | 61.0% | 63.2% | **63.1%** | 63.1% | 97.8% |
| WAL written¹ | 56.8 MB | 44.6 MB | **47.0 MB** | 56.4 MB | 35.3 MB |
| (three runs) | 66.7 / 56.3 / 56.8 | 40.4 / 44.7 / 44.6 | 43.6 / 47.7 / 47.0 | 55.5 / 57.1 / 56.4 | 35.3 / 35.5 / 35.2 |
| index size after | 18.8 MB | 16.7 MB | **17.5 MB** | 24.1 MB | 6.8 MB |
| heap size after | 15.9 MB | 15.8 MB | 15.2 MB | 15.8 MB | 14.2 MB |
| replay wall time | 21.9 s | 21.2 s | 21.9 s | 21.4 s | 19.9 s |
| write-path index scans | PK only | PK only | PK only | PK only | PK only |
| write-path seq scans | 0 | 0 | 0 | 0 | 0 |

¹ Whole-cluster WAL during the replay, starting from a checkpoint. The
`trustlines` and `asset_volume_buckets` writes are the same in every variant, so
the differences come from `assets`. Run-to-run spread is about ±3 MB, so
drop-unused and proposed are within noise of each other.

Wall time is within noise at this scale and is not used as evidence.

**The four dropped indexes cost about 20% of WAL and gave nothing back.**
Without them, WAL falls from 56.8 to 44.6–47.0 MB. HOT barely moves (61% → 63%)
because `idx_assets_activity` only blocks HOT on an asset's *first* update in
each ledger. That update changes `last_activity_ledger`; later updates in the
same ledger write the same value back. The WAL saving is mostly from the other
direction: every update that was already non-HOT also wrote entries into four
indexes nobody reads.

**`holder_count` is the remaining HOT blocker, and it can't go.** With no
secondary index, HOT rises to 97.8% and WAL falls another 25%. In other words,
about 30,000 of the 85,703 updates changed `holder_count`. Any index that serves
the holders listing must contain `holder_count`, so those updates pay for it.
The alternative, a sequential scan and sort on every listing page, is in the
next table. A large share of those 30,000 updates is churn rather than real
holder changes (see [Found along the way](#found-along-the-way)). Fixing that
in the indexer would cut this cost without touching the schema.

## Results: reads

Shared buffers and median execution time from the second run. Buffers are
deterministic and times are noisy. "Proposed" includes the keyset predicate
change described below.

| Query | current | **proposed** | + trigram | PK only |
| --- | --- | --- | --- | --- |
| `assetByKey` | pkey, 6 buf | pkey, 6 buf | pkey, 6 buf | pkey, 6 buf |
| mainnet `assets` page 1 | holder_count, 69 buf | network_holders, 66 buf | same | Seq Scan, 1,942 buf, 7.3 ms |
| **testnet `assets` page 1** | holder_count, **1,819 buf**, 0.47 ms | network_holders, **65 buf**, 0.06 ms | same | Seq Scan, 1,942 buf, 6.4 ms |
| testnet mid-table cursor | holder_count, 375 buf | network_holders, 60 buf | same | Seq Scan, 1,942 buf |
| mainnet search `USD` | holder_count, 10,109 buf, 7.0 ms | network_holders, 8,552 buf, 4.0 ms | same plan | Seq Scan, 10.8 ms |
| mainnet search `zzqx` | network, 923 buf, 8.3 ms | **Seq Scan**, 1,973 buf, 11.6 ms | Bitmap, 113 buf, 0.38 ms | Seq Scan, 10.7 ms |
| testnet search `zzqx` | network, 386 buf, 4.5 ms | **Seq Scan**, 1,973 buf, 10.3 ms | Bitmap, 113 buf, 0.35 ms | Seq Scan, 11.6 ms |
| VOLUME page 1² | network, 1,093 buf, 33.7 ms | Seq Scan, 2,154 buf, 22.7 ms | Seq Scan | Seq Scan |

² The VOLUME sort is broken (see below), so treat this row only as which scan it
uses. Its timings swing between runs because of the `asset_volume_buckets`
aggregate.

### `network` belongs first

`idx_assets_holder_count` is `(holder_count DESC, asset_code, asset_issuer)`.
Every listing filters on `network`, so on a database holding two networks the
index interleaves them. To return testnet's page 1, the scan walked past the
1,383 mainnet assets with more holders than testnet's top 20, then filtered
them out. Leading with `network` turns that into a seek: 1,819 → 65 buffers.
On a single-network database the two indexes behave the same. The new one is
a few bytes per entry wider.

### The keyset predicate couldn't seek

The cursor clause was a single `OR`:

```sql
AND (a.holder_count < $c OR (a.holder_count = $c AND (a.asset_code > $code OR …)))
```

No index condition can be derived from that, so every page walked the index
from the top and filtered out every row before the cursor. Page *n* cost *n*
pages of rows. The plan for a page from the middle of mainnet showed
`Rows Removed by Filter: 12,254`. `getAssets` now also sends the bound the `OR`
already implies:

```sql
AND a.holder_count <= $c AND (… the same OR …)
```

The planner uses it as an `Index Cond`. Measured on the proposed index, before
and after the change:

| | before | after |
| --- | ---: | ---: |
| mainnet mid-table cursor | 8,426 buf, 2.2 ms | 177 buf, 0.24 ms |
| testnet mid-table cursor | 1,825 buf, 1.1 ms | 60 buf, 0.13 ms |
| mainnet page 10 | 357 buf | 79 buf |

The results are unchanged; the new bound only removes rows the `OR` already
excluded. Pages that land in a long run of equal `holder_count` (for example
the thousands of 1-holder assets) still filter within that run. A row
comparison would remove that too, but it can't express the mixed
`DESC, ASC, ASC` order.

### Sequential scans that remain

- **Search is a full scan of the network in every variant.** `asset_code ILIKE
  '%term%'` has no index that can serve it. Today's schema hides that behind
  `idx_assets_network`, which on a two-network database cuts the scan to one
  network's rows. With it gone, a search with few or no matches is a sequential
  scan of the whole table. On this two-network database that measured 8.3 → 11.6
  ms on mainnet and 4.5 → 10.3 ms on testnet. On a single-network database
  `idx_assets_network` matches every row and the planner already ignores it,
  so nothing changes there. Common terms (`USD`) got faster, because the
  network-leading index finds 20 matches sooner.
- **A trigram index is the real fix for search, and it isn't adopted here.** It
  makes every search a ~0.4 ms bitmap scan. But it returns WAL to today's level
  (56.4 vs 47.0 MB, +20%) and adds 6.5 MB of GIN, 37% more index, on 43k rows.
  The reason is the ~35% of updates that `holder_count` keeps from being HOT:
  each one also inserts into the GIN index. At 43k rows, search costs ~10 ms.
  That trade goes the other way when the table is several times larger, or
  when the indexer's `holder_count` churn is fixed (fewer non-HOT updates means
  fewer GIN inserts). Re-measure it with this tool then.
- **The VOLUME listing scans every asset of the network.** It sorts on a value
  computed from `asset_volume_buckets`, so no index on `assets` can serve it.
  It's also broken; see below.

## Decision

`016_assets_index_review`:

| Index | Evidence | |
| --- | --- | --- |
| `idx_assets_activity` | 0 scans. Only reader is unmounted code. Its column is written on every asset's first payment in each ledger. | drop |
| `idx_assets_issuer_home_domain` | 0 scans. No query filters on it. The only writer is never called. | drop |
| `idx_assets_lookalike` | 0 scans. No query filters on it. The only writer is never called. | drop |
| `idx_assets_network` | Chosen only by plans that are slower with it (VOLUME). Its column is the leading column of the replacement. Search on a two-network database loses 3–6 ms (above). | drop |
| `idx_assets_holder_count` | Serves the default listing, but without `network`. | replace |
| `idx_assets_network_holders` | `(network, holder_count DESC, asset_code, asset_issuer)`. Testnet page 1: 1,819 → 65 buffers. Same write cost within noise. | add |

Together that cuts replay WAL from 56.8 to 47.0 MB (−17%) and index size from
18.8 to 17.5 MB. `getAssets` gains the `holder_count <=` bound.

The migration builds the new index `CONCURRENTLY` before dropping anything, so
the listing never lacks an index and the indexer's writes are never blocked.
The down migration restores all five.

The three dropped indexes for unmounted features each belong to code that
doesn't run yet. When the `ACTIVITY` sort, a home-domain filter or a lookalike
filter is wired up, it should come with an index designed for that query, and
a re-run of this audit, rather than revive these.

**`fillfactor` is not changed.** With no secondary index, 97.8% of updates were
HOT at the default fillfactor of 100. So page space isn't what stops HOT here;
the `holder_count` index is.

## Growth

**There is no retention, and there should not be.** `assets` is current state:
one row per (code, issuer, network), carrying `first_seen_ledger` and an
incrementally maintained `holder_count`. Neither can be rebuilt from a pruned
history. It belongs with `accounts` and `trustlines` in the "not prunable" list
in [RETENTION.md](RETENTION.md), which now says so.

**It only grows, but the bound is the number of assets, not the traffic.**

- A row is created the first time the indexer sees a `change_trust` or a credit
  payment for an asset after `START_LEDGER`.
- **Nothing deletes a row.** Removing the last trustline only decrements
  `holder_count`. Rows with `holder_count = 0` stay forever, and so do assets
  whose issuer has merged away.
- So the row count is bounded by the distinct issued assets active since
  `START_LEDGER`, per network: about 25k per network in this sample, and more
  on a deployment that has indexed from early ledgers. The replay touched 247
  distinct assets in 168 ledgers (~15 minutes). The active set is small, and
  growth comes from new assets, not from volume.
- Traffic doesn't add rows. It adds **dead tuples**: ~3 updates per asset
  operation, concentrated on a few popular assets. The replay left 33,634 dead
  tuples on a 43,637-row table. HOT pruning reclaims most of them in-page, and
  autovacuum's default 20% threshold handles the rest. The non-HOT updates are
  what bloat the indexes. That is why the index is bigger than the heap here,
  and why fewer, narrower indexes matter more than their size suggests.

**Size per row** (43,637 rows, after the replay):

| | heap B/row | index B/row |
| --- | ---: | ---: |
| current | 372 | 441 |
| proposed | 356 | 411 |

At these rates, a million assets would be about 0.75 GB including indexes.
That's small next to `operations`, and it grows at the rate new assets appear
on the network, not with ledger count. `issuer_metadata` is JSONB and is
currently always NULL (its writer is never called). Once real `stellar.toml`
content lands there, re-run `bytes per row`: large documents will move to TOAST
and change these numbers.

## Re-running it on a deployment

`db/audit/assets.sql` is read-only. It is the collection step the issue asks
for on a real deployment:

```bash
psql "$DATABASE_URL" -f db/audit/assets.sql
# or, labelled:
DATABASE_URL=... npm run audit:assets -- report
```

Record `stats_reset` with the output, because the counters are cumulative since
then. On a deployment, check:

- `idx_assets_network_holders` and `assets_pkey` hold all the index scans.
- `seq_scan` grows only with `assets(search:)` and `VOLUME` traffic.
- `hot_pct` is around 60% or higher. A lower value means `holder_count` churn
  has grown; see below.
- `writes_column` in `index columns` is `true` only for
  `idx_assets_network_holders`.

To reproduce the comparison, point `AUDIT_DATABASE_URL` at a scratch database
built from `db/schema.sql`, with the index variant under test applied, and run
`fetch`, `fetch-assets`, then `run <label>`. `run` refuses a non-empty `assets`
table and writes its full result, plans included, to
`db/audit/.cache/assets-run-<label>.json`.

## Found along the way

These are outside this issue and were left unfixed. They are recorded here
because the measurement surfaced them, and the first one inflates the cost this
review is about.

- **`holder_count` double-counts every new holder.** In
  `updateTrustlineBalance`, a payment that creates a trustline with a positive
  balance takes the "became a holder" branch (+1) *and* the
  `isInsert && isHolder` branch (+1). One payment to a new account leaves
  `holder_count = 2`. If that account then sends everything on to a third
  account, there is one real holder and `holder_count = 3`. Together with the
  delta-from-zero balances in the
  [trustlines review](TRUSTLINES_INDEX_REVIEW.md#found-along-the-way), where
  senders go negative and cross zero repeatedly, this drives most of the
  ~30,000 `holder_count` updates in the replay. Every one of those updates is
  non-HOT.
- **The `VOLUME` sort lists zero-volume assets first and then stops.**
  `ORDER BY v.recent_volume DESC` puts NULLs first, and assets without buckets
  have `v.recent_volume IS NULL`, so page 1 is zero-volume assets. The next
  cursor is `0|…`. Then `v.recent_volume < 0` matches nothing, so page 2 is
  empty and `hasNextPage` is false. In the replay, the 208 assets that had
  volume were never returned.
- `assetResolvers.ts`, `updateIssuerMetadata` and `flagLookalikeAssets` are
  dead code. The first duplicates `getAssets` and `getAssetByKey` with
  different semantics. If `flagLookalikeAssets` is ever wired up, its
  `WHERE asset_code = $1 … AND network = $3` is served by the primary key's
  leading column and needs no index of its own.
- `main` did not parse when this review started: #351 had left two syntax
  errors in `indexer/src/db.ts`. They are fixed in a separate commit on this
  branch, because the audit imports that module.
