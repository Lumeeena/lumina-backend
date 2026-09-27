# Constructing SQL

Every statement in this codebase is a string, and several of them are built at
runtime from a request. This is the rule they follow and the tests that hold
them to it.

## The rule

> **Values are bound. Identifiers come from fixed tables.**

A value — an address, a memo, a limit, a cursor, a JSONB field name, a filter
operator, a date — travels to PostgreSQL as a bind parameter, never as text in
the statement. An identifier — a table name, a column name — never comes from a
request at all: it is looked up in a table or a map that the code owns.

The distinction is not stylistic. A bind parameter cannot change the shape of a
statement, whatever its content; text inside a statement can. `LIMIT $1` is a
limit; `LIMIT 1; DROP TABLE users` is two statements.

## The pattern

Optional filters are built as an array of condition fragments alongside the
array of values, and the placeholders are numbered from the values array as it
grows. From `graphql-server/src/db.ts`:

```ts
const conditions: string[] = [];
const params: unknown[] = [];

params.push(opts.network);
conditions.push(`network = $${params.length}`);

if (opts.account) {
  params.push(opts.account);                          // the value, bound
  conditions.push(`source_account = $${params.length}`); // the placeholder
}
```

The fragments are literals written in the source; the only thing derived from
input is which fragments are present. That is why the numbers can be computed:
the placeholder is always one past the end of the array it will index.

This is asserted rather than assumed. The tests live beside the builders and
match the **whole statement**, not a fragment — `graphql-server/src/db.test.ts`
for `getOperations` and `getEventsByContract`, `search.test.ts` for search and
the asset filter, `customEvents.test.ts` for decoded-event filters, and
`assets.test.ts` for the asset detail query. Each also asserts that the hostile
input does not appear in the statement text and does appear in the params array.

## Where a request's shape is derived

Two places turn a request into something other than a bound value, and both are
looked up rather than interpolated:

- **JSONB field names** in a custom-event filter become `fields->>$n`, with the
  *name* bound as a parameter. Field names come from a third-party schema and
  never enter a statement as identifiers. The comparison operator and the cast
  are not bound either — they are the only parts of the statement derived from
  input, and both are looked up in a fixed table, so a value outside it is
  rejected before any SQL is built.
- **JSONB keys** are read out of the payload by the query layer, never written
  into it.

## The one exception

`COPY` cannot take bind parameters: there is no `COPY … WHERE x > $1` to write,
which is why `buildCsvExportStatement` in `graphql-server/src/export.ts`
interpolates both the values and the identifiers. It is safe for a reason that
can be stated exactly, and which its tests pin:

- the **table and column names** are read out of the `CSV_EXPORT_TABLES` map, so
  the only identifiers that can reach the statement are the ones written there;
  a table not in the map returns null and the endpoint answers 400;
- a **ledger bound** passes through `parseInt`, so it is an integer and can
  carry no quote, semicolon or comment;
- a **date** passes through `Date.toISOString()`, whose alphabet is fixed and
  cannot contain a quote;
- anything that does not survive that normalisation (`NaN`, an invalid date) is
  dropped rather than written, so a hostile value produces the same statement as
  no value at all.

`graphql-server/src/export.test.ts` asserts each of those: the exact statement
for known input, `null` for tables off the list, and that hostile inputs produce
statements byte-identical to benign ones.

If you add a dynamic query, follow the bound-value pattern above. If you think
you need a second exception, that is an architecture decision worth writing
down, not a comment to leave in the handler.
