# Soak testing

Tests run for seconds; the services run for weeks. The bug class that gap
hides has been found here once already: the GraphQL server leaked one Postgres
connection every time its LISTEN connection reconnected (#14). No short test
could see it, and a deployment would have run out of `max_connections` after
days of ordinary reconnects. `test/soak/` runs the whole stack under sustained
load for an extended period and fails when a resource keeps climbing — by its
trend, long before it crashes anything.

- [What it runs](#what-it-runs)
- [What it watches](#what-it-watches)
- [How a leak is decided](#how-a-leak-is-decided)
- [Proof that it catches one](#proof-that-it-catches-one)
- [Running it](#running-it)
- [A recorded run](#a-recorded-run)
- [Limitations](#limitations)

## What it runs

The same stack as the chaos tests (`test/stack/`, see
[CHAOS_TESTING.md](CHAOS_TESTING.md#what-runs)): both services built and run as
separate processes under the deployment's restart policy, a real Postgres, and
stand-ins for Horizon and Soroban RPC. For the whole run:

- **Writes**: the chain closes a ledger every second with 20 transactions of
  five operations each — 100 operations a second, about 8.6 million a day,
  every one through the indexer's real write path.
- **Reads**: 20 GraphQL queries a second, rotating through the listings, keyset
  pages, account and transaction lookups, nested resolvers and filters clients
  use.
- **Subscriptions**: three long-lived subscribers, and one more opened and
  closed every six seconds.
- **Reconnects**: every five minutes every pool connection and the LISTEN
  connection are killed in Postgres, so the reconnect paths — where #14's leak
  lived — run a dozen times an hour. The leader-lock connection is spared:
  losing it restarts the indexer by design, and a restart would reset the very
  memory being watched.

## What it watches

Every 10 seconds, per service:

| Series | Source | Why |
| --- | --- | --- |
| `rss` | `process_resident_memory_bytes` | everything the process holds, Buffers included |
| `heap` | `nodejs_heap_size_used_bytes` | retained JavaScript objects |
| `handles` | `nodejs_active_handles_total` | sockets, servers, timers that keep the process alive |
| `fds` | `process_open_fds` | file descriptors, which run out before memory does |
| `pgConnections` | `pg_stat_activity`, by `application_name` | connections as Postgres sees them — a leaked one is exactly the one the service has stopped counting |

The first four are the prom-client defaults both services already export on
`/metrics`, so the soak reads what an operator's Prometheus would.

## How a leak is decided

A rising number is not a leak. A heap saws up and down with every collection, a
pool grows to its ceiling under load, a cache fills to its bound — and a check
comparing the last sample with the first would fail on every one of them. So
`test/soak/trend.ts`:

1. drops the warm-up (the first 15% of the run, at least five minutes), where
   start-up growth that will stop lives;
2. cuts the rest into eight equal-time windows and reduces each to one number —
   its **minimum** for memory, the floor the collector cannot get below, and
   its **median** for counts;
3. calls the series rising only if all three hold:
   - **significant** — a one-sided Mann–Kendall test on the windows, p < 0.05;
   - **material** — the Theil–Sen estimate of the rise across the run exceeds
     the series' threshold (below);
   - **sustained** — the second half of the run still rises by at least half
     the threshold, so growth that stopped part-way is not reported.

| Series | Window value | Must rise by more than |
| --- | --- | --- |
| `rss` | minimum | 16 MB and 10% of its starting level |
| `heap` | minimum | 8 MB and 10% |
| `handles`, `fds` | median | 5 and 20% |
| `pgConnections` | median | 2 |

A service that exits, stops answering `/metrics`, fails more than 2% of
requests, or leaves a gap in the indexed ledgers also fails the run.

## Proof that it catches one

`npm run test:soak:detector` runs in CI on every pull request:

- `trend.test.ts` puts known series through the detector: a flat noisy value, a
  heap sawing 60 MB around a flat floor, a cache filling to its bound, a pool
  reaching its ceiling, warm-up growth and a falling value all pass; a
  sawtooth whose floor rises 30 MB an hour under a 60 MB swing, and one
  connection leaked per reconnect, fail.
- `detectsLeak.test.ts` runs the real sampler and detector for a minute against
  two copies of a small service (`fixtures/leakyService.ts`) doing the same
  work — allocating, opening sockets, reconnecting to Postgres — one of which
  keeps a slice of what it allocates and never closes its old sockets or
  connections. The leaking copy is flagged on all five series while it is
  still running, and the healthy copy on none.

## Running it

```bash
npm run build
TEST_DATABASE_URL=postgresql://lumina:lumina@localhost:5432/lumina \
  SOAK_DURATION_MS=3600000 npm run test:soak
```

It runs unattended: one command, bounded by `SOAK_DURATION_MS`, exit status 0
or 1, and a report in `SOAK_OUTPUT_DIR` (default `test/.artifacts/soak/`):
`report.md` (the table below), `report.json` (every verdict and its numbers),
`samples.csv` (every sample, for plotting), and both services' logs.
`.github/workflows/soak.yml` runs an hour every Monday and on demand with a
duration of your choosing, and uploads the report as the `soak-report`
artifact.

| Variable | Default | |
| --- | --- | --- |
| `SOAK_DURATION_MS` | 1 hour | |
| `SOAK_SAMPLE_INTERVAL_MS` | 10 s | |
| `SOAK_WARMUP_MS` | 15% of the run, at least 5 min | excluded from the trend |
| `SOAK_WINDOWS` | 8 | |
| `SOAK_QUERIES_PER_SECOND` | 20 | |
| `SOAK_RECONNECT_EVERY_MS` | 5 min | `0` disables the reconnect storms |
| `SOAK_TRANSACTIONS_PER_LEDGER` | 20 | five operations each, a ledger a second |
| `SOAK_MAX_ERROR_RATE` | 0.02 | |

## A recorded run

One hour at the defaults on 2026-10-20 (PostgreSQL 16, Node 24, one machine
running Postgres, both services and the load). It passed.

| | |
| --- | --- |
| requests | 60,983, of which 0.01% failed |
| latency | p50 27 ms, p95 206 ms, p99 459 ms |
| subscriptions | 3 long-lived (no disconnects), 600 opened and closed |
| reconnect storms | 11 |
| ledgers indexed | 3,608, no gap |
| process exits | none |

| Series | First | Last | Verdict | Why |
| --- | --- | --- | --- | --- |
| `indexer.rss` | 145.8 MB | 189.8 MB | stable | no significant trend (p = 0.19) |
| `indexer.heap` | 41.0 MB | 36.8 MB | stable | trend of 1.4 MB, below the 8 MB threshold |
| `indexer.handles` | 8 | 7 | stable | no significant trend (p = 1.0) |
| `indexer.fds` | 30 | 28 | stable | no significant trend (p = 1.0) |
| `indexer.pgConnections` | 4 | 3 | stable | no significant trend (p = 1.0) |
| `graphql.rss` | 162.8 MB | 243.6 MB | stable | no significant trend (p = 0.50) |
| `graphql.heap` | 55.6 MB | 91.1 MB | stable | no significant trend (p = 0.45) |
| `graphql.handles` | 13 | 20 | stable | no significant trend (p = 0.068) |
| `graphql.fds` | 32 | 40 | stable | no significant trend (p = 0.068) |
| `graphql.pgConnections` | 2 | 10 | stable | rose to the pool's ceiling (`DB_POOL_MAX`, 10) and levelled off |

"First" and "last" are single samples, which is why they are not the verdict:
the GraphQL server's RSS ends 80 MB above where it starts, but its floor did
not move after warm-up. Its handle and descriptor counts are the closest call
in the run — a trend that is suggestive but not significant — and the series
to watch in the scheduled runs: a real leak there gets more significant with
every hour it runs, where noise does not.

## Limitations

- **An hour finds leaks that move in an hour.** The thresholds are absolute: a
  leak of a few megabytes a day passes an hour's run. Longer runs (the workflow
  takes up to five hours) lower the rate that can hide.
- **The load is synthetic.** The chain and the query mix are fixed; a leak that
  needs a particular operation type, query or client behaviour to trigger is
  only found if the load exercises it.
- **Postgres is not soaked.** The run watches the services' use of Postgres,
  not Postgres's own memory, bloat or autovacuum over time.
