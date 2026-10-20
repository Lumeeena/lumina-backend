# Asset Issuer Metadata and Lookalike Detection

This document describes the asset issuer metadata resolution and lookalike asset flagging features.

## Asset Issuer Home Domain (#257)

Assets on Stellar are identified by a code and issuer address (e.g., `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`). The issuer address tells users nothing about who issued the asset, which is precisely the information needed to distinguish a real asset from an impostor.

### Implementation

The `assets` table now includes:

- `issuer_home_domain`: The issuer's home domain as published in their Stellar account settings
- `issuer_metadata`: Self-declared asset metadata from the issuer's `stellar.toml` file
- Indexes for efficient querying by issuer domain

### Fetching Metadata

The indexer can fetch issuer metadata through:

1. **Account Home Domain**: Query the issuer's Stellar account for their `home_domain` field
2. **Stellar.toml**: Fetch `https://domain/.well-known/stellar.toml` to get self-declared asset metadata

### Important Note

The metadata is **self-declared**, not verified. It represents what the issuer claims about their asset, not a third-party certification. This should be clearly communicated to users.

## Lookalike Asset Flagging (#258)

Any issuer can mint an asset with any code. An explorer that lists `USDC` from an unknown issuer beside the real one, with no distinction, actively helps the impostor.

### Implementation

The `assets` table includes:

- `is_lookalike`: Boolean flag indicating if the asset's code matches a well-known asset but has a different issuer
- Index for efficient querying of flagged assets

### Well-Known Assets List

The current well-known asset list is maintained in `indexer/src/assetIssuer.ts`:

```typescript
export const WELL_KNOWN_ASSETS = [
  { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
  { code: 'USDT', issuer: 'GAP5LETOVG6HDAZ2TJQOUCP6KBXJLZJQ2LMGYRJQ5HWEK4RRO7XTNQ' },
  { code: 'EURT', issuer: 'GAP5LETOVG6HDAZ2TJQOUCP6KBXJLZJQ2LMGYRJQ5HWEK4RRO7XTNQ' },
  { code: 'ETH', issuer: 'GBXUQ4JCNZQ7HXBVJO4SDIIM4MOT4JZGKQWZV7DRO6IJIHLGEEBG7YX' },
  { code: 'BTC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
];
```

### Maintenance

The well-known list should be:

1. **Auditable**: Clearly documented who decides which assets are "well-known"
2. **Maintained**: Updated as new major assets launch on Stellar
3. **Governed**: Ideally managed through a governance process or community consensus

### Flagging Strategy

We **flag** lookalike assets rather than hiding them because:

- Hiding is its own failure mode (users can't see what's being filtered)
- Flagging provides transparency about potential issues
- Users can make informed decisions
- False positives are less harmful with flagging than with hiding

### GraphQL API

The `Asset` type now includes:

```graphql
type Asset {
  code: String!
  issuer: String!
  holderCount: Int!
  firstSeenLedger: Int!
  lastActivityLedger: Int!
  recentVolume: String
  issuerHomeDomain: String
  issuerMetadata: String
  isLookalike: Boolean
}
```

## Usage

### Flagging Lookalike Assets

Run the flagging function periodically:

```typescript
import { flagLookalikeAssets } from './assetIssuer';

await flagLookalikeAssets(pool, 'mainnet');
```

### Updating Issuer Metadata

```typescript
import { updateIssuerMetadata } from './assetIssuer';

await updateIssuerMetadata(pool, 'mainnet', 'USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
```

## Future Enhancements

1. **Automatic Fetching**: Integrate issuer metadata fetching into the account indexing process
2. **Verified Metadata**: Add a verification mechanism for trusted issuers
3. **Community Curated List**: Allow the community to propose additions to the well-known list
4. **Risk Scoring**: Assign risk scores based on multiple factors (age, volume, issuer reputation)
