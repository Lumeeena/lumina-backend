# 0002. Decoded custom events live in one shared JSONB table

- **Status:** accepted
- **Date:** 2026-09-27
- **Sources:** the header comment of `db/migrations/003_custom_event_schemas.sql`
  (repeated in `db/schema.sql`), `docs/CUSTOM_SCHEMAS.md`, the docblock in
  `graphql-server/src/customEvents.ts`, and commit `19d7f58`.

## Context

Projects register a schema describing how to decode their contract's events.
Those events are third-party input: the field names, the event names and the
number of fields are all chosen by someone else, and they change every time a
project revises its schema. The decoded result has to be queryable and
filterable — including ordered comparison on amounts — without letting a
third-party schema reach into the database's structure.

## Options considered

**A generated table per contract and event** — `CREATE TABLE
custom_<contract>_<event>` with real columns. This is the idiomatic subgraph
approach and it buys native column types. The migration header lists what it
costs: DDL on the indexing hot path, table sprawl that grows with every
registration, an `ALTER TABLE` migration story for every schema revision, and
identifiers derived from third-party input arriving in SQL *as identifiers*
rather than as bind parameters.

**Repurposing the Registry contract's `description` field** to carry the schema,
which the issue floated. Rejected in commit `19d7f58`: it overloads user-facing
metadata with a JSON blob, and puts a fee and a signing key between a project
and a document it will revise repeatedly while getting its field mappings
right.

**Generation of a GraphQL type per schema.** The nicer developer experience,
and it does not fit this deployment: the indexer and the server are separate
processes, so a schema registered against the database would have to reach a
*running* server and trigger a rebuild — a window where the advertised schema
and the stored data disagree, a cache-busting story for every client, and
every connected subscriber dropped on each registration. The type stays fixed
and the values carry their declared types; registration is a CLI operation
against the database instead.

## Decision

One shared `custom_events` table with a JSONB `fields` payload, plus a
`contract_schemas` table holding each contract's definition. A schema revision
is a metadata update. Field names never leave the JSONB layer: a filter becomes
`fields->>$n` with the name bound as a parameter, and the only parts of the
statement derived from input are the comparison operator and the cast, both
looked up in fixed tables.

## Consequences

**Ordered comparison costs a cast.** JSONB does not carry the type, so a
range filter casts the text to `numeric` using the type the schema declares.
That is the price of not shredding the payload into columns, and it is why
`GT`/`GTE`/`LT`/`LTE` are accepted only on fields declared numeric — `>` on an
address would silently compare lexicographically.

**Values are stored and returned as strings, deliberately.** `i128` is the type
this feature exists for and it does not fit in a JavaScript number: `JSON.parse`
rounds anything above 2^53, and an indexer that rounds balances is worse than
one that does not decode them at all. Exact decimal text end to end, compared as
`numeric` in Postgres, which is exact at any width.

**A filter written as `fields->>'name' = $1` cannot use the GIN index** on
`fields`, which serves containment (`@>`) rather than `->>`. The index exists
for exact-match filters written in the containment form; the queries as shipped
use `->>`. This is a real cost of the shared-payload shape and is recorded here
because it is the kind of thing that looks like a missing index later.

**Validation is the security boundary.** Names are identifier-shaped, checked
against a reserved list, types come from a fixed set, and there are caps on
events and fields so that a schema cannot be a denial of service by size alone.
A revision that no longer matches its contract is rejected rather than guessed
at, because silently storing null would hide the divergence indefinitely.
