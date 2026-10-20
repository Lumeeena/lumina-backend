# Chaos testing

Every dependency failure the services handle is tested in isolation by a unit
test with a fake client. What happens when Postgres disappears in the middle of
a ledger transaction while Horizon is also throttling had never been exercised,
and that combination is what an outage actually looks like. `test/chaos/` runs
the whole stack, fails its dependencies one at a time and then together, and
requires the services to recover with no help.

- [What runs](#what-runs)
- [The faults](#the-faults)
- [What "recovered" means](#what-recovered-means)
- [Recorded recovery behaviour](#recorded-recovery-behaviour)
- [What it found](#what-it-found)
- [Running it](#running-it)
- [Limitations](#limitations)

## What runs

```
             ┌────────────────────────────── harness ───────────────────────────────┐
             │ fake Horizon ◄──┐   fake Soroban RPC ◄──┐     observer (direct) ──┐  │
             │                 │                       │                         │  │
             │   supervisor ── indexer (dist/) ────────┤                         │  │
             │   supervisor ── graphql-server (dist/) ─┼─► TCP fault proxy ──► Postgres
             └──────────────────────────────────────────────────────────────────────┘
```

- **The services are the build that ships**: each workspace's `dist/`, started
  as its own process, exactly as `docker/Dockerfile.*` runs it.
- **Postgres is real**: the server named by `TEST_DATABASE_URL`, on which each
  scenario creates a database from `db/schema.sql` and drops it afterwards.
  The services reach it through a TCP proxy that can fail; the harness watches
  it directly, so it can see what the services cannot.
- **Horizon and Soroban RPC are stand-ins** (`test/stack/fakeHorizon.ts`,
  `fakeSorobanRpc.ts`) serving a deterministic chain that closes a ledger every
  second, in the shapes the real ones return — the indexer validates every
  response, so a sloppy fake would be rejected rather than tested. Contract
  events carry real ScVal XDR, including an `i128` amount.
- **The restart policy is the deployment's**: `docker-compose.yml` runs every
  service with `restart: unless-stopped`, so `test/stack/supervisor.ts`
  restarts an exited process the way Docker does — 100 ms, doubling per
  consecutive restart to a minute, reset after ten seconds up. Some recovery
  depends on that by design (the indexer exits when it loses its leader lock),
  and anything beyond it would be the manual intervention the test rules out.

## The faults

Faults go in at the wire, not as exceptions inside a mock:

| Scenario | Fault |
| --- | --- |
| `postgres-backends-terminated` | every service backend killed with `pg_terminate_backend`, timed to land inside a ledger transaction — a restart or failover, as the services see it |
| `postgres-down` | every connection reset and the port refusing new ones, inside a ledger transaction, for 15 s |
| `postgres-partition` | connections stay open but nothing moves either way (a network partition), 15 s |
| `horizon-throttled` | every request answered `429` with `Retry-After: 2`, 15 s |
| `horizon-5xx` | every request answered `503`, 15 s |
| `horizon-down` | the port stops listening, 15 s |
| `horizon-hanging` | requests accepted and never answered, 15 s; those already hanging stay hung after the fault clears |
| `soroban-5xx` | every JSON-RPC call answered `503`, 15 s |
| `soroban-down` | the port stops listening, 15 s |
| `soroban-hanging` | calls accepted and never answered, 15 s; those already hanging stay hung |
| `combined-outage` | Postgres down inside a ledger transaction, at the same moment Horizon starts throttling and Soroban RPC starts failing; Postgres returns first, then Soroban, then Horizon |

## What "recovered" means

After the fault clears, within 90 seconds, all of:

- the indexer has every ledger from the first to the chain's tip, **with no
  gap**, and nothing is left in `ledger_retry_queue` or `failed_ledgers`;
- both `/health` endpoints answer 200, and the GraphQL API serves the newest
  ledger;
- a subscriber connected **before** the fault receives again;
- contract events have caught up with the chain;
- neither service holds more Postgres connections than its pool allows.

The harness's only action after injecting a fault is to clear it. A scenario
that recovers only because a process was restarted passes — that is what the
restart policy is for — and the restart is recorded with the reason the process
gave.

## Recorded recovery behaviour

A run on 2026-10-20 (PostgreSQL 16, Node 24). Times are from the fault clearing
to every condition above holding; "API up" is the share of GraphQL probes
answered with data while the fault held.

| scenario | mid-tx | recovered | recovery | API up during fault | indexer unhealthy after | ledgers during fault | restarts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `postgres-backends-terminated` | yes | yes | 1.1 s | 100% | — | 0 | indexer (exit 1): leader lock lost; stopping so no second writer runs: terminating connection due to administrator command |
| `postgres-down` | yes | yes | 15.9 s | 0% | 0.0 s | 0 | indexer (exit 1): leader lock lost; stopping so no second writer runs: Connection terminated unexpectedly |
| `postgres-partition` | yes | yes | 3.0 s | 0% | 5.0 s | 1 | none |
| `horizon-throttled` | — | yes | 2.0 s | 100% | — | 1 | none |
| `horizon-5xx` | — | yes | 1.5 s | 100% | 1.6 s | 0 | none |
| `horizon-down` | — | yes | 2.1 s | 100% | 1.6 s | 0 | none |
| `horizon-hanging` | — | yes | 3.5 s | 100% | 10.3 s | 0 | none |
| `soroban-5xx` | — | yes | 1.1 s | 100% | — | 15 | none |
| `soroban-down` | — | yes | 0.5 s | 100% | — | 15 | none |
| `soroban-hanging` | — | yes | 7.0 s | 100% | — | 0 | none |
| `combined-outage` | yes | yes | 12.3 s | 0% | 0.5 s | 0 | indexer (exit 1): leader lock lost; stopping so no second writer runs: Connection terminated unexpectedly |

What the numbers mean, per dependency:

**Postgres.** The indexer holds its single-writer lock on a dedicated
connection, so any fault that kills connections kills the lock, and the indexer
exits by design (`leader lock lost; stopping so no second writer runs`). The
restarted process waits as a standby, retrying the lock every
`INDEXER_LEADER_RETRY_MS` (5 s), and resumes from the database's cursor once
Postgres is back: the ledger that was mid-transaction rolled back and is simply
indexed again, so no ledger is lost and none is doubled. The GraphQL server
stays up throughout — requests fail while the database is unreachable and
succeed as soon as it returns — but its LISTEN connection reconnects on an
exponential backoff capped at 30 s, so **subscriptions can stay silent for up
to 30 s after Postgres is back**; in `postgres-down` that backoff, not the
indexer, set the recovery time. A partition is different: nothing errors,
everything waits (there is no statement timeout and `DB_POOL_CONNECTION_TIMEOUT`
defaults to wait forever), and work resumes the moment traffic does.

**Horizon.** A `429` is retried after its `Retry-After`; a `5xx` or a refused
connection marks the endpoint unavailable, and once every configured endpoint
is, the loop pauses (`horizonPaused` in `/health`) instead of recording ledgers
as failed. A hanging request is cut off by `HORIZON_REQUEST_TIMEOUT_MS`. In all
four the API keeps serving what is indexed, and indexing resumes within a few
seconds of Horizon answering again.

**Soroban RPC.** An error or a refused call fails that cycle's event poll, which
is logged and retried next cycle; ledger indexing carries on (15 ledgers were
indexed during the 15 s fault). A hanging call is bounded by
`SOROBAN_REQUEST_TIMEOUT_MS` (10 s). Event polling shares the indexer's loop
with ledger indexing, so while RPC hangs every cycle waits out its timeouts and
ledger indexing slows to one catch-up per cycle — no ledger is lost, and it
catches up as soon as RPC answers.

## What it found

The first runs failed, and each failure was a defect in shipped code. All are
fixed in the same change as this suite, with a unit test each:

- **The GraphQL server exited on the first dropped idle connection.** Its pool
  had no `error` listener — #159 added one and #163 lost it when it rewrote the
  pool construction — so a Postgres restart took the server down and every
  subscription with it. `handlePoolErrors` (`graphql-server/src/db.ts`) restores
  it for both pools.
- **The indexer exited when a connection died inside a ledger transaction.**
  pg-pool removes its own error listener from a client while it is checked out,
  so the client raised an unhandled `error`. `createPool` now gives every client
  a listener; the statement in flight still rejects, the ledger rolls back and
  goes to the retry path, and `release()` discards the dead client.
- **A hanging Soroban RPC stopped ledger indexing for five minutes.** RPC calls
  had no timeout, so a call to a node that never answered held the indexer's
  loop until Node's own fetch timeout (300 s): `soroban-hanging` measured the
  indexer stuck at ledger 1002 with the chain at 1107 for 90 s after the fault
  cleared, while `/health` still said 200. Calls are now bounded by
  `SOROBAN_REQUEST_TIMEOUT_MS`.
- **One `i128` contract event stopped event indexing for good.** The generic
  event insert serialised the decoded value with plain `JSON.stringify`, which
  throws on a `bigint`; the cursor never moved past the event, so every later
  poll failed on it too. Token transfers carry an `i128`. Values are now stored
  as decimal text, as contract storage values already were.

Before any fault was injected, starting the stack also showed that neither
service could run on `main` at all — the indexer failed every ledger on a
prepared-statement name clash, and the GraphQL server crashed at boot on a
resolver with no schema field. Those are fixed separately; see the commit that
restores `main`.

## Running it

```bash
npm run build
TEST_DATABASE_URL=postgresql://lumina:lumina@localhost:5432/lumina npm run test:chaos
CHAOS_SCENARIOS=postgres-down,combined-outage npm run test:chaos   # a subset
```

`TEST_DATABASE_URL` needs a role that can create databases and terminate
backends (the CI service's superuser). `CHAOS_HOLD_MS` changes how long a fault
is held, `CHAOS_RECOVERY_TIMEOUT_MS` the recovery deadline. Each run writes
`test/.artifacts/chaos/report.{json,md}` and each scenario's service logs to
`test/.artifacts/chaos/<scenario>/`; CI uploads them as the `chaos-report`
artifact. A new scenario is an entry in `test/chaos/scenarios.ts`: an `inject`,
a `clear`, and how long to hold.

## Limitations

- **Postgres faults are network-level.** The proxy resets or stalls
  connections, and `pg_terminate_backend` kills sessions, but the Postgres
  server itself never crashes or restarts, so crash recovery inside Postgres
  (WAL replay, a failover to a replica with lag) is outside the suite.
- **Horizon and Soroban RPC are fakes.** They fail the way the real services
  do on the wire, but a real Horizon's partial failures — one slow endpoint, a
  stale replica — are not modelled. Multi-endpoint Horizon failover is
  configured but every scenario uses one endpoint.
- **Time is compressed.** A ledger closes every second rather than every five
  and the indexer polls every 500 ms, so recovery times are shorter than a
  deployment's by about the same factor; their order and causes carry over,
  their absolute values do not.
- **One network, one replica.** Multi-network loops and a standby replica taking
  over the leader lock are not exercised.
