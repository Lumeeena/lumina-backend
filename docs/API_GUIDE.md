# Lumina GraphQL API Consumer Guide

This guide helps you build a client against the Lumina GraphQL API. It covers worked examples for common tasks, the pagination contract, the error model, and subscription usage.

## Getting Started

The Lumina API is a GraphQL endpoint that exposes indexed Stellar network data — transactions, operations, accounts, and Soroban contract events.

**Endpoint:** `https://lumina-api.stellar.org/graphql`

**Subscriptions:** WebSocket at the same path: `wss://lumina-api.stellar.org/graphql`

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

## Rate Limiting

There are no explicit rate limits on the public API, but queries are served sequentially — running many concurrent queries may hit your own client limits before hitting any server limit. For high-volume use, run queries serially or with modest concurrency (2–5 concurrent requests).

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
- **Schema reference:** `docs/CUSTOM_SCHEMAS.md`
- **Examples:** this guide
