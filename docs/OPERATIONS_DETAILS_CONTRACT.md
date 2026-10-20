# The `operations.details` contract

The indexer and the GraphQL server share one table, `operations`, and agree
about most of it through its columns. They also share a column whose shape no
schema describes: `details`, a JSONB value the indexer fills and the server
reads named keys out of. This document is that agreement, written down.
`test/contract/` enforces it.

- [What is written](#what-is-written)
- [What is read](#what-is-read)
- [The keys](#the-keys)
- [Changing either side](#changing-either-side)
- [How it is tested](#how-it-is-tested)
- [Known gaps](#known-gaps)

## What is written

`indexLedger` (`indexer/src/db.ts`) stores each operation exactly as Horizon
returned it from `/ledgers/{sequence}/operations`: `details` is
`JSON.stringify(op)`, every field included (`_links` and the muxed-account
fields too). The indexer does not rename, drop, or re-encode anything, and
nothing in it says which keys matter. The shape is Horizon's, it varies by
operation type, and within a type it varies again: a native and a credit
payment carry different keys, and so do a trustline to an asset and a trustline
to a liquidity pool share.

## What is read

The server reads `details` in six places. Each reads by key name, so each is
coupled to Horizon's naming through the indexer:

| Reader | Where | What it does with `details` |
| --- | --- | --- |
| `Operation` fields | `OPERATION_COLUMNS`, `mapOperation` in `graphql-server/src/db.ts` | projects named keys with `jsonb_build_object`, maps them to GraphQL fields |
| `operations(asset:)` | `assetConditions` in `graphql-server/src/search.ts` | `details->>'…' = $n` across three asset roles |
| asset volume series | `getAssetVolumeSeries` in `graphql-server/src/assets.ts` | sums `details->>'amount'` under the same asset filter |
| `accountActivity` replay | `getAccountOperationsInLedger` in `graphql-server/src/db.ts` | matches an address against four keys |
| `accountLifecycle` | `getAccountLifecycle` in `graphql-server/src/db.ts` | containment, `details @> {"account": …}` |
| `accountBalanceHistory` | `graphql-server/src/balanceHistory.ts` | filters on four keys, then replays amounts and assets in TypeScript |

## The keys

Every key the server reads. "Carried by" is what mainnet actually sent: the
operation types that had the key across the mainnet ledgers the fixtures
were recorded from (see below), not what Horizon's documentation promises.

| Key | Carried by | Read by |
| --- | --- | --- |
| `from` | `payment`, `path_payment_strict_send`, `path_payment_strict_receive`, `clawback` | `Operation.from`, `accountActivity` replay, `accountBalanceHistory` |
| `to` | `payment`, `path_payment_strict_send`, `path_payment_strict_receive` | `Operation.to`, `accountActivity` replay, `accountBalanceHistory` |
| `amount` | payments, path payments, `manage_sell_offer`, `manage_buy_offer`, `create_claimable_balance`, `clawback` | `Operation.amount`, asset volume series, `accountBalanceHistory` |
| `asset_type` | payments, path payments (destination), `change_trust`, `allow_trust`, `set_trust_line_flags`, `clawback` | `Operation.asset`, `operations(asset:)`, asset volume series, `accountBalanceHistory` |
| `asset_code` | as `asset_type`, except native assets and pool shares | as `asset_type` |
| `asset_issuer` | as `asset_code` | as `asset_type` |
| `starting_balance` | `create_account` | `Operation.startingBalance`, `accountBalanceHistory` |
| `funder` | `create_account` | `Operation.funder`, `accountActivity` replay, `accountBalanceHistory` |
| `account` | `create_account` (the new account), `account_merge` (the merged one) | `Operation.createdAccount`, `accountLifecycle`, `accountActivity` replay, `accountBalanceHistory` |
| `into` | `account_merge` | `Operation.mergeDestination`, `accountBalanceHistory` |
| `offer_id` | `manage_sell_offer`, `manage_buy_offer` | `Operation.offerId` |
| `price` | `manage_sell_offer`, `manage_buy_offer` | `Operation.price` |
| `selling_asset_type` | `manage_sell_offer`, `manage_buy_offer` | `Operation.selling`, `operations(asset:)`, asset volume series |
| `selling_asset_code` | as `selling_asset_type`, except native | as `selling_asset_type` |
| `selling_asset_issuer` | as `selling_asset_code` | as `selling_asset_type` |
| `buying_asset_type` | `manage_sell_offer`, `manage_buy_offer` | `Operation.buying`, `operations(asset:)`, asset volume series |
| `buying_asset_code` | as `buying_asset_type`, except native | as `buying_asset_type` |
| `buying_asset_issuer` | as `buying_asset_code` | as `buying_asset_type` |
| `source_asset_type` | `path_payment_strict_send`, `path_payment_strict_receive` | `accountBalanceHistory` |
| `source_asset_code` | as `source_asset_type`, except native | `accountBalanceHistory` |
| `source_asset_issuer` | as `source_asset_code` | `accountBalanceHistory` |
| `source_amount` | `path_payment_strict_send`, `path_payment_strict_receive` | `accountBalanceHistory` |
| `bump_to` | `bump_sequence` | `Operation.bumpSequence` |
| `name` | `manage_data` | `Operation.dataName` |
| `value` | `manage_data` (base64; absent when the entry is deleted) | `Operation.dataValue` |

The same list is `DETAILS_KEYS` in `test/contract/contract.ts`, and a test
fails if the two disagree.

Three rules the readers rely on, which are properties of Horizon's payload
rather than of either service:

- **An asset is a triplet.** `*_asset_type` is `native`, `credit_alphanum4`,
  `credit_alphanum12` or `liquidity_pool_shares`; the code and issuer are
  present only for credit assets. The API's single `CODE:ISSUER` string is built
  from all three, and a pool share has no such string, so it is `null`.
- **Amounts are decimal strings with seven places** (`"10.0000000"`), never
  numbers and never stroops. The volume series casts them to `numeric`, and the
  balance replay parses them exactly (`graphql-server/src/amount.ts`).
- **Addresses are unmuxed `G…` strings.** A muxed payment carries `to_muxed`
  beside `to`; the readers use `to`, so a payment to a muxed account is found by
  its base account.

## Changing either side

- **The indexer** may add to what it stores, but not rename, drop, or re-encode
  a key in the table above without changing every reader of it in the same
  change. Normalising `details` (to save space, to stroops, to camelCase) is
  exactly the change this contract exists to stop going in unnoticed; the
  pruned payload proposed in
  [OPERATIONS_DETAILS_STORAGE_TUNING.md](OPERATIONS_DETAILS_STORAGE_TUNING.md)
  has to keep every key in the table above.
- **The server** may read a new key only by adding it to `DETAILS_KEYS` and to
  this table, with the operation types that carry it. The contract test reads
  the server's source for `details` reads and fails on an undeclared key.
- **A Horizon upgrade** that changes a key changes both sides at once.
  Re-record the fixtures (below) after one, and the test says which readers
  broke.

## How it is tested

`npm run test:contract` (`test/contract/operationsDetails.test.ts`), in CI as
the "Contract (indexer ↔ GraphQL)" job. It creates a database from
`db/schema.sql`, writes the fixtures through the indexer's `indexLedger`, and
reads them back through the server's own functions:

- every `Operation` field of every operation equals what Horizon's payload
  says it should be (`OPERATION_FIELDS` in `contract.ts`);
- the `accountActivity` replay finds each operation by every account key it
  carries; `accountLifecycle` finds each creation and merge;
- `operations(asset:)` finds each operation by every asset it carries, in any
  role, and the volume series sums exactly the payload amounts per asset;
- balance history moves each balance by exactly the amount Horizon reported,
  for payments, path payments and account creation;
- every `details` key read in `graphql-server/src` is declared, and every
  declared key is still read;
- this document lists exactly the declared keys.

The expectations are written from the payload, never from either service's
code. The last test proves the suite has teeth: it writes the same operations
through a deliberately incompatible writer (`from` renamed, amounts stored in
stroops) and checks the contract reports both.

**Fixtures** are one real mainnet operation per *shape* — type, set of fields,
and kind of each asset (native, credit, pool share) — with its ledger and
transaction: 64 shapes across 22 operation types, recorded on 2026-10-20 from
mainnet ledgers 65,036,379–65,040,177 (1.55 million operations). To re-record:

```bash
npm run audit:operations -- fetch 1000      # or several caches, as these were
TS_NODE_PROJECT=test/tsconfig.json node --require ts-node/register \
  test/contract/recordFixtures.ts db/audit/.cache/mainnet-ledgers.jsonl
```

## Known gaps

- **Not every operation type was on the chain in the sampled ledgers.**
  `bump_sequence`, `create_passive_sell_offer`, `revoke_sponsorship`,
  `restore_footprint` and `inflation` did not appear in those 1.55 million
  operations,
  so they have no fixture. `bump_to` is still declared and still checked by
  `mapOperation`'s unit test, but not end to end against a real payload.
- **`create_claimable_balance` reports its asset as one string** (`asset`,
  `"CODE:ISSUER"` or `"native"`) rather than a triplet, so no reader finds a
  claimable balance by asset, and `Operation.asset` is `null` for one. That is
  the current behaviour, recorded here rather than changed.
- **Found by the first run of this contract, and fixed with it:**
  `bumpSequence`, `dataName` and `dataValue` were `null` for every operation —
  their resolvers read a `details` property `mapOperation` never returned, and
  the projection did not select `bump_to`, `name` or `value` — and a pool-share
  trustline's `asset` was the string `"null:null"`.
