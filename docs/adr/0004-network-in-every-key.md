# 0004. Every indexed row is scoped to a network, in the key

- **Status:** accepted
- **Date:** 2026-09-27
- **Sources:** the header comment of `db/migrations/007_networks.sql`,
  `docs/MULTI_NETWORK.md`, the docblocks in `graphql-server/src/subscriptions.ts`
  and `graphql-server/src/resolvers.ts`, and commit `7cff6f9`.

## Context

One deployment serves more than one Stellar network. Ledger sequences,
transaction hashes, operation ids, contract ids and even account addresses
repeat across chains: mainnet ledger 42 and testnet ledger 42 are different
rows, and the same `G…` account exists on both. A single-column key would
either reject the second network outright or, with `ON CONFLICT DO UPDATE`,
silently overwrite one network's row with the other's.

## Options considered

**A separate database per network.** Recorded as not covered, deliberately: one
schema separated by a column, since a deployment that wants isolation can still
run two stacks. Splitting the data would have duplicated migrations, roles and
operations to solve a problem one column solves.

**Adding `network` as a filter column but keeping single-column keys.** Rejected
in the migration header: the key has to carry the network, not just the column
queries filter on, or the second network's row collides with the first's. It is
the *key* that prevents the data mixing, not the predicate.

**Per-network registry discovery.** Not covered: one Registry, one chain, with
discovery running on the primary network.

**Network names outside a fixed set.** Not covered: the names are a static enum
in the GraphQL schema, because the set of networks an API serves is a contract,
not a runtime string. A private or future network is a schema change first.

## Decision

A `network` column on every indexed table, and composite keys and foreign keys
over it. Foreign keys follow their parents — `transactions(ledger)` only means
anything when it points at the ledger *of the same network*, so both sides of
the FK are `(…, network)`.

Everything downstream is scoped the same way: one polling loop per network in
the indexer, each owning its own cursors, tip, account cache and discovered
contract ids; per-network DataLoader batches, because a batch is keyed by a
column whose meaning depends on the network; and notifications dropped unless
they carry the subscribed network *and* rows read with that network in the
predicate — the first keeps the stream honest, the second keeps the rows honest.

## Consequences

**Existing rows are relabelled, not migrated.** The column defaults to
`mainnet`, which is what the flat-variable fallback names its single network, so
an existing mainnet deployment keeps serving the same rows with no configuration
change; a deployment indexing another chain relabels with one `UPDATE` per
table.

**Adding the column is cheap; changing the keys is not.** Dropping and re-adding
a primary key drops and re-creates its index, briefly making the table's unique
index unavailable — the same shape of operation as any index build, and the
migration says to run it while the indexer is stopped.

**No new indexes were needed.** Every existing index still covers its leading
column, so filtering by network is a filter on an indexed prefix.

**A misconfigured network fails at startup rather than later.** A network that
is half-configured never gets as far as indexing: the failure mode after
startup would be data correctness — the wrong chain's rows in a table keyed by
hash — not availability, so it is not left to be discovered later. A network
this deployment does not serve is a `BAD_USER_INPUT` error rather than a silent
fall back to the primary, a bug that was found and fixed rather than designed
around: a testnet query whose row had not been indexed yet fell through to
mainnet Horizon and came back with mainnet data under a testnet label.
