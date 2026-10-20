# TypeScript client (`@lumina/client`)

A typed client for the Lumina GraphQL API, generated from the server's schema
([`graphql-server/src/schema.graphql`](../graphql-server/src/schema.graphql)).
Every request's variables and result are typed from the schema, so a consumer
writes no types by hand, and a mismatch (a misspelled field, a missing
argument, an enum value the API does not have) is a compile error instead of a
runtime crash.

The package lives in [`client/`](../client). It has one runtime dependency
(`@graphql-typed-document-node/core`, types only) and uses the platform
`fetch` (browsers, Node 18+).

## Installing

Each release `vX.Y.Z` ships the client generated from that version's schema:

```bash
# From npm, once the maintainers publish it (see "Releasing" below)
npm install @lumina/client

# From the GitHub release, which always carries the package
npm install https://github.com/Lumeeena/lumina-backend/releases/download/v1.2.3/lumina-client-1.2.3.tgz
```

Pin the client to the version of the server you talk to.

## Using the shipped operations

The package exports a typed document for each common query: `Transactions`,
`Transaction`, `SearchTransactions`, `Account`, `AccountBalanceHistory`,
`AccountSigners`, `Operations`, `Ledgers`, `Ledger`, `LatestLedger`,
`IndexerStatus`, `ContractEvents`, `Trades`, `Assets` and `AssetDetail`. Their
sources are in [`client/src/operations`](../client/src/operations).

```ts
import { createLuminaClient, TransactionsDocument, AccountDocument } from '@lumina/client';

const lumina = createLuminaClient({
  url: 'https://api.example.com/graphql',
  apiKey: process.env.LUMINA_API_KEY, // sent as x-api-key; see AUTHENTICATION.md
});

const { transactions } = await lumina.request(TransactionsDocument, { limit: 20, successful: true });
for (const tx of transactions.items) {
  console.log(tx.hash, tx.ledger, tx.memo); // string, number, string | null
}

const next = await lumina.request(TransactionsDocument, { limit: 20, cursor: transactions.pageInfo.cursor });

const { account } = await lumina.request(AccountDocument, { address: 'G...' });
account?.balances.forEach(b => console.log(b.assetCode ?? 'XLM', b.balance));
```

Result types are exported too (`TransactionsQuery`, `AccountQuery`, and
`TransactionFieldsFragment` for one transaction row), for passing results
around your own code. Enums are string unions (`OperationType`, `Network`,
...), so they need no runtime import.

Options: `apiKeyHeader` if the deployment changed `API_KEY_HEADER`, `headers`
for anything else, and `fetch` to supply your own implementation.

### Errors

- `LuminaGraphQLError`: the server answered with GraphQL errors. `code` is
  the first error's stable `extensions.code` (see [ERROR_CODES.md](ERROR_CODES.md)),
  `errors` all of them, and `data` any partial result.
- `LuminaHttpError`: no GraphQL response (non-JSON body, or a failed HTTP
  status with no errors). `status` is the HTTP status.

```ts
try {
  await lumina.request(TransactionsDocument, { cursor });
} catch (err) {
  if (err instanceof LuminaGraphQLError && err.code === 'INVALID_CURSOR') restartFromFirstPage();
  else throw err;
}
```

## Typing your own operations

For a query the package does not ship, generate types for it against the
schema the package carries (`node_modules/@lumina/client/schema.graphql`), so
it matches your client version exactly. With
[GraphQL Code Generator](https://the-guild.dev/graphql/codegen):

```ts
// codegen.ts in your project
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: 'node_modules/@lumina/client/schema.graphql',
  documents: 'src/**/*.graphql',
  generates: {
    'src/lumina.generated.ts': {
      plugins: ['typescript-operations', 'typed-document-node'],
      config: { enumsAsTypes: true, documentMode: 'string', useTypeImports: true },
    },
  },
};
export default config;
```

The documents this generates work with `lumina.request` like the shipped ones.

## Regeneration and releases

The client is generated, never edited by hand:

```bash
cd client
npm run generate   # rewrites src/generated/graphql.ts and schema.graphql
```

- **On every pull request**, CI's `client` job runs `npm run check`, which
  regenerates from the current schema and fails if the committed client
  differs. A schema change therefore has to ship with its regenerated client,
  and `main` never carries a stale one.
- **On every release tag** `vX.Y.Z`,
  [`.github/workflows/client-release.yml`](../.github/workflows/client-release.yml)
  regenerates the client from the tagged schema (failing if the committed one
  is stale), builds and tests it, then:
  - attaches `lumina-client-X.Y.Z.tgz` to the GitHub release for `vX.Y.Z`
    (creating the release if it does not exist yet);
  - publishes it to npm when the repository has an `NPM_TOKEN` secret (an npm
    automation token with publish rights on the `@lumina` scope). Prereleases
    (`v1.3.0-rc.1`) go to the `next` dist-tag. Without the secret this step is
    skipped and the GitHub release is the distribution channel.

The client's version is the service's version. When cutting a release, bump
every workspace together, which includes `client`:

```bash
npm version 1.2.3 --no-git-tag-version --workspaces --include-workspace-root
```

The release workflow fails if `client/package.json` does not match the tag.
