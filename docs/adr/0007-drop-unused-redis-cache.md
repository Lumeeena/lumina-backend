# ADR 0007: Drop the unused Redis cache module and dependency

- **Status:** Accepted
- **Date:** 2026-11-19
- **Issue:** #379
- **Sources:** `graphql-server/src/latestLedgerCache.ts`, `graphql-server/src/index.ts`, `docs/adr/0001-realtime-subscriptions-over-listen-notify.md`

## Context

Issue #233 introduced `graphql-server/src/cache.ts` and added `redis` (`^4.7.1`) to `graphql-server/package.json` to cache `latestLedger`, `networkStats`, and order book snapshots. Nothing in the repository ever imported `cache.ts`.

Meanwhile:
- `latestLedger` already has a dedicated, zero-hop in-process cache (`latestLedgerCache.ts`) invalidated immediately on every `lumina_indexed` PostgreSQL `LISTEN/NOTIFY` event (`index.ts`), plus per-request query memoization (`requestMemo.ts`).
- `networkStats` and `activityRollups` read pre-aggregated hourly/daily rows from `activity_rollups` (bounded primary-key range scans, sub-millisecond in PostgreSQL).
- Leaving an unreferenced module and an unused `redis` client dependency in `graphql-server/package.json` enlarges the supply-chain attack surface and creates maintenance burden without providing any production benefit.

## Options considered

1. **Wire Redis in behind an optional `REDIS_URL`.**
   - Adds another stateful service to operate, monitor, secure, and keep consistent across invalidations (matching the same reason ADR 0001 rejected Redis Pub/Sub in favor of Postgres `LISTEN/NOTIFY`).
   - Duplicates `latestLedgerCache.ts` with a slower network round-trip and adds cache-stampede / serialization failure modes on top of queries that are already cheap indexed reads or pre-computed rollups.
2. **Delete `graphql-server/src/cache.ts` and remove `redis` from `graphql-server/package.json`.**
   - Keeps the runtime architecture strictly PostgreSQL-only (consistent with ADR 0001).
   - Relies on `latestLedgerCache.ts` (LISTEN/NOTIFY-invalidated) and `activity_rollups` (pre-aggregated buckets) for hot reads, plus optional PostgreSQL read replicas (`READ_DATABASE_URL`) when read scaling is needed.

## Decision

Delete `graphql-server/src/cache.ts` and drop the `redis` production dependency from `graphql-server/package.json`.

## Consequences

- Zero new operational dependencies: the GraphQL server continues to depend only on PostgreSQL.
- Reduced dependency and audit footprint (`redis` and its transitive packages are no longer shipped).
- If future load-test telemetry identifies a cross-replica hot query that PostgreSQL read replicas and pre-aggregated rollups cannot satisfy, a targeted cache can be introduced with benchmark numbers justifying its operational cost.
