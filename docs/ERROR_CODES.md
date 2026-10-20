# Error codes

Every GraphQL error the API returns carries a stable, machine-readable code in
`extensions.code`. Clients branch on that code; `message` is for humans and may
be reworded at any time without notice.

```json
{
  "errors": [
    {
      "message": "Asset filter must be \"CODE:ISSUER\" (or \"XLM\" for the native asset), got \"USDC\".",
      "extensions": { "code": "BAD_USER_INPUT" }
    }
  ]
}
```

Transport details still matter — authentication failures are HTTP `401`,
timeouts can be `504`, and a rate limit is a `429` — but they are not the
contract. A `200` response can carry errors, and the code is what tells you
what happened and whether retrying can help.

## Taxonomy

| Category | Meaning | What to do |
| --- | --- | --- |
| `invalid_input` | The request named or contained something unusable. | Fix the request. Retrying it unchanged fails the same way. |
| `not_found` | A resource the request named does not exist. | Check the identifier. Retrying it unchanged fails the same way. |
| `rate_limited` | A per-key, per-IP or server-wide limit turned the request away. | Back off (use `extensions.retryAfter` when present), then retry. |
| `authentication` | The API key is malformed, unknown or revoked. | Fix credentials. Do not retry. See [`AUTHENTICATION.md`](AUTHENTICATION.md). |
| `internal` | The server understood the request but could not complete it. | Retry once, then report the `correlationId` if one is present. |

## Codes by category

### `invalid_input`

| Code | Meaning |
| --- | --- |
| `BAD_USER_INPUT` | An unknown `network`, a page size that is not a positive integer or exceeds the maximum, an aggregate `limit` above its ceiling, a time range wider than its query allows, a malformed asset filter, a filter on a field or operator a custom-event schema does not define, or a value that does not match the declared type. |
| `INVALID_CURSOR` | A pagination cursor the server did not issue, issued for a different query, or that no longer decodes. Cursors are opaque — pass back the one the previous page returned. |
| `QUERY_TOO_DEEP` | The operation nests deeper than the deployment's `GRAPHQL_MAX_DEPTH`. |
| `QUERY_TOO_COMPLEX` | The operation costs more than the deployment's `GRAPHQL_MAX_COMPLEXITY`. Lower `limit` arguments or drop nested lists. |

### `not_found`

| Code | Meaning |
| --- | --- |
| `NOT_FOUND` | A contract with no registered custom-event schema, or an event the registered schema does not declare. |

Nullable queries (`transaction`, `account`, `ledger`, `contractSchema`, …)
answer "no such row" with `data: null`, not with an error. `NOT_FOUND` is for a
request that names a resource the server needs in order to answer at all.

### `rate_limited`

| Code | Meaning |
| --- | --- |
| `RATE_LIMITED` | A request budget was exhausted, or the server is at its ceiling of concurrent subscriptions. When present, `extensions.retryAfter` is the number of seconds to wait. |

### `authentication`

| Code | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | A key was sent but is malformed, unknown or revoked. The message deliberately does not say which. |

### `internal`

| Code | Meaning |
| --- | --- |
| `QUERY_TIMEOUT` | The database cancelled the query for running past `DB_STATEMENT_TIMEOUT_MS`. Narrow the request and retry. |
| `REQUEST_TIMEOUT` | The HTTP request was not answered within `REQUEST_TIMEOUT_MS`. Retry. |
| `INTERNAL_SERVER_ERROR` | An unexpected failure. In production the message is masked to `Internal server error` and `extensions.correlationId` names the matching log entry. |

## Framework codes

These originate in Apollo Server or graphql-js rather than in Lumina. They are
stable too, and clients will see them alongside the codes above.

| Code | Category | Meaning |
| --- | --- | --- |
| `GRAPHQL_PARSE_FAILED` | invalid_input | The query text is not valid GraphQL syntax. |
| `GRAPHQL_VALIDATION_FAILED` | invalid_input | The query does not match the schema (unknown field, missing argument, wrong type). |
| `BAD_REQUEST` | invalid_input | The HTTP request itself is malformed — for example a body that is not JSON or is missing a query. |
| `OPERATION_RESOLUTION_FAILURE` | invalid_input | The document contains no operation, or `operationName` does not name one. |
| `PERSISTED_QUERY_NOT_FOUND` | invalid_input | Automatic persisted queries are on and the hash has not been registered yet. Retry with the full query; the server stores it. |
| `PERSISTED_QUERY_NOT_SUPPORTED` | invalid_input | Automatic persisted queries are off; send the full document. |

## How the server maps its errors

For maintainers: the code an error is created with is the code the client sees.
`CustomQueryError` defaults to `BAD_USER_INPUT`; `SearchError`, `AssetError`
and `InvalidInputError` are `BAD_USER_INPUT`; `ApiKeyError` is
`UNAUTHENTICATED`; `SubscriberLimitError` is `RATE_LIMITED`; and query-limit,
timeout and cursor errors are created with their codes directly. Anything else
is labelled `INTERNAL_SERVER_ERROR` and — in production — masked by
`MASK_INTERNAL_ERRORS` with a correlation id. See `graphql-server/src/errorCodes.ts`
for the single source of truth.

## Stability rules

- A code's meaning never changes and a code is never removed without a
  deprecation cycle announced in the [changelog](../CHANGELOG.md).
- New codes can appear at any time; a client that does not recognise one should
  fall back to treating it as its category suggests and report it.
- Messages, locations, paths and `correlationId` values are not stable.
