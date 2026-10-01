# 0003. Memo search is trigram similarity, not `tsvector`

- **Status:** accepted
- **Date:** 2026-09-27
- **Sources:** the header comment of `db/migrations/004_search_indexes.sql`
  (condensed in `db/schema.sql`), `README.md` ("Search and asset filtering"),
  the docblock in `graphql-server/src/search.ts`, and commit `e74cd8b`.

## Context

Transactions carry a memo, and users search it — most often by pasting a memo
they already have, or a fragment of one. Memos on Stellar are mostly not
prose: they are order references, exchange deposit tags, invoice numbers and
short codes. The search has to rank by relevance, support substring and
typo-tolerant matching, and be fast enough to run on the request path.

## Options considered

**`tsvector`/full-text search**, the obvious default for a text column.
`to_tsvector` is built for prose: it stems words, folds them to lexemes, and
discards very short tokens. A memo of `ORDER-4471` stems to nothing useful —
and stemming an identifier is not merely unhelpful, it is *wrong*. The
configuration is tunable, but the premise underneath it (that the text is
language) does not hold for this data.

**Trigram similarity** (`pg_trgm`), which treats the memo as a string rather
than a sentence. Substrings, typos and case differences then all behave the same
way, and one GIN index serves both `similarity()` ranking and `ILIKE`.

## Decision

Trigram, with the ranking and pagination consequences that follow from it:

- **Ranking is `similarity()`, with an exact case-insensitive match pinned above
  every fuzzy one**, because someone pasting a full memo is looking for that
  transaction rather than for things resembling it.
- **The index is partial** — `WHERE memo IS NOT NULL` — because most
  transactions carry no memo and indexing millions of NULLs buys nothing.
- **Pagination is keyset, on the ranking tuple `(rank, ledger, hash)`.** Rank is
  deterministic for a fixed query string, so a page boundary holds as new ledgers
  land. An `OFFSET` would shift every later page by one whenever a newly indexed
  matching transaction sorted earlier, duplicating a row across the seam — which
  on a live feed is not a rare case but the normal one.
- **Cursors are opaque** (base64 rather than a readable tuple), so a client that
  starts constructing them by hand does not become a compatibility constraint on
  the ranking function.

## Consequences

**The GIN build is the slow part of the migration**, which is why
`db/migrations/004_search_indexes.sql` uses `CREATE INDEX CONCURRENTLY` and
therefore has no `BEGIN`/`COMMIT` — the build takes longer but does not hold a
write lock, so the indexer keeps running through it. `db/schema.sql` omits
`CONCURRENTLY` deliberately: it builds an empty database, where the lock does
not matter and a transaction-wrapped script would forbid it anyway.

**Asset filtering uses expression indexes rather than generated columns**, a
decision recorded in the same migration: the same effect for these queries
without rewriting every row in `operations`, which on a populated deployment is
the difference between minutes and hours. Native (XLM) payments carry no code or
issuer, only `asset_type`, so they need their own index or they are unfindable
by asset — the most common asset on the network would be the one you could not
search for.

**A threshold has to be chosen and it is a judgement call.** Below the
`MIN_SIMILARITY` in `graphql-server/src/search.ts`, trigram matches are noise:
two unrelated short strings share trigrams surprisingly often. It is tuned low
enough that a partial memo still matches and high enough that a three-character
query does not return the table.

**None of this shows whether the ranking puts the right row first**, which is
the only thing a user notices. The integration suite exists for that: it runs
against a real Postgres with real `pg_trgm`, which a faked client cannot
reproduce.
