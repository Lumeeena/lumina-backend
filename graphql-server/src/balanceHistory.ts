/**
 * Account balance history computation.
 * 
 * Derives balance over time by replaying balance-affecting operations.
 * See docs/BALANCE_HISTORY_DECISION.md for rationale.
 */

import type { Pool } from 'pg';
import { StellarAmount } from './amount';

const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

export interface BalanceSnapshot {
  timestamp: string;
  balance: string;
  operationId: string;
}

export interface BalanceHistory {
  address: string;
  asset: string;
  from: string;
  to: string;
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
    throw new Error(`Time range exceeds maximum of ${MAX_DAYS} days`);
  }
  if (fromDate >= toDate) {
    throw new Error('from must be before to');
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
     LIMIT 100`,
    [network, fromDate.toISOString(), address]
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
    throw new Error(`Invalid asset format: ${asset}. Expected CODE:ISSUER or XLM`);
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
