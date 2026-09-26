# Multiple networks

One Lumina deployment can serve more than one Stellar network — mainnet and
testnet in the same database, indexed by the same process, separated by a
`network` column rather than by running everything twice.

This document is the whole scheme: how a deployment declares its networks, what
happens when it does not, and where the split is visible from the outside.

## Declaring networks

```bash
NETWORKS=mainnet,testnet
MAINNET_HORIZON_URL=https://horizon.stellar.org
TESTNET_HORIZON_URL=https://horizon-testnet.stellar.org
TESTNET_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
PRIMARY_NETWORK=testnet
```

| Variable | Meaning |
|---|---|
| `NETWORKS` | Comma-separated names, in declaration order. Known names: `mainnet`, `testnet`, `futurenet` |
| `<NAME>_HORIZON_URL` | Required for every declared network |
| `<NAME>_SOROBAN_RPC_URL` | Optional; unset means no contract-event indexing for that network |
| `<NAME>_NETWORK_PASSPHRASE` | Optional; defaults by network name |
| `<NAME>_INDEXED_CONTRACT_IDS` | Optional; overrides the shared `INDEXED_CONTRACT_IDS` for that network (indexer only) |
| `PRIMARY_NETWORK` | Which declared network is the default; the first declaration otherwise |

Leave `NETWORKS` unset and the flat variables describe exactly one network —
`HORIZON_URL`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE` — named by
`PRIMARY_NETWORK` (default `mainnet`). An existing single-network deployment
needs no configuration change:

```bash
HORIZON_URL=https://horizon-testnet.stellar.org \
PRIMARY_NETWORK=testnet \
npm run dev
```

The names are a fixed set because the GraphQL schema exposes them as a `Network`
enum, and an enum is static: adding a network to a deployment means adding it to
`graphql-server/src/schema.graphql` first. That is deliberate — the set of
networks an API serves is a contract, not a runtime string.

## What fails loudly

Every case below throws `NetworkConfigError` at startup, in both processes,
before a single row is written or answered:

| Situation | Why it is an error |
|---|---|
| `NETWORKS` declares a network with no `<NAME>_HORIZON_URL` | The alternative is polling a default endpoint while the operator believes they configured testnet |
| `<NAME>_HORIZON_URL` set while `NETWORKS` is not | A configured endpoint nothing reads is the same mistake in reverse |
| `<NAME>_HORIZON_URL` names a network `NETWORKS` does not declare | Typo in `NETWORKS`, or a network that was configured and then removed from the list |
| `NETWORKS` names an unknown network, or names one twice | The name has to exist in the `Network` enum and appear once |
| `PRIMARY_NETWORK` names something not declared | The default must be one of the networks being served |

A network that is half-configured never gets as far as indexing: the failure
mode after startup would be data correctness (the wrong chain's rows in a table
keyed by hash), not availability, so it is not left to be discovered later.

## What it looks like from the API

Every query takes `network` as its **first** argument, and it is optional:

```graphql
{
  transactions(network: TESTNET, limit: 10) {
    hash
    ledger
    operations { id }
  }
}
```

- Omitted means the configured primary — the behaviour every client saw before
  the argument existed, which is why adding it is not a breaking change.
- Named means that network and no other. A network this deployment does not
  configure is a `BAD_USER_INPUT` error, never a silent fall back to the
  primary: "I asked for testnet and got mainnet" is exactly the mixing this
  argument exists to prevent.
- The enum value is uppercase (`TESTNET`); the stored column value is lowercase
  (`testnet`). `networkEnumValue()` maps between them.

Nested fields inherit the network from their parent — a `Transaction` read for
`TESTNET` resolves its `operations` and `ledgerData` against testnet, with no
need to repeat the argument. Subscriptions take the same argument and filter
both ways: a notification for another network is dropped before any rows are
read.

`indexerStatus` reports freshness per network:

```graphql
{
  indexerStatus(network: TESTNET) {
    latestIndexedLedger
    horizonLedger
    lagLedgers
    stale
  }
}
```

## The database

Migration `007_networks.sql` adds a `network TEXT NOT NULL DEFAULT 'mainnet'`
column as the last column of `ledgers`, `transactions`, `operations`,
`accounts`, `contract_events`, `contract_schemas` and `custom_events`, and
rebuilds the keys around it:

| Table | Key after the migration |
|---|---|
| `ledgers` | `(sequence, network)` |
| `transactions` | `(hash, network)`, FK `(ledger, network)` → `ledgers` |
| `operations` | `(id, network)`, FK `(transaction_hash, network)` → `transactions` |
| `accounts` | `(address, network)` |
| `contract_events` | `(id, network)` |
| `contract_schemas` | `(contract_id, network)` |
| `custom_events` | `(event_id, event_name, network)` |

The same ledger sequence, transaction hash, operation id and account address
exist on every chain, so a single-column key would drop one network's rows the
moment the other wrote the same numbers. Composite foreign keys keep a
transaction from pointing at another network's ledger.

No new indexes were added: every existing index still covers its leading column,
so filtering by network is a filter on an indexed prefix. `db/check-schema-parity.sh`
enforces that `db/schema.sql` and `db/migrations/*.sql` stay identical.

### Existing rows

The migration's `DEFAULT 'mainnet'` backfills rows written before the
migration. If a deployment was indexing something else (a testnet-only
deployment, say), relabel once, before or right after migrating:

```sql
UPDATE ledgers              SET network = 'testnet';
UPDATE transactions         SET network = 'testnet';
UPDATE operations           SET network = 'testnet';
UPDATE accounts             SET network = 'testnet';
UPDATE contract_events      SET network = 'testnet';
UPDATE contract_schemas     SET network = 'testnet';
UPDATE custom_events        SET network = 'testnet';
```

Do it while the indexer is stopped: the resume cursor is read per network, so
rows left under the wrong label would make a network look already-indexed past
where it actually is.

## The indexer

One polling loop runs per declared network, in the same process. Each loop owns
its resume cursor, its contract-event cursor, its Horizon tip, its account
cache and its set of discovered contract ids — nothing is shared, because two
chains sharing a cursor means resuming one network's numbering from the other's.

- Every row it writes carries its network; every conflict target is the
  composite key, so re-indexing is idempotent per network.
- Resume and event cursors read `MAX(...) WHERE network = …`, so a network that
  has just been declared starts from *its own* tip rather than inheriting
  another chain's.
- `INDEXED_CONTRACT_IDS` is shared unless `<NAME>_INDEXED_CONTRACT_IDS` is set,
  since one project usually deploys different contract ids per chain.
- Registry discovery runs on the **primary** network only: one Registry
  contract lives on one chain. `REGISTRY_NETWORK_PASSPHRASE` overrides the
  passphrase used to simulate its reads, and defaults to the primary network's.
- `START_LEDGER` applies to any network whose tables are empty.

Metrics and health are per network where they have to be:

- `lumina_latest_indexed_ledger`, `lumina_latest_horizon_ledger`,
  `lumina_indexing_lag_ledgers` and `lumina_last_successful_index_timestamp_seconds`
  carry a `network` label. Two chains do not share a tip, so one unlabeled
  series would report whichever loop wrote last. Counters stay unlabeled — a
  rate summed across networks is still a rate.
- `/health` and `/ready` keep their flat numbers, and those describe **the
  network that is worst off** (never indexed, then oldest last index, then
  largest lag) so one stuck chain still degrades the service. A `networks`
  array alongside carries the detail per network.

### Custom schemas

Schemas are registered per network, because the same contract id can decode
differently on two chains:

```bash
npm run register-schema -- --network testnet apply ./transfer.schema.json
npm run register-schema -- --network testnet list
```

`--network` defaults to `NETWORK` or `mainnet`. The indexer only ever loads the
schemas for the network it is indexing.

## Notifications

The `lumina_indexed` notification carries `network` alongside `kind` and
`ledger`, so a subscriber filters before reading rows. The field survives the
payload's degradation path (Postgres caps a NOTIFY payload at 8000 bytes), and a
payload from an indexer that predates per-network notifications parses with
`network: undefined`, which the reader treats as "the one network this
deployment has".

## Not covered

- **A separate database per network.** One schema, separated by a column;
  deployments that want isolation can still run two stacks.
- **Per-network registry discovery.** One Registry, one chain: discovery runs on
  the primary network. Contracts on other chains are listed explicitly with
  `INDEXED_CONTRACT_IDS` or `<NAME>_INDEXED_CONTRACT_IDS`.
- **Names outside the `Network` enum.** A private or future network is a schema
  change first — see `graphql-server/src/schema.graphql`.
