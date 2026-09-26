# Lumina GraphQL API Consumer Guide

This guide helps you build a client against the Lumina GraphQL API. It covers worked examples for common tasks, the pagination contract, the error model, and subscription usage.

## Getting Started

The Lumina API is a GraphQL endpoint that exposes indexed Stellar network data — transactions, operations, accounts, and Soroban contract events.

**Endpoint:** `https://lumina-api.stellar.org/graphql`

**Subscriptions:** WebSocket at the same path: `wss://lumina-api.stellar.org/graphql`

**Authentication:** send an API key as `Authorization: Bearer lum_...`. See [`AUTHENTICATION.md`](AUTHENTICATION.md).

## Choosing a network

Every query and subscription takes an optional `network` argument as its **first**
argument. Omitted, it is the deployment's primary network — the behaviour every
client saw before the argument existed.

```graphql
query {
  transactions(network: TESTNET, limit: 10) {
    items { hash ledger }
    pageInfo { hasNextPage cursor }
  }
}
```

- Values are the uppercase `Network` enum: `MAINNET`, `TESTNET`, `FUTURENET`.
  Which of them exist depends on what the deployment configured — see
  [`MULTI_NETWORK.md`](MULTI_NETWORK.md).
- Naming a network the deployment does not serve is an error, not a silent
  fallback to the primary:

  ```json
  {
    "message": "Network \"RANKENET\" is not configured on this deployment. Configured networks: MAINNET, TESTNET.",
    "extensions": { "code": "BAD_USER_INPUT" }
  }
  ```

- Nested fields inherit the network from their parent: a transaction read for
  `TESTNET` resolves its `ledgerData`, `operations` and account against testnet,
  with no argument to repeat. Rows know which network they came from.
