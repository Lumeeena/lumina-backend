/**
 * The contract between the indexer and the GraphQL server over
 * `operations.details`.
 *
 * The indexer writes `details` as Horizon's operation record, whole
 * (indexer/src/db.ts, `JSON.stringify(op)`). The server reads named keys out of
 * it — to project an `Operation`, to filter by account or asset, to replay a
 * balance. Nothing else ties the two together: no type, no column, no
 * migration. This file is the tie, and docs/OPERATIONS_DETAILS_CONTRACT.md is
 * its prose. The test beside it fails when either side stops honouring it.
 */

/** A Horizon operation record, as stored in `details`. */
export type HorizonOperation = Record<string, unknown> & { id: string; type: string };

/** Every key the server reads out of `details`, and what reads it. */
export const DETAILS_KEYS: Record<string, readonly string[]> = {
  from: ['Operation.from', 'accountActivity replay', 'accountBalanceHistory'],
  to: ['Operation.to', 'accountActivity replay', 'accountBalanceHistory'],
  amount: ['Operation.amount', 'asset volume series', 'accountBalanceHistory'],
  asset_type: ['Operation.asset', 'operations(asset:)', 'asset volume series', 'accountBalanceHistory'],
  asset_code: ['Operation.asset', 'operations(asset:)', 'asset volume series', 'accountBalanceHistory'],
  asset_issuer: ['Operation.asset', 'operations(asset:)', 'asset volume series', 'accountBalanceHistory'],
  starting_balance: ['Operation.startingBalance', 'accountBalanceHistory'],
  funder: ['Operation.funder', 'accountActivity replay', 'accountBalanceHistory'],
  account: ['Operation.createdAccount', 'accountLifecycle', 'accountActivity replay', 'accountBalanceHistory'],
  into: ['Operation.mergeDestination', 'accountBalanceHistory'],
  offer_id: ['Operation.offerId'],
  price: ['Operation.price'],
  selling_asset_type: ['Operation.selling', 'operations(asset:)', 'asset volume series'],
  selling_asset_code: ['Operation.selling', 'operations(asset:)', 'asset volume series'],
  selling_asset_issuer: ['Operation.selling', 'operations(asset:)', 'asset volume series'],
  buying_asset_type: ['Operation.buying', 'operations(asset:)', 'asset volume series'],
  buying_asset_code: ['Operation.buying', 'operations(asset:)', 'asset volume series'],
  buying_asset_issuer: ['Operation.buying', 'operations(asset:)', 'asset volume series'],
  source_asset_type: ['accountBalanceHistory'],
  source_asset_code: ['accountBalanceHistory'],
  source_asset_issuer: ['accountBalanceHistory'],
  source_amount: ['accountBalanceHistory'],
  bump_to: ['Operation.bumpSequence'],
  name: ['Operation.dataName'],
  value: ['Operation.dataValue'],
};

function str(op: HorizonOperation, key: string): string | null {
  const value = op[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The API's one-string form of an asset: `XLM`, or `CODE:ISSUER`. A pool share
 * has neither a code nor an issuer, so it has no such string.
 */
export function assetString(type: string | null, code: string | null, issuer: string | null): string | null {
  if (type === 'native') return 'XLM';
  if (!type || !code || !issuer) return null;
  return `${code}:${issuer}`;
}

/**
 * What each `Operation` field must be, stated from Horizon's payload. The
 * server computes the same thing from what the indexer stored; if the stored
 * shape drifts, the two disagree.
 */
export const OPERATION_FIELDS: Record<string, { keys: readonly string[]; expected: (op: HorizonOperation) => string | null }> = {
  from: { keys: ['from'], expected: op => str(op, 'from') },
  to: { keys: ['to'], expected: op => str(op, 'to') },
  amount: { keys: ['amount'], expected: op => str(op, 'amount') },
  asset: {
    keys: ['asset_type', 'asset_code', 'asset_issuer'],
    expected: op => assetString(str(op, 'asset_type'), str(op, 'asset_code'), str(op, 'asset_issuer')),
  },
  startingBalance: { keys: ['starting_balance'], expected: op => str(op, 'starting_balance') },
  funder: { keys: ['funder'], expected: op => str(op, 'funder') },
  createdAccount: { keys: ['account'], expected: op => (op.type === 'create_account' ? str(op, 'account') : null) },
  mergeDestination: { keys: ['into'], expected: op => (op.type === 'account_merge' ? str(op, 'into') : null) },
  offerId: { keys: ['offer_id'], expected: op => str(op, 'offer_id') },
  price: { keys: ['price'], expected: op => str(op, 'price') },
  selling: {
    keys: ['selling_asset_type', 'selling_asset_code', 'selling_asset_issuer'],
    expected: op => assetString(str(op, 'selling_asset_type'), str(op, 'selling_asset_code'), str(op, 'selling_asset_issuer')),
  },
  buying: {
    keys: ['buying_asset_type', 'buying_asset_code', 'buying_asset_issuer'],
    expected: op => assetString(str(op, 'buying_asset_type'), str(op, 'buying_asset_code'), str(op, 'buying_asset_issuer')),
  },
  bumpSequence: { keys: ['bump_to'], expected: op => (op.type === 'bump_sequence' ? str(op, 'bump_to') : null) },
  dataName: { keys: ['name'], expected: op => (op.type === 'manage_data' ? str(op, 'name') : null) },
  dataValue: { keys: ['value'], expected: op => (op.type === 'manage_data' ? str(op, 'value') : null) },
};

/** The accounts an operation touches, by the key that names each; what the replay matches on. */
export const ACCOUNT_KEYS = ['from', 'to', 'account', 'funder'] as const;

/** The roles an asset can play on an operation; what `operations(asset:)` and the volume series match on. */
export const ASSET_ROLES = [
  ['asset_type', 'asset_code', 'asset_issuer'],
  ['selling_asset_type', 'selling_asset_code', 'selling_asset_issuer'],
  ['buying_asset_type', 'buying_asset_code', 'buying_asset_issuer'],
] as const;

/** Each asset an operation carries, in the API's string form. */
export function assetsOf(op: HorizonOperation): string[] {
  const out = new Set<string>();
  for (const [type, code, issuer] of ASSET_ROLES) {
    const asset = assetString(str(op, type), str(op, code), str(op, issuer));
    if (asset) out.add(asset);
  }
  return [...out];
}
