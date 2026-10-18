# SQL Snapshot Testing

This document explains the SQL snapshot testing framework used to guard against accidental SQL regressions, query drift, and unreviewed query plan changes across all paginated and filtered queries.

---

## 1. Why SQL Snapshot Testing

Lumina's GraphQL API builds SQL queries dynamically based on filter arguments, ordering options, and cursor pagination directions. Small changes in query builders can easily lead to:
- Missing index matches (e.g. inverted column ordering or missing casts)
- Subquery inefficiencies or duplicate condition predicates
- Broken keyset pagination operators (`<` vs `>`)
- Parameter index misalignment

SQL snapshot tests capture the exact statement string and parameter count generated for representative query arguments and assert that any change to the generated SQL is caught immediately.

---

## 2. Test Coverage

Snapshot tests are implemented in `graphql-server/src/sqlSnapshots.test.ts` and stored in `graphql-server/src/__snapshots__/sql_queries.json`.

Representative test cases covered:
- **`getTransactions`**:
  - Default query (`ORDER BY ledger DESC, hash DESC LIMIT $2`)
  - Filtered query with `successful`, `from`, `to`, `source_account`
  - Keyset forward pagination (`(ledger, hash) < (SELECT ... )`)
  - Keyset backward pagination (`(ledger, hash) > (SELECT ... ) ORDER BY ledger ASC, hash ASC`)
  - Ascending sort order
- **`getOperations`**:
  - Default query
  - Filtered by `account` and `type`
  - Keyset forward and backward pagination
- **`getLedgers`**:
  - Default sequence order
  - Forward and backward keyset pagination on `sequence`
- **`getAccounts`**:
  - Default `RECENT_ACTIVITY` order (`last_modified_ledger DESC, address ASC`)
  - Forward and backward pagination with tiebreaker inversion
  - `ADDRESS` order forward and backward
- **`getEventsByContract`**:
  - Default query
  - Filtered by topic and cursor
- **`getContractStorageEntries`**:
  - Default query
  - Filtered by `durability`, `keyPrefix` with escaped wildcards, and cursor
- **`getOperationsByAsset`**:
  - Native asset (`XLM`) filtering
  - Issued credit token (`USDC:ISSUER`) filtering and forward pagination
- **`searchTransactions`**:
  - Trigram ranking and similarity query
  - Backward pagination with inverted rank/ledger ordering

---

## 3. How to Run the Tests

To run the SQL snapshot verification:

```bash
npm run test:sql-snapshots
```

or via Node test runner directly:

```bash
node --require ts-node/register --test src/sqlSnapshots.test.ts
```

If any query generates SQL differing from the committed snapshot in `src/__snapshots__/sql_queries.json`, the test fails and prints the diff between expected and received SQL.

---

## 4. How to Accept Intended Changes in One Step

When you make an intentional change to query generation (e.g. adding a filter, optimizing an index clause, or improving pagination):

Run the snapshot update command:

```bash
npm run test:sql-snapshots:update
```

or with the environment variable flag:

```bash
UPDATE_SQL_SNAPSHOTS=true npm run test:sql-snapshots
```

This updates `graphql-server/src/__snapshots__/sql_queries.json` with the new golden queries. Review the resulting `git diff` on `sql_queries.json` before committing to ensure the generated SQL is expected and optimal.