- Subscriptions take the same argument, and a notification for a different
  network is dropped before any rows are read — see
  [Subscriptions](#subscriptions).

## Pagination

Every list query in Lumina uses **keyset pagination**, not offset pagination. Keyset pagination is stable across concurrent writes — a page boundary does not shift as new data lands, and you will not see duplicate or missing rows across page boundaries.

### Pagination contract

Every paginated query returns:
- `items: [T!]!` — the requested rows
- `pageInfo` with:
  - `hasNextPage: Boolean!` — true if there are more results
  - `cursor: String` — a token to fetch the next page (only present if `hasNextPage` is true)

To fetch the next page, pass the cursor to the same query:

```graphql
{
  transactions(limit: 20, cursor: "...opaque token from previous page...")
}
```

### Limits

- **Default limit:** 20 items per page
- **Max limit:** no hard cap, but queries are serial so use 50–200 for practical clients

## Common Queries

### Fetch recent transactions

```graphql
query {
  transactions(limit: 20) {
    items {
      hash
      ledger
      createdAt
      sourceAccount
      successful
      feeCharged
      memo
      memoType
      operationCount
    }
    pageInfo {
      hasNextPage
      cursor
    }
  }
}
```

### Get a single transaction

```graphql
query GetTransaction($hash: String!) {
  transaction(hash: $hash) {
    hash
    ledger
    createdAt
    sourceAccount
    account {
      address
      sequence
    }
    feeCharged
    operationCount
    successful
    memo
    memoType
    operations {
      id
      type
      createdAt
      sourceAccount
      from
      to
      amount
      asset
    }
  }
}
```

### Search transactions by memo

Search ranks results by trigram similarity, not recency. An exact case-insensitive match always ranks first.

```graphql
query SearchTransactions($query: String!) {
  search(query: $query, limit: 20) {
    items {
      hash
      ledger
      createdAt
      memo
      sourceAccount
    }
    pageInfo {
      hasNextPage
      cursor
    }
  }
}
```

Example: searching for `"ORDER-4471"` returns exact matches first, then `"ORDER-4471-REFUND"`, then fuzzy matches like `"ORDR-4471"`.

### Fetch an account

```graphql
query GetAccount($address: String!) {
  account(address: $address) {
    address
    sequence
    subentryCount
    balances {
      assetType
      assetCode
      assetIssuer
      balance
      limit
    }
    flags {
      authRequired
      authRevocable
      authImmutable
      authClawbackEnabled
    }
    thresholds {
      lowThreshold
      medThreshold
      highThreshold
    }
    transactions(limit: 10) {
      hash
      createdAt
      memo
    }
    operations(limit: 10) {
      id
      type
      amount
      asset
    }
  }
}
```

### List operations with filters

```graphql
query ListOperations($account: String, $type: OperationType, $asset: String) {
  operations(account: $account, type: $type, asset: $asset, limit: 20) {
    items {
      id
      type
      createdAt
      sourceAccount
      amount
      asset
      from
      to
    }
    pageInfo {
      hasNextPage
      cursor
    }
  }
}
```

**Asset filter format:**
- Native Stellar Lumens: `"XLM"` or `"native"`
- Issued asset: `"USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"`

The asset filter matches operations where the asset appears as a payment asset or either side of a trade.

### Fetch asset detail with supply and volume series

One query returns everything a detail page needs — no separate supply, holder and chart round trips:

```graphql
query GetAssetDetail($asset: String!) {
  asset(
    asset: $asset
    from: "2026-01-01T00:00:00Z"
    to: "2026-01-31T00:00:00Z"
    bucketSeconds: 86400
  ) {
    asset
    code
    issuer
    native
    supply
    holders
    series {
      bucketStart
      bucketEnd
      volume
      operationCount
    }
  }
}
```

- `asset` uses the same format as the operations filter: `"XLM"` (or `"native"`) or `"CODE:ISSUER"`.
- `from`/`to` are ISO-8601 timestamps (defaults: trailing 30 days to now); `bucketSeconds` is the bucket width in seconds (default daily, minimum 60, at most 1000 buckets per call).
- Amounts (`supply`, per-bucket `volume`) are decimal strings, not floats, so large values never lose precision. Empty buckets report `"0"` volume with `operationCount: 0`.

**How supply is derived:** supply is `SUM(balance)` over every `accounts.balances` entry naming the asset, and holders is the count of those entries with balance greater than zero.

**Limitations:**

- Only indexed accounts count — the indexer writes accounts it has seen activity for, so a fresh or lagging database understates supply and holders.
- Balances are a last-seen snapshot per account, not point-in-time ledger state.
- Zero-balance trustlines are excluded from holders; unauthorized, frozen or clawed-back balances are included; buying/selling liabilities are not subtracted.
- Volume sums `amount` on operations matching the `operations(asset:)` predicate (payment asset or either side of an offer) bucketed by `created_at`. Operations without a numeric amount count toward `operationCount` but not `volume`, and operations from failed transactions are included.

### Query Soroban contract events

```graphql
query GetContractEvents($contractId: String!) {
  events(contractId: $contractId, limit: 20) {
    items {
      id
      type
      contractId
      ledger
      createdAt
      topics
      value
    }
    pageInfo {
      hasNextPage
      cursor
    }
  }
}
```

### Query custom-decoded contract events (if a schema is registered)

If a contract has a registered custom schema (see `docs/CUSTOM_SCHEMAS.md`), you can query decoded, typed fields:

```graphql
query GetCustomEvents($contractId: String!) {
  customEvents(
    contractId: $contractId
    event: "transfer"
    where: [
      { field: "amount", op: GT, value: "1000" }
      { field: "from", op: EQ, value: "GACCOUNT" }
    ]
    limit: 20
  ) {
    items {
      eventId
      contractId
      eventName
      ledger
      createdAt
      schemaVersion
      fields {
        name
        type
        value
      }
    }
    pageInfo {
      hasNextPage
      cursor
    }
  }
}
```

Filter operators:
- `EQ`, `NE` — equality (work on any field type)
- `GT`, `GTE`, `LT`, `LTE` — comparison (numeric fields only)

### Get the latest ledger

```graphql
query {
  latestLedger {
    sequence
    closedAt
    transactionCount
    operationCount
    baseFee
    baseReserve
  }
}
```

### Get a specific ledger

```graphql
query GetLedger($sequence: Int!) {
  ledger(sequence: $sequence) {
    sequence
    closedAt
    transactionCount
    operationCount
    baseFee
    baseReserve
  }
}
```

### Check how current the data is

A cached index answers faster than the chain can, and is wrong the moment it
falls behind. `indexerStatus` is the number that lets a client say that out loud
— "12 ledgers behind", "showing cached data" — instead of presenting a stale
ledger as current.

```graphql
query {
  indexerStatus(network: TESTNET) {
    network
    latestIndexedLedger
    latestIndexedAt
    horizonLedger
    lagLedgers
    stale
    checkedAt
  }
}
```

- `lagLedgers` is Horizon's tip minus ours for **that** network; `stale` is true
  when the gap exceeds 20 ledgers, when nothing has been indexed yet, or when
  either side could not be read.
- `stale` is a label, not a gate: withholding data because it says so would turn
  a lagging indexer into a total outage. Labelled stale data beats no data.
- Neither side failing is an error. An unreachable Horizon or database comes
  back as `null` fields plus `stale: true` — the interesting moment for this
  query is exactly when something is wrong, and that is when a client most wants
  an answer rather than an error.

## Persisted queries

The server accepts automatic persisted queries (APQ): send the SHA-256 of your
document with the document itself the first time, and the hash alone afterwards.

```json
{
  "query": "{ latestLedger { sequence } }",
  "extensions": {
    "persistedQuery": {
      "version": 1,
      "sha256Hash": "af2c2c0d9e2a5b0f0f0f…"
    }
  }
}
```

| Response | Meaning | What to do |
| --- | --- | --- |
| `Persisted query not found` (`PERSISTED_QUERY_NOT_FOUND`) | The hash is not in the server's cache — a new process, a restarted cache, or a client that skipped the register step | Retry with the full document and the same `persistedQuery` extension; the server stores it under the hash |
| `Persisted queries are not supported` (`PERSISTED_QUERY_NOT_SUPPORTED`) | The deployment has APQ switched off | Send full documents; the hash will never be accepted |

Notes:

- The cache is in-memory and keyed by hash, so every server restart empties it
  and clients re-register on their next request. Registrations live seven days
  by default (`PERSISTED_QUERIES_TTL_SECONDS`).
- This is a cache, **not** a safelist. The server answers "I have seen this
  document", never "this document is allowed" — an allow-listed-persisted-queries
  deployment is a different feature and not what this is.

## Subscriptions

Subscribe to changes over WebSocket at the same endpoint. Subscriptions are available for new transactions and account activity.

### Subscribe to new transactions

```graphql
subscription {
  newTransaction {
    hash
    ledger
    createdAt
    sourceAccount
    successful
    memo
  }
}
```

Fires when a transaction is confirmed in a new ledger.

### Subscribe to account activity

```graphql
subscription AccountActivity($address: String!) {
  accountActivity(address: $address) {
    id
    type
    createdAt
    transactionHash
    sourceAccount
    from
    to
    amount
    asset
  }
}
```

Fires when an operation *touches* the account — either as the source or as a counterparty (payment recipient, offer participant, trust line author, etc.).

**Example client setup with `graphql-ws`:**

```typescript
import { createClient } from 'graphql-ws';
import WebSocket from 'ws';

const client = createClient({
  url: 'wss://lumina-api.stellar.org/graphql',
  webSocketImpl: WebSocket,
});

client.subscribe(
  {
    query: `subscription { newTransaction { hash ledger createdAt } }`,
  },
  {
    next: (msg) => console.log('New transaction:', msg.data),
    error: (err) => console.error('Subscription error:', err),
    complete: () => console.log('Subscription closed'),
  }
);
```

## Error Handling

The GraphQL API returns errors in the standard GraphQL error format. Each error has:

- `message` — a human-readable description
- `extensions.code` — a machine-readable error category

### Common error codes

| Code | Meaning | Example |
| --- | --- | --- |
| `GRAPHQL_VALIDATION_FAILED` | Query is malformed or violates the schema | Missing required field, wrong type |
| `GRAPHQL_PARSE_FAILED` | Query syntax is invalid | Unmatched braces, invalid tokens |
| `INTERNAL_SERVER_ERROR` | Server error | Database connection failure |
| `BAD_REQUEST` | Client request error | Invalid asset format, empty search query |
| `BAD_USER_INPUT` | The request named something the server does not serve | `network: RANKENET` when only `MAINNET`, `TESTNET` are configured |
| `UNAUTHENTICATED` | API key is malformed, unknown, or revoked | See [`AUTHENTICATION.md`](AUTHENTICATION.md#authentication-errors) |
| `RATE_LIMITED` | Rate limit exceeded; wait `extensions.retryAfter` seconds | See [`AUTHENTICATION.md`](AUTHENTICATION.md#when-you-are-throttled) |

### Example error response

```json
{
  "errors": [
    {
      "message": "Asset filter must be in format CODE:ISSUER or XLM",
      "extensions": {
        "code": "BAD_REQUEST"
      }
    }
  ]
}
```

### Search-specific errors

- **Empty query:** Search queries must not be empty or whitespace-only
- **Query too long:** Search queries have a maximum length to prevent performance issues
- **Invalid cursor:** A cursor from a previous search page is malformed or has expired

### Custom event filter errors

- **Invalid field:** The field does not exist in the contract's registered schema
- **Invalid operator:** The operator does not match the field type (e.g., `GT` on a string field)
- **Invalid value:** The value cannot be parsed as the declared type

## Authentication and Rate Limiting

The API is moving to API keys with per-key rate limits, rolled out in announced phases so existing clients have time to migrate. Requests without a key keep working under a smaller anonymous tier.

See [`AUTHENTICATION.md`](AUTHENTICATION.md) for how to get and send a key, the `X-RateLimit-*` headers, what to do when throttled, the anonymous tier's limits, and the migration timeline.

## Schema Introspection

The API supports GraphQL introspection, so you can query the schema itself:

```graphql
query {
  __schema {
    types {
      name
      description
      fields {
        name
        description
        type {
          name
          kind
        }
      }
    }
  }
}
```

Most GraphQL tools (Apollo Client, GraphQL CodeGen, etc.) use introspection to power code generation and IDE autocomplete.

## API Versioning

The GraphQL schema is a public interface. Version changes are tracked via git tags and a changelog in the repository. Consumers should check the repository for breaking changes before upgrading.

For the currently running version, check the startup logs or query the server's version endpoint (if available).

## Support

For issues or questions:
- **GitHub:** https://github.com/Lumeeena/lumina-backend/issues
- **Authentication and API keys:** `docs/AUTHENTICATION.md`
- **Schema reference:** `docs/CUSTOM_SCHEMAS.md`
- **Examples:** this guide
