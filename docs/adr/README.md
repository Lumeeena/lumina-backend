# Architecture decision records

Why this repository is built the way it is, one decision at a time.

Most of these decisions were reasoned through carefully and then recorded in the
one place nobody looks: the commit message that introduced them, or a comment
inside the file they affect. That is fine while the author is still around and
useless afterwards. An ADR moves the reasoning to where a new contributor
starts looking, and keeps it next to the alternatives that were rejected — which
are usually the part that matters, because they are the ones that get
re-proposed.

Each record answers four things: the **context** that forced a decision, the
**options considered**, the **decision**, and its **consequences**. They are
short on purpose. An ADR is a record of what was decided and why, not a design
document, and it is never edited to match a later decision — a superseded ADR
stays, with a pointer to what replaced it, so the history of the reasoning
survives.

| ADR | Decision |
|---|---|
| [0001](0001-realtime-subscriptions-over-listen-notify.md) | Real-time updates use Postgres `LISTEN`/`NOTIFY`, not a broker |
| [0002](0002-one-shared-jsonb-table-for-custom-events.md) | Decoded custom events live in one shared JSONB table, not a table per contract |
| [0003](0003-trigram-search-instead-of-tsvector.md) | Memo search is trigram similarity, not `tsvector` full-text search |
| [0004](0004-network-in-every-key.md) | Every indexed row is scoped to a network, in the key |
| [0005](0005-partition-operations-by-ledger-range.md) | `operations` is partitioned by ledger range |

## Decisions recorded elsewhere

Not every decision needs an ADR — some are already argued where the reader
meets them, and copying them here would create two texts to keep in step. These
are the ones worth knowing about, with where the reasoning actually lives:

| Decision | Recorded in |
|---|---|
| Keyset pagination rather than `OFFSET`, for every list query | [`API_GUIDE.md`](../API_GUIDE.md) ("Pagination") |
| Decoded custom-event values are strings, so `i128` amounts never round | [`CUSTOM_SCHEMAS.md`](../CUSTOM_SCHEMAS.md) ("Why values come back as strings") |
| Least-privilege database roles; neither service can run DDL | [`DATABASE_ROLES.md`](../DATABASE_ROLES.md), `db/roles.sql` |
| API keys are hashed, never logged, and a bad key is never downgraded to anonymous | [`AUTHENTICATION.md`](../AUTHENTICATION.md), `graphql-server/src/auth.ts` |
| Routine log lines are sampled at 1%; warnings and errors never are | `README.md` ("Indexer observability environment variables"), `indexer/src/logger.ts` |
| Base images are pinned by digest | [`BASE_IMAGES.md`](../BASE_IMAGES.md) |
| Horizon fixtures are recorded from the live API, not hand-written | [`HORIZON_FIXTURES.md`](../HORIZON_FIXTURES.md) |
| A lagging indexer reports `stale` rather than withholding data | `graphql-server/src/freshness.ts` |
| Queries may be served from a read replica; subscriptions never are | [`DATABASE_OPERATIONS.md`](../DATABASE_OPERATIONS.md) ("Read replica") |

## Known gaps

Recorded here rather than papered over, because an ADR that invents a rationale
is worse than a missing one:

- **The `operations` foreign-key decision was documented and then deleted.**
  Commit `dfb91e0` added a block to `db/schema.sql` headed
  `-- Decision (#104): transaction_hash stays an immediate (non-deferrable)
  foreign key`, with its own "why immediate rather than deferrable" argument;
  commit `9224b61` (the partitioning migration) removed that block while keeping
  the foreign key and the test that depends on it. The reasoning now survives
  only in the commit diff, which is precisely the problem this directory exists
  to solve. It should be recovered into an ADR.
- **The observability vendors have no recorded reasoning.**
  `graphql-server/src/tracing.ts` and `indexer/src/errorTracking.ts` explain how
  traces and errors are exported and redacted, but not why OpenTelemetry and
  Sentry, why OTLP over HTTP, or why tracing defaults to off. The Prometheus and
  health-check choices *are* argued (`indexer/src/metrics.ts`,
  `graphql-server/src/observability.ts`).
- **The export path pages with `OFFSET`** while every query path keysets
  (`graphql-server/src/export.ts`, `scheduledExport.ts`), and no comment or
  document says why. It may be deliberate — an export walks a whole table rather
  than serving a client a page — but nothing records it.
- **`docs/asset_fields_indexing_review.md` recommends migrating the asset fields
  to real columns**, which is the opposite of what shipped. The repository does
  not record why the recommendation was not taken, so no ADR here claims one.

## Adding a decision

Copy [`0000-template.md`](0000-template.md) to `NNNN-short-slug.md`, using the
next free number, fill it in, and add a row to the table above.

Two rules:

- **Cite where the reasoning comes from**, in the `Sources` line: the README
  section, document, code comment or migration header that argued it. If there
  is no source, the decision is new — say so in the record rather than
  reconstructing a rationale that nobody wrote down.
- **Name the alternative that lost, and why.** "We chose X" is a statement of
  fact; "we chose X over Y because Y would have cost Z" is the thing a future
  reader can argue with.
