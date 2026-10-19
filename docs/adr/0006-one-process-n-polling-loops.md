# 0006. One process, N independent polling loops, one database

- **Status:** accepted
- **Date:** 2026-10-19
- **Sources:** `indexer/src/index.ts`, `indexer/src/networks.ts`,
  `graphql-server/src/networks.ts`, `db/migrations/007_networks.sql`,
  `docs/MULTI_NETWORK.md`.

## Context

The deployed indexer tracked mainnet using a single Horizon URL. The only
production Lumina Registry contract was deployed on testnet. Contract-event
indexing required its own independent cursor specifically because of this
mismatch — `pollContractEvents` in `indexer/src/index.ts` already tracked a
separate ledger cursor. That independent cursor was a local fix for a global
problem: the system assumed one network per deployment at every layer —
primary key, resolver, subscription filter, config variable — so adding even
a second network required touching all of them.

The goal: one deployment indexes and serves mainnet, testnet and futurenet
simultaneously, with complete data isolation between them.

## Options considered

**A separate database per network.** Operationally the simplest isolation —
nothing from one chain can ever touch another's tables — but it duplicates
migrations, roles, runbooks and the monitoring stack once per chain. A
network-tagged column solves the isolation problem without those costs, and an
operator who wants physical separation can still run two stacks.

**A separate process per network.** One indexer instance per chain, each with
its own flat config and its own database. This preserves the existing
single-network code path exactly, but it means N process managers, N sets of
env vars, N health endpoints, N sets of alert rules, and N log streams to
correlate when diagnosing a cross-network issue. It also does not fix the
Registry mismatch — that still requires bridging two separate deployments.

**A shared process with a central coordinator.** One process spawning worker
threads or child processes, one per network. Adds complexity (IPC, shared
pool, thread safety) without adding isolation beyond what a per-network
column already provides. The loops are I/O-bound and run at Stellar's ~5 s
ledger cadence — there is no CPU parallelism worth buying with the overhead.

**A network column with a single shared polling loop.** One loop, one cursor,
multiplexing across networks in sequence. Rejected: a slow or unreachable
Horizon for one network would stall every other, the very coupling this change
exists to remove.

## Decision

One process runs N independent polling loops, one per declared network. Each
loop owns its own cursor, its own tip state, its own account cache, its own
discovered contract ids, and its own throttle budget. A slow or unreachable
Horizon for one network stalls only that loop.

The indexer's data isolation mechanism is a `network` column on every indexed
table with composite primary and foreign keys — see ADR 0004 for the key
design. The env-var scheme follows the pattern already established by every
multi-tenant config layer in the project: a `NETWORKS` list declares names,
and per-network variables are prefixed by the uppercased name. Flat variables
(`HORIZON_URL`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`) continue to work for
single-network deployments — a deployment that sets none of the new variables
behaves exactly as before.

The GraphQL server maps `network` arguments to the column predicate used by
every resolver. The default (omitted `network` argument) is the configured
primary network, which is what every existing client was already getting —
adding the argument is not a breaking change. A name this deployment does not
serve is a `BAD_USER_INPUT` error rather than a silent fall back to the
primary; that is the mixing this feature exists to prevent.

Subscriptions inherit the filter: a notification for network A is dropped on a
subscriber watching network B before any rows are read.

The registry is per-network: each network polls its own Registry deployment,
reads are signed against that network's passphrase, and discovered contract
ids accumulate in that network's loop only.

## Consequences

**The failure mode at startup is loud.** A network declared in `NETWORKS` but
missing its `HORIZON_URL`, or a `<NAME>_HORIZON_URL` set while `NETWORKS` is
not, throws `NetworkConfigError` before the first row is written. A
half-configured network that reached indexing would silently write mislabelled
data; an error that prevents startup is the correct tradeoff.

**Network names are a fixed enum.** `mainnet`, `testnet` and `futurenet` are
the only valid names, because the GraphQL schema exposes them as a `Network`
enum. A client that names a network must be able to name it; that requires the
enum to exist in the schema before the deployment can serve it. Adding a
fourth network is a schema change, not a config change.

**The start-up cost of a second network is low.** Adding `NETWORKS=mainnet,testnet`
plus `TESTNET_HORIZON_URL` to an existing mainnet deployment is a config
change and a process restart. Migration 007 adds the `network` column and
rebuilds the keys; on a mainnet-only deployment, the `DEFAULT 'mainnet'`
column value labels every existing row correctly with no rewrite.

**Existing single-network clients break in one way: they must not have relied
on the absence of the `network` argument to get mainnet silently.** They did
not — the primary defaults to `mainnet` — so no existing client is broken.

**Per-network DataLoaders are required.** A DataLoader batch is keyed by a
column whose meaning depends on the network; batching across networks would
produce wrong rows. Each network resolves through its own DataLoader instance,
which is created per request alongside the network resolution.
