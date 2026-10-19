# `ledger_retry_queue` review: indexes, scans, growth

Review of `ledger_retry_queue` (created in `008_retry_queue`) for index coverage,
unused or redundant indexes, and unbounded growth. Each change below is backed
by a measurement in this document. How every number was produced is described
in [Method](#method), and [Production measurements](#production-measurements)
is the slot for the same numbers from a real deployment.

## Summary

| Finding | Evidence | Change |
|---|---|---|
| The poll index does not carry `network`, so one network's backlog sits in front of every other network's poll | testnet poll with nothing due: **578 buffers** (falls back to a primary-key scan) vs **2** with `network` leading | `idx_retry_queue_next_attempt (next_attempt_at)` replaced by `idx_retry_queue_network_next_attempt (network, next_attempt_at)`, same predicate (migration 015) |
| Rows outlive their ledger. The worker re-indexes ledgers that are already indexed, and `permanently_failed` rows are never deleted | simulated week: **504 of 504** worker retries were for already-indexed ledgers; **21** stale `permanently_failed` rows left behind, one per stuck ledger per network | `indexLedger` deletes the queue row in the statement that already clears `failed_ledgers` (`clearLedgerFailures`); migration 015 removes existing stale rows |
| `lumina_indexer` cannot write to the table at all under `db/roles.sql` | read from `db/roles.sql`: `REVOKE ALL` plus an allowlist that does not name `ledger_retry_queue` or `failed_ledgers` | SELECT/INSERT/UPDATE/DELETE granted on both, with assertions in `db/verify_roles.sql` |
| The primary key is needed | used by all three point statements and by `ON CONFLICT` | none |
| The poll index shows almost no scans on a healthy deployment, and that is not evidence it is unused | 62,243 seq scans vs 1 index scan over a simulated week once vacuum keeps the table small | kept; see [Why the poll index stays](#why-the-poll-index-stays) |

Write-path cost of the changes: the extra delete in `indexLedger` adds about
**2–4 µs** per ledger server-side (pgbench: 0.012–0.013 ms → 0.014–0.016 ms)
and no round trip, because it shares a statement with the existing
`failed_ledgers` delete. Swapping the index leaves the count at one entry per
queue write. The queue is written only when a ledger has exhausted its
in-process retries, which is off the hot path.

## The table and what touches it

```
ledger_retry_queue (ledger, network) PK
  attempt_count, next_attempt_at, last_error, first_failed_at,
  last_attempted_at, permanently_failed
```

| Statement | Where | Index |
|---|---|---|
| `SELECT attempt_count … WHERE ledger = $1 AND network = $2` | `enqueueLedgerRetry` | PK |
| `INSERT … ON CONFLICT (ledger, network) DO UPDATE` | `enqueueLedgerRetry` | PK (the conflict target) |
| `SELECT ledger … WHERE network = $1 AND NOT permanently_failed AND next_attempt_at <= NOW() ORDER BY next_attempt_at LIMIT $2` | `getPendingRetries`, every 30 s per network | poll index |
| `DELETE … WHERE ledger = $1 AND network = $2` | `removeLedgerFromRetryQueue` (retry worker) | PK |
| `DELETE … WHERE ledger = $1 AND network = $2` | `clearLedgerFailures`, inside every `indexLedger` (**new**) | PK |

Rows are created by `fetchAndIndexLedgerWithRetry` when a ledger exhausts its
in-process retries. It is reached from three callers: the forward loop, the
backfill worker and gap repair.

## Findings

### 1. The poll index ignores `network`

`getPendingRetries` filters on `network`, but the index was on
`next_attempt_at` alone. With a single network that is invisible. With several
networks, every due row on one network is an index entry another network's poll
has to step over. When that becomes expensive enough, the planner abandons the
index for a primary-key scan with `network` as a non-leading column.

150,005 rows: 50,000 due on mainnet, 100,000 `permanently_failed` on mainnet,
5 not yet due on testnet. Same data for each plan, `VACUUM ANALYZE` first.

| Poll | No poll index | `(next_attempt_at)` (old) | `(network, next_attempt_at)` (new) |
|---|---|---|---|
| testnet, nothing due | PK scan, 578 buffers, 3.0 ms | PK scan, **578 buffers**, 3.5 ms | index scan, **2 buffers**, 0.02 ms |
| mainnet, 10 due | parallel seq scan, 1,439 buffers, 10.7 ms | index scan, 3 buffers, 0.02 ms | index scan, 3 buffers, 0.03 ms |

The new index serves both cases; the old one served only the network with the
backlog. Size with 50,000 entries, both bulk-built: 1,552 kB new vs 1,112 kB old.
The difference is the `network` text in each key, and it is paid only while a
backlog exists.

### 2. Rows outlive the ledgers they are for

All three callers retry a failed ledger themselves on their next pass:
`runLedgerCatchUp` stops at the failed ledger and starts there next tick,
backfill `continue`s on the same ledger, and gap repair finds the same gap
again. So the ledger nearly always lands through the caller, not through the
retry worker. But only the retry worker deleted queue rows, so:

- **Transient failure** (fails once, lands next tick): the row stays until the
  worker's next poll, which then fetches the ledger from Horizon and writes it
  again. The write is a no-op (`ON CONFLICT DO NOTHING`), but it still probes
  every unique index on `ledgers`, `transactions` and `operations`. That is
  write-path work on the bottleneck for nothing.
- **Persistent failure** (fails for more than about 10 ticks, about a minute at
  the default 5 s poll interval): the forward loop re-enqueues it every tick, so
  `attempt_count` reaches 10 and the row becomes `permanently_failed`. The
  worker stops polling it, and nothing deletes it when the ledger later lands.
  The row then claims a ledger is permanently failed when it is indexed.

`failed_ledgers` already had the right behaviour: `indexLedger` clears it inside
the ledger's transaction. The queue now gets the same treatment, in the same
statement:

```sql
WITH cleared_failure AS (
  DELETE FROM failed_ledgers WHERE sequence = $1 AND network = $2
)
DELETE FROM ledger_retry_queue WHERE ledger = $1 AND network = $2
```

A periodic prune (`DELETE … USING ledgers`) was measured and rejected. With
50,000 queue rows that are genuinely not yet indexed, it hash-joins a full scan
of `ledgers`: 200 ms against 1M ledgers, growing with the chain, every 30 s per
network. The in-transaction delete is a primary-key probe on a near-empty table:
4 buffers, about 3 µs.

### 3. The indexer had no privileges on the table

`db/roles.sql` revokes everything from `lumina_indexer` and grants an
allowlist. `ledger_retry_queue` and `failed_ledgers` were not on it, and default
privileges grant future tables SELECT only. On a deployment provisioned with
roles:

- `enqueueLedgerRetry` fails with `permission denied`. The error propagates by
  design, so the forward loop stalls on the ledger rather than recording it.
- `indexLedger` already ran `DELETE FROM failed_ledgers` in every ledger's
  transaction, so **every ledger write** fails the same way. This predates this
  review, and the new queue delete would have hit it too.

This matters for the measurement itself. On such a deployment
`pg_stat_user_indexes` shows the queue's indexes as idle because nothing can
write to the table, not because nothing needs them. The grants are added and
asserted in `db/verify_roles.sql`.

This was established by reading the files, not by running them. `db/roles.sql`
currently aborts earlier on a schema built from `db/schema.sql`
(`cannot change owner of sequence "api_keys_id_seq"`), an unrelated problem
noted under [Follow-ups](#follow-ups).

### Why the poll index stays

After a simulated week with regular vacuuming, the poll index had **1** scan
against **62,243** sequential scans. While the queue holds a few rows, a seq
scan of one page is the cheapest plan, and the planner is right to choose it.
Read naively, `pg_stat_user_indexes` says to drop the index.

The index exists for the case the counters do not see: a backlog. Without it,
the 50,000-row backlog above makes every poll a 1,439-buffer parallel seq scan,
every 30 s per network, for as long as the backlog lasts. Its cost while idle is
nothing on the hot path. The `indexLedger` delete finds no row or removes one,
and neither writes an index entry. The only index writes are on enqueue, which
happens only after a ledger has failed.

### Growth

Before this change the table grew without bound, by one `permanently_failed`
row per network for every ledger stuck for more than about a minute, plus one
per stuck backfill ledger. At roughly 89 bytes per row plus index entries that
is slow growth. The problem is that the rows are wrong, not that they are large.

After it, a row exists only while its ledger is absent from `ledgers`. The table
is bounded by the number of ledgers currently missing, the same set gap repair
works on. The rows that can still accumulate are ledgers that never land, for
example ledgers outside the history window of a Horizon that is not
full-history. Those also appear in `failed_ledgers` and in the
`ledgerGapsCount` metric. No retention window is added (see
[RETENTION.md](RETENTION.md)): deleting them would hide missing data, not
reclaim space.

Simulated week, three networks, same workload before and after:

| | Before | After |
|---|---|---|
| Rows inserted | 525 | 525 |
| Worker retries of already-indexed ledgers | 504 | 0 |
| Rows left at the end | 21 (all `permanently_failed`, all for indexed ledgers) | 0 |

## Method

All measurements were taken on PostgreSQL 16.13 (the version in
`docker/docker-compose.yml`), on a scratch database built from `db/schema.sql`.
**None come from a production deployment.** None was available to this review,
and the indexer on `main` did not compile at the time (see
[Follow-ups](#follow-ups)), so no deployment can be running it.

- **Workload replay.** A generator emits a week of traffic for three networks
  using the statements from `indexer/src/db.ts`, each in its own transaction.
  The only edit is `NOW()` → a simulated clock literal. Model: a 5 s forward-loop
  tick; one transient failure per network per hour; one ledger per network per
  day stuck for 3 minutes; retry worker every 30 s, 10 rows per poll; `VACUUM`
  every simulated hour in place of autovacuum. Without that `VACUUM`, the
  compressed timeline leaves hundreds of dead index entries per live row and the
  counters are meaningless: the first replay showed 21M `idx_tup_read` for at
  most a few dozen live rows.
- **Backlog plans.** `EXPLAIN (ANALYZE, BUFFERS)` on the dataset described in
  finding 1, after `VACUUM ANALYZE`.
- **Write-path cost.** `pgbench -M prepared -T 10`, one client, old statement
  against new, with empty and 20-row tables. Two runs each.

## Production measurements

Run against a deployment after a representative window:

```bash
psql "$DATABASE_URL" -f db/audit-ledger-retry-queue.sql
```

It reports the stats window, index usage, scan and write mix, rows by network
and state, rows whose ledger is already indexed, monthly growth, and the poll's
plan per network. It is read-only and never scans `ledgers` in full. Record the
output here with the deployment name, date and window length.

What to expect if the findings above hold:

- `seq_scan` far above `idx_scan` on the poll index. This is expected and not a
  reason to drop it.
- Zero "already indexed" rows once migration 015 has run.
- Every remaining row is a ledger that is also in `failed_ledgers`.

## Follow-ups (out of scope, found during the review)

- `failed_ledgers` has `idx_failed_ledgers_sequence (sequence, network)`, which
  duplicates its primary key, and the planner picked it for the new delete. It
  is a candidate for the same treatment as migration 007.
- `db/roles.sql` aborts on a schema built from `db/schema.sql`
  (`cannot change owner of sequence "api_keys_id_seq"`). The grant list is also
  missing other tables the indexer writes (e.g. `trades`).
- The indexer on `main` did not compile. #334 dropped the per-operation loop in
  `indexLedger` (restored on this branch), and `indexer/src/index.ts` and
  `horizon.ts` still reference missing exports and redeclare symbols.
- `db/check-schema-parity.sh` globs `*.down.sql` into the up chain and fails on
  `013_export_jobs`, so it cannot currently catch drift. Parity for this change
  was checked by hand: new `schema.sql`, old `schema.sql` plus 015, and new
  `schema.sql` replaying 008 and 015 all dump an identical
  `ledger_retry_queue`.
