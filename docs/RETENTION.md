# Data retention

Everything the indexer writes is kept forever by default. That is a safe
default and an unexamined one: a deployment indexing mainnet accumulates
without bound, and the first real conversation about it tends to happen when the
disk fills. This document is that conversation, in advance.

- [Turning it on](#turning-it-on)
- [The chain has to be ordered](#the-chain-has-to-be-ordered)
- [Which tables are prunable](#which-tables-are-prunable)
- [Chain time, not index time](#chain-time-not-index-time)
- [How pruning runs](#how-pruning-runs)
- [Interaction with backfill](#interaction-with-backfill)
- [Verifying it is working](#verifying-it-is-working)

## Turning it on

Each prunable table has its own window, in **days of chain history**. The
default for every one of them is `0`, which means keep everything.

| Variable                       | Table              | Default          |
| ------------------------------ | ------------------ | ---------------- |
| `RETENTION_LEDGERS_DAYS`       | `ledgers`          | `0` (unlimited)  |
| `RETENTION_TRANSACTIONS_DAYS`  | `transactions`     | `0` (unlimited)  |
| `RETENTION_OPERATIONS_DAYS`    | `operations`       | `0` (unlimited)  |
| `RETENTION_CONTRACT_EVENTS_DAYS` | `contract_events` | `0` (unlimited)  |
| `RETENTION_CUSTOM_EVENTS_DAYS` | `custom_events`    | `0` (unlimited)  |

Two settings control the job itself:

| Variable                     | Default  | Notes                                                             |
| ---------------------------- | -------- | ----------------------------------------------------------------- |
| `RETENTION_PRUNE_INTERVAL_MS` | `3600000` | How often the prune runs. Long by default — retention is a coarse control, not a latency-sensitive one. |
| `RETENTION_PRUNE_BATCH_SIZE`  | `10000`  | Rows deleted per batch.                                            |

There is no separate enable flag. A window of `0` *is* "disabled", because a
flag that can disagree with its own window is one more thing to get wrong, and
`RETENTION_OPERATIONS_DAYS=-1` is rejected at startup rather than being treated
as "unset".

A worked example — keep a year of the ledger chain, drop contract events after a
week:

```sh
RETENTION_LEDGERS_DAYS=365
RETENTION_TRANSACTIONS_DAYS=365
RETENTION_OPERATIONS_DAYS=365
RETENTION_CONTRACT_EVENTS_DAYS=7
```

## The chain has to be ordered

`operations` → `transactions` → `ledgers` is a foreign key chain, and none of
those constraints cascade. That makes prune order necessary but **not
sufficient**: order only decides which statement runs *first*, and if a table
was never given a window there is no statement of its to run first.

So if a table with a window is referenced by a table without one, the delete
fails on the constraint:

```sh
RETENTION_LEDGERS_DAYS=365   # every transaction in those ledgers still points at them
```

That delete would fail on **every round, forever** — no error at startup, and a
window that looks configured while never deleting a row. Retention therefore
rejects it at startup, and the message names the two variables and the two
numbers:

```
Configuration error: RETENTION_TRANSACTIONS_DAYS must be at least
RETENTION_LEDGERS_DAYS (365), got 0 — 0 keeps every row, so the delete would
fail on the foreign key and the window would never take effect
```

The rule: **a child must be pruned at least as far back as its parent.**

- `ledgers` needs `transactions` ≥ its window, and `transactions` needs
  `operations` ≥ its own.
- Equal windows are fine — keeping a year of the whole chain is the natural
  configuration.
- A **longer** child window is fine too, and just deletes more.
- Pruning a **leaf** on its own is always fine. `operations` is the bottom of
  the chain, so `RETENTION_OPERATIONS_DAYS=90` alone is valid and is the common
  case of dropping the largest table.
- Pruning a child while keeping its parents forever is valid: deleting a
  transaction never depends on the ledger it belongs to. The retained ledger
  simply becomes a row with no transactions under it.
- `contract_events` and `custom_events` have no foreign key into any prunable
  table, so they can be pruned at any window on their own.

## Which tables are prunable

Only the tables that record **history**. The tables holding current state are
excluded on purpose, and the reasons are in the schema rather than in the
pruning code:

| Table                        | Prunable | Why not                                                    |
| ---------------------------- | -------- | ---------------------------------------------------------- |
| `ledgers`                    | yes      |                                                              |
| `transactions`               | yes      |                                                              |
| `operations`                 | yes      | The fastest-growing table in the schema                     |
| `contract_events`            | yes      |                                                              |
| `custom_events`              | yes      |                                                              |
| `contract_storage_entries`   | **no**   | Archived entries are kept as rows with `state = 'archived'` precisely so a client can tell "archived" from "absent" (no row at all). Pruning them collapses that distinction into "gone", which is the one thing the schema was designed to avoid. |
| `accounts`                   | **no**   | Current state, not a log. Pruning an account row loses the cached balance, flags and thresholds with nothing to rebuild them from. |
| `contract_schemas`           | **no**   | Configuration, not history.                                  |
| `api_keys`, `exports`        | **no**   | Configuration and operator state.                           |
| `account_refresh_queue`      | **no**   | A work queue that drains itself. A retention window would only delete pending work. |
| `retry_queue`                | **no**   | Same.                                                         |

If a table is not in the list, no configuration will make it disappear.

## Chain time, not index time

Cutoffs are compared against each table's chain-time column — `created_at`, and
`closed_at` for `ledgers` — not `indexed_at`.

This matters more than it sounds. An indexer that fell behind for a week and
caught up writes a week of chain history in a single `indexed_at` window. A
policy expressed in "days indexed" would see those rows as brand new and
keep them; worse, a policy that *did* use `indexed_at` would delete a month of
chain history the moment a fast backfill caught up on it. "Keep 30 days" has to
mean 30 days of the chain, or it does not mean what the operator asked for.

## How pruning runs

The prune is a separate loop, not a step inside ledger indexing. Three things
keep it off the indexing path:

1. **Its own timer.** It runs every `RETENTION_PRUNE_INTERVAL_MS`, as a peer of
   the per-network loops. A slow prune cannot delay a ledger write, and a stuck
   prune does not stop indexing.
2. **The prune waits, not the indexer.** Prune statements run on a dedicated
   connection with a 3-second `lock_timeout`. If the indexer holds locks on the
   rows being pruned, the prune gives up and tries again next interval. Without
   that, a large `DELETE` holding `ROW EXCLUSIVE` would make ledger writes
   queue behind it — pruning would become the thing blocking indexing, which is
   the one outcome this feature must not produce.
3. **Bounded work.** Rows go in batches of `RETENTION_PRUNE_BATCH_SIZE`, at most
   20 batches per table per round, so no single transaction grows large enough
   to bloat WAL or hold a long snapshot. A backlog larger than that converges
   over several rounds instead of monopolising the database on the first one.

Tables are pruned children-first, because the foreign keys make the order
mandatory rather than cosmetic: `operations` references `transactions`, which
references `ledgers`, so deleting a parent first fails. Order alone is not
enough, though — a table with no window contributes no delete at all, which is
why [the chain has to be ordered](#the-chain-has-to-be-ordered) is a startup
check and not just a note. A failure is logged and the round is abandoned; the
next interval retries.

## A note on `operations` and partitioning

`operations` is the table worth expiring most, and dropping a partition costs the
same whether it holds a thousand rows or a billion — where the equivalent
`DELETE` costs time and WAL proportional to what it removes. It was range-partitioned
by ledger for exactly that reason, and the partitioning was reverted when
`network` had to be added to the primary key, because a partitioned table's
unique constraints must include the partition key and `(id, network)` cannot
also carry `ledger`. See the note on the table in `db/schema.sql`.

So the prune is a batched `DELETE` against a plain table, and this document does
not claim a partition-drop fast path it does not have. If the partitioning comes
back, the fast path belongs in `pruneTable` and the FK-ordered table list already
puts it in the right place.

## Interaction with backfill

**Pruned ledgers cannot be re-read.** That is the main consequence, and it is
not a bug to work around so much as a fact to plan around.

The indexer resumes from the highest ledger it has indexed, so if retention has
deleted the rows for ledgers 1–1000 the cursor is not rewound to re-read them:
the rows are simply absent, and the API returns nothing for that range. Setting
`RETENTION_OPERATIONS_DAYS=90` means "this deployment serves 90 days of
operation history", not "the other 90 days are still there and lazily
reloaded".

**There is no supported way to backfill a pruned range**, and it is worth being
precise about why. `START_LEDGER` is the only rewind lever, and
`initCursor` in `indexer/src/index.ts` applies it *only* when
`getLatestIndexedLedger()` returns `0` — that is, only when a network has no
indexed ledgers at all:

```ts
loop.cursor = await getLatestIndexedLedger(pool, name);
if (loop.cursor === 0 && START_LEDGER !== undefined) { ... }
```

So once any ledger survives, the cursor is at the newest one and `START_LEDGER`
is ignored. A gap in the middle of the index cannot be filled by configuration.
Recovering a pruned range means emptying the `ledgers` table for that network —
every row, not just the old ones, because the cursor is read as
`MAX(sequence)` and any surviving row keeps it at the newest ledger — then
re-indexing from `START_LEDGER`. That re-reads from Horizon across everything
still retained, so retention has to be disabled first or the re-index is pruned
again as it goes. Treat it as a full re-index of that network, not a repair.

Practically:

- **Retention is a statement about the past.** It narrows what the API can
  answer. Set it once you know how far back you intend to serve.
- **Widening a window does not bring data back.** It only stops the deletion
  from continuing. Plan for a window you can live with rather than a short one
  you expect to widen.
- **A window longer than your current index does nothing.** If you have 40 days
  of data and set a 90-day window, the cutoff is before your oldest ledger and
  nothing is deleted. The window only starts biting once the index outlives it.
- **Enabling retention on a database that is already long indexed does not trim
  the past in one go.** It deletes at most `RETENTION_PRUNE_BATCH_SIZE` × 20 rows
  per table per round, so a multi-year backlog takes several rounds — an hour
  each by default — and the tables keep growing in the meantime. Expect the disk
  to keep climbing for a while after you turn it on.
- **Query results change over time.** A paginated query walking backwards
  through `operations` will eventually run out of rows. Clients that assume an
  index is complete will see gaps, and those gaps grow every day.

If you need unbounded history — a full archival index, or analytics over the
whole chain — leave the windows at `0`. That is the default, and the tables are
built to hold it.

## Verifying it is working

- **Startup log.** The resolved windows are logged with the rest of the config,
  and `retention: 'unlimited'` appears in the `lumina indexer starting` line
  when nothing is configured.
- **Debug endpoint.** `GET /debug/config` reports `retentionWindows`,
  `retentionPruneIntervalMs` and `retentionPruneBatchSize`. This is the
  quickest way to confirm a deployment is pruning what you think it is.
- **Metrics.**

  | Metric                                     | Meaning                |
  | ------------------------------------------ | ---------------------- |
  | `lumina_retention_pruned_rows_total{table}` | Rows deleted, by table |

  A flat counter is the healthy state — a prune with nothing to do is silent. A
  counter that never moves while the database grows is the thing to alert on.
- **Log lines.** `retention prune removed expired data` reports the table, the
  cutoff and how many rows went. A prune that cannot take its locks, or that
  fails, logs `retention prune failed` and retries on the next interval.
