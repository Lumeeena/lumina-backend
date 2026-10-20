# Changelog

All notable changes to Lumina Backend are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning Policy

**Public API:** The GraphQL schema is the public interface. Changes to the schema follow semantic versioning:

- **Major (X.0.0):** Breaking changes to the schema (removed fields, renamed types, changed return types)
- **Minor (0.X.0):** New fields, new queries, new subscriptions (backward compatible)
- **Patch (0.0.X):** Bug fixes, performance improvements, internal changes (no schema changes)

Schema additions are backward compatible and do not require a major version bump — clients ignoring unknown fields continue to work.

Breaking changes are rare and advance the major version. Deprecation notices appear in the schema documentation for at least one minor release before removal.

## [Unreleased]

### Added
- `account(address:, asOfLedger:)`: the account as the indexer last recorded it at or before a ledger. Served from stored snapshots, with no Horizon fallback, and bounded by `RETENTION_ACCOUNT_STATE_HISTORY_DAYS`. Answers are lower bounds on the account's history, because changes between two refreshes are not visible. See `docs/ACCOUNT_STATE_HISTORY.md` (#238)
- Single-writer guard for the indexer: a Postgres advisory lock held on a dedicated connection, so a second replica waits as a standby and takes over when the leader exits or crashes. A lost lock stops the process with status 1. `INDEXER_LEADER_LOCK=false` disables it. See `docs/INDEXER_CONTROL_FLOW.md` section 5 (#239)
- Boundary validation for Horizon responses in the indexer: a missing or mistyped field fails with an error naming it, and the raw response is kept on the error and in a `warn` log line, truncated to 4 KB. A malformed account throws rather than reading as not found (#244)
- `docs/LOG_SHIPPING.md` and a Fluent Bit template in `docker/observability/log-shipping/`: ship the existing stdout JSON to an aggregator with no application change, with the fields to index and the pino level mapping (#249)
- `accounts(network, orderBy, limit, cursor)` query: the indexed accounts the indexer has seen, paginated and ordered `RECENT_ACTIVITY` (last-modified ledger first) or `ADDRESS`. An address the indexer has never seen is absent by design, and that caveat is stated in the schema rather than left to be discovered (#48)
- `ledgers(network, limit, cursor)` query: indexed ledgers newest first, paginated on the sequence, for the ledger-throughput-over-time series that `ledger(sequence:)` and `latestLedger` could not answer. Rows are mapped exactly as `ledger(sequence:)` returns them, so a chart and a detail page cannot disagree (#47)
- Incremental bulk export: `since_ledger` parameter on bulk exports with max exported ledger checkpoint tracking for downstream syncs (#94)
- `network` argument on every query and subscription (`Network` enum: `MAINNET`, `TESTNET`, `FUTURENET`). Omitted means the configured primary, so existing clients are unaffected; naming a network the deployment does not serve is a `BAD_USER_INPUT` error rather than a silent fallback. Nested fields inherit their parent's network, and subscriptions filter notifications before reading rows (#60)
- `indexerStatus(network)` query: Horizon's tip, the indexed tip, the lag and a `stale` label for one network. An unreachable database or Horizon answers with `null` fields and `stale: true` instead of failing, because the interesting moment for this query is exactly when something is wrong (#53)
- Automatic persisted queries, configurable with `PERSISTED_QUERIES` and `PERSISTED_QUERIES_TTL_SECONDS` (default: on, seven days). A value that cannot be understood fails at startup, and switching it off makes the server answer `PERSISTED_QUERY_NOT_SUPPORTED` so clients fall back to full documents. This is a cache, not a safelist (#54)
- Multi-network configuration: `NETWORKS` plus `<NAME>_HORIZON_URL`, `<NAME>_SOROBAN_RPC_URL`, `<NAME>_NETWORK_PASSPHRASE` and `PRIMARY_NETWORK`, shared by both services. Flat variables keep working unchanged for a single network, and a half-configured or unknown network fails at startup with `NetworkConfigError` rather than indexing the wrong chain (#58)
- The indexer runs one polling loop per declared network, each with its own cursors, account cache and network-stamped rows; `lumina_latest_indexed_ledger`, `lumina_latest_horizon_ledger`, `lumina_indexing_lag_ledgers` and `lumina_last_successful_index_timestamp_seconds` carry a `network` label, and `/health` reports a per-network breakdown alongside flat numbers taken from the worst-off network (#58)
- `register-schema --network <name>`, for schemas registered against one chain (#58)
- API key authentication middleware: a key in the `x-api-key` header is resolved to a caller identity and attached to the GraphQL context. Anonymous access stays the default and is controlled by `ALLOW_ANONYMOUS_ACCESS`. Rejections are answered with 401 before a query is parsed, the key is never logged or echoed, and the stored hash is compared in constant time
- Resolver integration tests against real database (#122)
- Consumer-facing GraphQL API documentation (#121)
- Versioning policy and release workflow (#118)
- Strict TypeScript compiler options (#117)

### Changed
- Dropped the four secondary indexes on `trustlines` (`015_drop_unused_trustline_indexes`). No query reads them, and two of them made every balance update non-HOT. Replaying 50,877 mainnet operations through the indexer: HOT updates 0% → 96.8%, WAL −50%, index size −66%. Measurements and growth analysis in `docs/TRUSTLINES_INDEX_REVIEW.md`; `npm run audit:trustlines` and `db/audit/trustlines.sql` re-run it
- Reviewed the `ledgers` indexes against a 2.5M-row deployment-shaped database. The primary key serves every API read; `idx_ledgers_closed_at` is kept for the retention prune despite zero API scans. `getIndexedTip` now reads the tip row instead of computing `MAX(sequence), MAX(indexed_at)` in a full table scan (734 ms → 0.1 ms at 2.5M rows), and a network-first index that fixes lagging multi-network listings was measured and rejected on write cost. Measurements and growth in `docs/LEDGERS_INDEX_REVIEW.md`; `db/audit/ledgers.sql` collects the same numbers from a deployment
- Every query, argument, type field and enum value now carries a description, so the playground explains what each one is for rather than repeating its type: why `account(address:)` can answer for an address the index has never seen, which fields are null for which operation type, which queries fall back to Horizon and which read only the index, and where a page resumes. A schema test fails the build if a description goes missing, since a bare name in the docs is a defect a type change would not surface (#50)
- One cursor contract for every paginated query (`transactions`, `operations`, `search`, `events`, `customEvents`, `ledgers`, `accounts`): a cursor carries the sort key of the last row on its page plus the query that issued it, and an invalid cursor is an `INVALID_CURSOR` error everywhere instead of a silent empty page on some queries. Reaching the end of the data is still an empty page with `hasNextPage: false`, never an error. Cursors are opaque, so existing page tokens are reissued rather than reused (#49)
- Version is now reported in application startup logs
- The Horizon client is one implementation in the new `shared` workspace package, consumed by both services. The GraphQL server's fallback requests are throttled like the indexer's, the Horizon types and the retry policy exist once, and `indexer/src/throttle.ts` moved there so Soroban RPC pacing and Horizon pacing cannot diverge (#25)

## How to Release

1. **Update versions** in `package.json` files:
   ```bash
   npm version patch|minor|major  # updates package.json version
   ```

2. **Update `CHANGELOG.md`:**
   - Move `[Unreleased]` changes under a new versioned section
   - Use the format: `## [X.Y.Z] - YYYY-MM-DD`

3. **Create a git tag:**
   ```bash
   git tag @lumina/graphql-server@X.Y.Z
   git tag @lumina/indexer@X.Y.Z
   git push origin @lumina/graphql-server@X.Y.Z @lumina/indexer@X.Y.Z
   ```

4. **Verify in CI** that the tagged release builds successfully.

The version reported in startup logs and available through the API matches the package version.

## Notes on this Changelog

This changelog documents changes visible to API consumers. Internal refactoring, test improvements, and dependency updates that do not affect the public interface are not listed unless they fix a bug.

Each release is tagged with both the GraphQL server version and indexer version. Both versions are kept in sync to simplify tracking.
