/**
 * Account balance history computation.
 *
 * Derives an account's historical asset balance over a requested time window by
 * replaying balance-affecting operations from the partitioned `operations` table.
 * This exists instead of storing periodic balance snapshots so that we avoid
 * linear storage growth per account and retain exact operation-level temporal
 * resolution without backfills.
 *
 * See docs/BALANCE_HISTORY_DECISION.md for the full architectural rationale.
 */

import type { Pool } from 'pg';
import { StellarAmount } from './amount';
import { InvalidInputError } from './errorCodes';

/**
 * Maximum query window in days.
 * Capped at 90 days to bound operation-replay query cost and prevent
 * unbounded scans on high-volume accounts (see docs/BALANCE_HISTORY_DECISION.md).
 */
const MAX_DAYS = 90;

/**
 * Default lookback window in days when `from` is omitted.
 * 30 days provides a useful portfolio chart window while keeping replay cost low.
 */
const DEFAULT_DAYS = 30;

/**
 * Maximum number of pre-window operations replayed to establish the starting
 * balance at `from`. Bounds the anchor query when no checkpoint table is used.
 */
const PRIOR_OPS_LIMIT = 100;

/**
 * A single point in an account's balance timeline.
 */
export interface BalanceSnapshot {
  /** ISO-8601 timestamp of the operation (or window start for `'initial'`). */
  timestamp: string;
  /** Canonical decimal string balance after the operation (e.g. `'100.5'`). */
  balance: string;
  /** ID of the operation that caused the change, or `'initial'` for the window-start anchor. */
  operationId: string;
}

/**
 * Computed balance history for an account and asset over `[from, to]`.
 */
export interface BalanceHistory {
  /** Stellar account public key (G...). */
  address: string;
  /** Requested asset identifier (`'XLM'`, `'native'`, or `'CODE:ISSUER'`). */
  asset: string;
  /** Inclusive window start timestamp (ISO-8601). */
  from: string;
  /** Inclusive window end timestamp (ISO-8601). */
  to: string;
  /** Chronological list of snapshots where the balance changed, plus optional `'initial'`. */
  snapshots: BalanceSnapshot[];
}

interface OperationRow {
  id: string;
  type: string;
  created_at: string;
  source_account: string;
  details: Record<string, unknown>;
}

/**
 * Compute balance history for an account and asset by replaying operations.
 *
 * Non-obvious behaviour:
 * - Defaults `to` to now and `from` to `DEFAULT_DAYS` (30) earlier; rejects
 *   ranges where `from >= to` or the span exceeds `MAX_DAYS` (90) with
 *   `InvalidInputError`.
 * - Establishes a starting balance by replaying up to `PRIOR_OPS_LIMIT` (100)
 *   operations strictly before `from` (queried `DESC` and reversed).
 * - Emits an `'initial'` snapshot at `from` only if there are in-range
 *   operations or the starting balance is positive, then emits a snapshot only
 *   for operations that actually change the target asset's balance (using exact
 *   fixed-point `StellarAmount` arithmetic).
 * - For `account_merge`, the source account's native balance is zeroed, but the
 *   destination (`into`) balance is left unchanged because the merged amount is
 *   not recorded on the operation row.
 */
export async function computeBalanceHistory(
  pool: Pool,
  network: string,
  address: string,
  asset: string,
  from?: string | null,
  to?: string | null
): Promise<BalanceHistory> {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);

  // Validate time range
  const daysDiff = (toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
  if (daysDiff > MAX_DAYS) {
    throw new InvalidInputError(`Time range exceeds maximum of ${MAX_DAYS} days`);
  }
  if (fromDate >= toDate) {
    throw new InvalidInputError('from must be before to');
  }

  const { code, issuer } = parseAsset(asset);

  // Fetch balance-affecting operations in time range
  const { rows } = await pool.query<OperationRow>(
    `SELECT id, type, created_at, source_account, details
     FROM operations
     WHERE network = $1
       AND created_at >= $2
       AND created_at <= $3
       AND (
         source_account = $4
         OR details->>'from' = $4
         OR details->>'to' = $4
         OR details->>'funder' = $4
         OR details->>'account' = $4
       )
       AND type IN (
         'create_account',
         'payment',
         'path_payment_strict_send',
         'path_payment_strict_receive',
         'account_merge',
         'change_trust'
       )
     ORDER BY created_at ASC, id ASC`,
    [network, fromDate.toISOString(), toDate.toISOString(), address]
  );

  // Get starting balance (from most recent operation before range)
  let balance = StellarAmount.ZERO;
  const { rows: beforeRows } = await pool.query<OperationRow>(
    `SELECT id, type, created_at, source_account, details
     FROM operations
     WHERE network = $1
       AND created_at < $2
       AND (
         source_account = $3
         OR details->>'from' = $3
         OR details->>'to' = $3
         OR details->>'funder' = $3
         OR details->>'account' = $3
       )
       AND type IN (
         'create_account',
         'payment',
         'path_payment_strict_send',
         'path_payment_strict_receive',
         'account_merge',
         'change_trust'
       )
     ORDER BY created_at DESC, id DESC
     LIMIT $4`,
    [network, fromDate.toISOString(), address, PRIOR_OPS_LIMIT]
  );

  // Replay operations before the range to establish starting balance
  for (const op of beforeRows.reverse()) {
    balance = applyOperation(op, address, code, issuer, balance);
  }

  const snapshots: BalanceSnapshot[] = [];

  // Add initial snapshot at range start
  if (rows.length > 0 || balance.isPositive()) {
    snapshots.push({
      timestamp: fromDate.toISOString(),
      balance: balance.toFixed(),
      operationId: 'initial',
    });
  }

  // Replay operations in range
  for (const op of rows) {
    const oldBalance = balance;
    balance = applyOperation(op, address, code, issuer, balance);

    // Only add snapshot if balance changed for this asset
    if (!balance.equals(oldBalance)) {
      snapshots.push({
        timestamp: op.created_at,
        balance: balance.toFixed(),
        operationId: op.id,
      });
    }
  }

  return {
    address,
    asset,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    snapshots,
  };
}

