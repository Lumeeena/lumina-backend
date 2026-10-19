# Trustlines index review

`trustlines` had a primary key and four secondary indexes, all added by
`010_trustlines` without a query that read them. This is the review of what they
cost, what used them, and how the table grows. The outcome is
`015_drop_unused_trustline_indexes`, which drops all four.

- [What touches the table](#what-touches-the-table)
- [Method](#method)
- [Results](#results)
- [Decision](#decision)
- [Growth](#growth)
- [Re-running it on a deployment](#re-running-it-on-a-deployment)
- [Found along the way](#found-along-the-way)

## What touches the table

Read from the code, not assumed. `grep -rn trustlines` over `graphql-server/`,
`indexer/` and `shared/` finds four statements, all in
`indexer/src/db.ts`, all writes:

| Statement | Function | Key |
| --- | --- | --- |
| `INSERT … ON CONFLICT DO UPDATE` (limit) | `upsertTrustline` | full PK |
| `DELETE … RETURNING balance` | `upsertTrustline` (limit `0`) | full PK |
| `INSERT … ON CONFLICT DO UPDATE` (balance) | `updateTrustlineBalance` | full PK |
| `SELECT balance` in that upsert's `RETURNING` | `updateTrustlineBalance` | full PK |

No API query reads `trustlines`. Asset holder counts come from
`accounts.balances` (`graphql-server/src/assets.ts`) and `assets.holder_count`.
Every index other than the primary key was therefore a candidate before any
measurement. The measurement had to confirm that, and it also had to show what
the indexes cost.

## Method

There is no production deployment to collect `pg_stat_user_indexes` from yet,
so the measurement replays real mainnet traffic through the real write path:

1. `npm run audit:trustlines -- fetch 400` pages 80,000 operations from
   `horizon.stellar.org` in ledger order (ledgers 65002303–65002408) and keeps
   the 50,877 that `processAssetOperation` acts on (`change_trust`, `payment`,
   the two path payments).
2. `npm run audit:trustlines -- replay` applies them to an empty database built
   from `db/schema.sql`. It calls `processAssetOperation` from
   `indexer/src/db.ts` with one transaction per ledger, the same way
   `indexLedger` does. It then reports WAL written, `pg_stat_user_indexes`,
   `pg_stat_user_tables` and the growth queries in `db/audit/trustlines.sql`.
3. The same cached operations are replayed into four databases that differ only
   in the indexes on `trustlines`.

PostgreSQL 16.13 (Homebrew build, defaults, autovacuum on). Each database was
created fresh, so the counters start at zero without a `pg_stat_reset()`.

Most of the 50,877 operations are native-XLM payments, which never touch
`trustlines`. The replay produced 2,340 trustline writes: 476 inserts, 1,838
updates and 26 deletes. The ratio is the finding that matters: **79% of writes
were updates to an existing row.** That is what makes HOT updates the deciding
factor.

## Results

| | current | drop HOT blockers¹ | **drop all four** | drop all + `fillfactor=90` |
| --- | ---: | ---: | ---: | ---: |
| `trustlines_pkey` scans | 2,314 | 2,314 | **4,584** | 4,584 |
| `idx_trustlines_asset` scans | 1,074 | 1,208 | — | — |
| `idx_trustlines_account` scans | 1,196 | 1,062 | — | — |
| `idx_trustlines_asset_active` scans | 0 | — | — | — |
| `idx_trustlines_ledger` scans | 0 | — | — | — |
| sequential scans² | 9 | 8 | 8 | 8 |
| HOT updates | 0 / 1,838 (0%) | 1,776 (96.6%) | **1,780 (96.8%)** | 1,823 (99.2%) |
| WAL written³ | 2.95 MB | 1.63 MB | **1.47 MB** | 1.44 MB |
| index size | 311 KB | 205 KB | **106 KB** | 106 KB |
| heap size | 180 KB | 156 KB | 156 KB | 172 KB |
| replay wall time | 2.19 s | 1.98 s | 2.03 s | 2.00 s |

¹ Drops `idx_trustlines_ledger` and `idx_trustlines_asset_active` only.
² Includes the audit's own `count(*)` and growth queries. The number does not
change between variants.
³ Whole-cluster WAL during the replay. The `assets` and `asset_volume_buckets`
writes are identical across variants, so the difference is all `trustlines`.

Wall time at this scale is within run-to-run noise, so it is reported here but
not used as evidence. WAL and HOT are deterministic for a given operation
stream.

### The two indexes with scans were not used

`idx_trustlines_asset` and `idx_trustlines_account` show about 1,100 scans each,
which looks like usage. It isn't. With them present, the old-balance lookup in
`updateTrustlineBalance` plans as:

```
Index Scan using idx_trustlines_account on trustlines
  Index Cond: ((account = 'GA'::text) AND (network = 'mainnet'::text))
  Filter: ((asset_code = 'USDC'::text) AND (asset_issuer = 'GB'::text))
```

That is a full-key lookup served by a narrower index plus a filter, which is a
worse plan than the primary key. With the indexes dropped:

```
Index Scan using trustlines_pkey on trustlines
  Index Cond: ((account = 'GA'::text) AND (asset_code = 'USDC'::text) AND (asset_issuer = 'GB'::text) AND (network = 'mainnet'::text))
```

The primary key absorbs exactly their 2,270 scans (2,314 + 2,270 = 4,584), and
the number of sequential scans doesn't change. A non-zero `idx_scan` shows that
the planner picked an index. It doesn't show that the index was needed.

### Why there were no HOT updates

An update can be HOT (heap-only, writing no index entries) only if it changes no
indexed column and no column named in a partial-index predicate. Every balance
update writes `balance` and `last_modified_ledger`:

- `idx_trustlines_ledger` indexes `last_modified_ledger`.
- `idx_trustlines_asset_active`'s predicate is `balance <> '0'`.

Either one alone was enough to rule out HOT. So every one of the 1,838 updates
wrote a new heap tuple *and* a new entry in all five indexes. Dropping those two
indexes alone takes HOT from 0% to 96.6% and cuts WAL by 45%. Dropping the
remaining two takes another 10% of WAL and half the remaining index size.

## Decision

Drop all four (`015_drop_unused_trustline_indexes`):

| Index | Evidence | |
| --- | --- | --- |
| `idx_trustlines_ledger` | 0 scans. Blocks every HOT update. | drop |
| `idx_trustlines_asset_active` | 0 scans. Blocks every HOT update. Its predicate is also wrong (see below). | drop |
| `idx_trustlines_account` | Scans are all full-key lookups the PK serves better. `(account)` is already the PK's leading column. | drop |
| `idx_trustlines_asset` | Scans are all full-key lookups the PK serves better. No query filters by asset alone. | drop |

The down migration restores all four. If an asset-centric read ("holders of X")
is ever added, it should come with an index designed for that query, such as a
partial index on `balance::numeric > 0`, rather than revive these.

**`fillfactor` is not changed.** At 90 it lifts HOT from 96.8% to 99.2%, but it
saves only another 2% of WAL and makes the heap 10% bigger. On a table this
small the trade can't be judged reliably. It is worth re-measuring on a
deployment that has been running for weeks, where pages are full and the
`n_tup_hot_upd / n_tup_upd` ratio from `db/audit/trustlines.sql` shows whether
updates are failing to find room on the page.

## Growth

**There is no retention, and there should not be.** `trustlines` is current
state, not history: one row per (account, asset, network) pair. A time window
would delete live trustlines whose last payment happened to be old. It belongs
with `accounts` in the "not prunable" list in [RETENTION.md](RETENTION.md),
which now says so.

**It doesn't grow without bound, but it isn't the size of the network either.**

- A row is created the first time the indexer sees a `change_trust`, or a
  credit payment to or from the pair, after it starts indexing.
- A row is deleted only by a `change_trust` with limit `0`. That is
  the only way a trustline can be removed on Stellar (`account_merge` requires
  removing them first), so a removal after the indexer's start ledger is always
  seen.
- A balance going to zero does not delete the row, which is correct, because
  the trustline still exists.

So the upper bound is the set of live trustlines that have been *active* since
`START_LEDGER`, plus one row per (issuer, asset) for issuers that send their own
asset (see below). Growth is front-loaded: new pairs appear quickly after start
and slow down as the active set saturates. In the replay, 476 rows were inserted
over 106 ledgers from an empty table. That is a cold-start rate, not a steady
state, and it should not be extrapolated.

**Size per row**, measured on the replay (450 rows; small-table page rounding
inflates these, so treat them as upper bounds):

| | heap B/row | index B/row |
| --- | ---: | ---: |
| before | 400 | 692 |
| after | 346 | 237 |

The dominant cost of the old indexes was write amplification, not disk. Every
update rewrote five index entries. That cost grows with traffic, and it lands
on the indexer write path.

## Re-running it on a deployment

`db/audit/trustlines.sql` is read-only and is the collection step the issue
asks for on a real deployment:

```bash
psql "$DATABASE_URL" -f db/audit/trustlines.sql
# or, labelled:
DATABASE_URL=... npm run audit:trustlines -- report
```

Record `stats_reset` with the output, because the counters are cumulative since
then. On a deployment, check two things:

- `trustlines_pkey` should hold all the scans and `seq_scan` should stay flat
  as traffic grows.
- `hot_pct` should stay above 90%. If it drops as the table fills, revisit
  `fillfactor`.

To reproduce the comparison above, point `AUDIT_DATABASE_URL` at a scratch
database built from `db/schema.sql` (and one with the old indexes recreated
from `015_drop_unused_trustline_indexes.down.sql`) and run `fetch` then
`replay`. `replay` refuses a non-empty `trustlines` table.

## Found along the way

These are outside this issue, and none of them affects the index decision. They
are recorded because the growth queries surfaced them:

- **Balances are deltas from zero, not balances.** `updateTrustlineBalance`
  starts a pair it has never seen at `0` and adds the payment. A trustline that
  held funds before the indexer started gets a wrong balance, and a negative
  one if its first observed payment is a debit. That was 115 of 450 rows in the
  replay.
- **Issuers get a row for their own asset.** An issuer paying out its asset is
  treated as debiting a trustline it cannot have. 16 rows, 15 of them negative.
- **`balance <> '0'` misses zero.** Numeric arithmetic writes zero back as
  `'0.0000000'`. That was 50 of 107 zero-balance rows, so the dropped
  `idx_trustlines_asset_active` would have included them as "active".
- Path payments credit the receiver with the *source* asset
  (`processAssetOperation` uses `source_asset_*` for both sides of
  `path_payment_strict_send`).
- Claimable balances, clawbacks, trades and liquidity-pool deposits move
  balances without going through `updateTrustlineBalance`.
