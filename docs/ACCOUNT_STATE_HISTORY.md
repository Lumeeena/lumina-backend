# Account state at a past ledger

`account(address:, asOfLedger:)` answers "what did this account look like at
ledger N". This page records the approach, what it can and cannot tell you, and
how far back it reaches. The implementation is in `indexer/src/db.ts`
(`insertAccountStateHistory`), `graphql-server/src/db.ts`
(`getAccountAsOfLedgerFromDb`) and `graphql-server/src/accountHistory.ts`.

## The approach: stored snapshots, not replay

[BALANCE_HISTORY_DECISION.md](BALANCE_HISTORY_DECISION.md) chose operation replay
for the portfolio view's balance chart. That was a reasonable choice for a
chart at 30-day resolution. It does not give an exact answer here, for two
reasons:

- Replay reconstructs balances from payment-type operations. An account's
  balance also moves through transaction fees, offer fills and liabilities,
  sponsorship, and claimable balances, and the replay code does not model all of
  them. A replayed balance is an estimate, and this endpoint is meant to return
  the recorded state.
- Replaying from the start of an account's history costs time proportional to its
  activity, which is the cost the decision doc already flags for busy accounts.

So this feature stores a copy of the account each time the indexer writes it.
The copy is what Horizon reported for that account, so it is exact as of its own
ledger. Nothing is reconstructed.

## What is stored, and when

The indexer writes one `account_state_history` row each time it stores an account
row (`completeAccountRefreshes` in `indexer/src/db.ts`). The row is keyed by
`(address, network, last_modified_ledger)`, which is the ledger Horizon reports
as that state's last modification. The same state seen twice is stored once.

The write sits inside the same transaction as the `accounts` upsert, so a
rollback removes both.

An account is queued for a refresh when a ledger touches it. The refresh is
skipped when the account was fetched within `ACCOUNT_CACHE_TTL_MS` (default
5 minutes) by the in-memory cache. So an account that is busy across many ledgers is
refreshed, and therefore recorded, at most once per cache window.

## Resolution: what an answer means

`asOfLedger: N` returns the stored copy with the largest `last_modified_ledger`
that is `<= N`. The response's `lastModifiedLedger` field says which copy it is.

The answer is **exact** when no change to the account happened between that copy
and N. The indexer cannot always tell that apart from a change it did not see.
Two cases produce a gap:

1. **Several changes between two refreshes.** If an account changed at ledgers
   10, 20 and 30, and the indexer refreshed it at ledger 30, only the state at 30
   is stored. A query for 20 returns the copy from before 10, or `null`. It does
   not return the state at 20, because that state was never observed.
2. **The cache skipped a refresh.** An account touched at ledger 40 inside the
   cache window is not refreshed. A query for 45 returns the copy from before
   40.

In practice the copy from before a gap is the best available answer, but it is
not guaranteed to match the account at N. `lastModifiedLedger` is there so a
caller can see the distance between the copy and the question.

The answer is therefore a lower bound on the account's history: every state
returned was really observed, but not every state the account passed through is
present.

## Coverage: where the history starts

- **Nothing before deployment.** Accounts have no history until they are
  refreshed after the table exists. An account that did not change after
  deployment has no row, and `asOfLedger` returns `null` for it. `null` here
  means "no stored state", not "the account did not exist".
- **No backfill.** Historical copies cannot be rebuilt from Horizon, because
  Horizon returns only current state. Reconstructing them would need operation
  replay, which is the approach this document set aside.
- **Per network.** Copies are kept per network, as for the rest of the schema.

## Window: how far back it reaches

Copies are pruned by the retention job, on `recorded_at` (the wall-clock time the
copy was stored), not on chain time. That is the one exception to the rule in
[RETENTION.md](RETENTION.md), and it is deliberate: a copy stores a ledger
number, not a timestamp, so there is no chain time to prune on.

| Setting                                  | Effect                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `RETENTION_ACCOUNT_STATE_HISTORY_DAYS=0` | Default. Keep every copy. The table grows with every refresh.           |
| `RETENTION_ACCOUNT_STATE_HISTORY_DAYS=N` | Drop copies stored more than N days ago. `asOfLedger` can then answer only for the copies that remain. |

Because the window is measured in stored time, a copy of a quiet account can be
pruned while it is still the state at a recent ledger. If the copy is the only
one, a query returns `null` after pruning. Choose a window longer than the
longest period you expect a quiet account to go unrefreshed.

**Current state of the retention job.** As of this change, the prune loop
(`runRetentionLoop` in `indexer/src/index.ts`) is defined but is not started
from `run()`, and the `lumina_indexer` role has no `DELETE` grant on the tables
it prunes. Until both are addressed, configured windows do not remove rows
(including these). Storage is therefore unbounded in practice, whatever
`RETENTION_ACCOUNT_STATE_HISTORY_DAYS` says. Tracked separately from this feature.

## The query

```graphql
query {
  account(address: "GA…", network: MAINNET, asOfLedger: 52000000) {
    lastModifiedLedger
    balances { assetType assetCode balance }
  }
}
```

- `asOfLedger` must be a positive integer, or the query fails with a message
  naming the value.
- With `asOfLedger`, the Horizon fallback is **off**. Horizon knows only the
  current state, so falling back would answer a historical question with today's
  balances.
- `null` means no stored copy exists at or before that ledger.

Not covered: the `accounts` listing and the other account-related queries. They
always answer with current state.

## Storage

One row per refresh. A row holds the account's balances, flags and thresholds as
JSONB, so its size grows with the number of assets the account holds. Estimate
the growth from the refresh rate, not from the number of accounts: a busy account
written every ledger produces one row per ledger it is refreshed in.

## Limits, in one place

- Changes between two refreshes are not visible. Answers are lower bounds on the
  account's history.
- There is no history before the table was deployed, and none is rebuilt.
- The window is set by stored time, not chain time.
- The `accounts` listing and the other queries do not take `asOfLedger`.
