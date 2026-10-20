# Response memory ceiling

The server assembles each GraphQL response in memory and serializes it in one
piece before writing the body (Apollo Server 4, no incremental delivery). That
makes the largest response the schema permits the process's worst case per
request, and the thing that must stay bounded is *that* size — not a typical
response. This document records how it is bounded and what the measured ceiling
is.

## What bounds a response

Pagination bounds the list queries. `transactions`, `operations`, `events`,
`customEvents`, `accounts`, `ledgers`, `trades`, `assets`, and the nested
account lists are all keyset-paginated and reject a page size above
`MAX_PAGE_SIZE` (100). A page is therefore a fixed number of rows regardless of
how much data sits behind the filter.

Three queries return a whole result set and have no cursor to page with:

| Query | Range argument | Ceiling |
| --- | --- | --- |
| `networkStats` | `startTime`–`endTime`, `granularity` | `limit`, default and max 1000 buckets |
| `activityRollups` | `startTime`–`endTime`, `granularity` | `limit`, default and max 1000 buckets |
| `sponsoredAccounts` | `sponsorAddress` | `limit`, default and max 1000 accounts |

Each accepts a `limit` and enforces it in the query layer (`LIMIT $n`), so the
database returns at most that many rows. `MAX_AGGREGATE_ROWS` (1000, in
`src/pagination.ts`) is the shared maximum. The two time-series queries also
check the *span* of the range before querying: a range wider than the limit is
rejected with `BAD_USER_INPUT` rather than silently `LIMIT`-ed, because a
truncated series a client reads as complete is worse than an error.

The CSV export (`GET /export/:table`) is the one endpoint that does not buffer:
it streams `COPY … TO STDOUT` straight to the response socket via
`pg-copy-streams`.

## Measuring the ceiling

`graphql-server/scripts/measure-response-memory.ts` executes each query at its
cap against a real database and reports the serialized response size and the
peak heap/RSS the call took:

```sh
DATABASE_URL=postgresql://… node --expose-gc \
  --require ts-node/register/transpile-only \
  graphql-server/scripts/measure-response-memory.ts
```

Seed a database large enough for the caps to bind with `db/seed.sql` — the point
of the caps is that the numbers stay flat as the data behind the widest allowed
range grows.

### Measured results

Against a database seeded with 100,000 rollup buckets and 50,000 sponsored
accounts, each query at its cap:

| Query | Response | Heap delta |
| --- | --- | --- |
| `networkStats` (1000 hourly buckets) | ~0.1 MB | ~9 MB |
| `activityRollups` (1000 hourly buckets) | ~0.2 MB | ~9 MB |
| `sponsoredAccounts` (1000 accounts) | ~0.2 MB | ~13 MB |

The heap delta is dominated by fixed per-request overhead (parsing, execution,
the `pg` row buffers), not the response; the response itself is flat at the cap
regardless of how much data the range covers. Before the cap, the same queries
over a multi-year range returned ~11 MB responses and grew the heap by ~75–88 MB
per request.

## The automated ceiling

`src/responseMemory.test.ts` runs each query at its cap through the real schema
and resolvers and asserts the serialized response stays under a 2 MB ceiling,
that the query layer never binds a `LIMIT` above the cap, and that an over-cap
request is refused rather than buffered. The ceiling is loose relative to the
measured size on purpose: it is a regression guard against a response that
scales with the request, not a pinned byte count.