/**
 * Parse asset string into code and issuer.
 */
function parseAsset(asset: string): { code: string | null; issuer: string | null } {
  if (asset === 'XLM' || asset === 'native') {
    return { code: null, issuer: null };
  }
  const parts = asset.split(':');
  if (parts.length !== 2) {
    throw new InvalidInputError(`Invalid asset format: ${asset}. Expected CODE:ISSUER or XLM`);
  }
  return { code: parts[0], issuer: parts[1] };
}

/**
 * Check if operation affects the given asset.
 */
function matchesAsset(
  details: Record<string, unknown>,
  targetCode: string | null,
  targetIssuer: string | null
): boolean {
  const assetType = details.asset_type as string | undefined;
  const assetCode = details.asset_code as string | undefined;
  const assetIssuer = details.asset_issuer as string | undefined;

  // Native asset
  if (targetCode === null && targetIssuer === null) {
    return assetType === 'native' || assetType === undefined;
  }

  // Custom asset
  return assetCode === targetCode && assetIssuer === targetIssuer;
}

/**
 * Apply an operation to the balance.
 */
function applyOperation(
  op: OperationRow,
  address: string,
  code: string | null,
  issuer: string | null,
  currentBalance: StellarAmount
): StellarAmount {
  const { type, details } = op;

  switch (type) {
    case 'create_account': {
      if (details.account === address && code === null && issuer === null) {
        const startingBalance = details.starting_balance as string;
        return currentBalance.plus(StellarAmount.from(startingBalance));
      }
      if (details.funder === address && code === null && issuer === null) {
        const startingBalance = details.starting_balance as string;
        return currentBalance.minus(StellarAmount.from(startingBalance));
      }
      return currentBalance;
    }

    case 'payment': {
      if (!matchesAsset(details, code, issuer)) return currentBalance;
      const amount = StellarAmount.from(details.amount as string);
      if (details.to === address) {
        return currentBalance.plus(amount);
      }
      if (details.from === address) {
        return currentBalance.minus(amount);
      }
      return currentBalance;
    }

    case 'path_payment_strict_send':
    case 'path_payment_strict_receive': {
      // Source asset
      if (
        details.source_asset_type &&
        matchesAsset(
          {
            asset_type: details.source_asset_type,
            asset_code: details.source_asset_code,
            asset_issuer: details.source_asset_issuer,
          },
          code,
          issuer
        ) &&
        details.from === address
      ) {
        return currentBalance.minus(StellarAmount.from(details.source_amount as string));
      }

      // Destination asset
      if (
        matchesAsset(details, code, issuer) &&
        details.to === address
      ) {
        return currentBalance.plus(StellarAmount.from(details.amount as string));
      }

      return currentBalance;
    }

    case 'account_merge': {
      // Only affects native asset
      if (code !== null || issuer !== null) return currentBalance;
      
      // Destination receives the merged account's balance
      if (details.into === address) {
        // We don't know the exact amount without querying the account state
        // This is a limitation of the operation replay approach
        return currentBalance;
      }
      
      // Source account balance goes to zero
      if (op.source_account === address) {
        return StellarAmount.ZERO;
      }
      
      return currentBalance;
    }

    case 'change_trust': {
      // Creating a trustline doesn't change balance
      // Removing a trustline requires zero balance, so no change
      return currentBalance;
    }

    default:
      return currentBalance;
  }
}
