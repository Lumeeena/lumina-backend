/**
 * Claimable balances for the `claimableBalances` query (issue #224).
 *
 * The question a client asks is "what can this account claim right now", so a
 * claimant's predicate is evaluated here rather than handed back raw. Stellar
 * Core evaluates it against the close time of the ledger the claim lands in;
 * this evaluates it against the time of the request (`evaluatedAt`), the
 * closest a read can get to "the next ledger".
 *
 * SQL follows docs/SQL_CONSTRUCTION.md: values are bound, identifiers fixed.
 */
import type { Pool } from 'pg';
import { GraphQLError } from 'graphql';
import { ERROR_CODES } from './errorCodes';
import { cursorCondition, KEYSETS } from './pagination';

/**
 * A claim predicate as Horizon reports it: `{ unconditional: true }`,
 * `{ abs_before: <RFC 3339> }` (with `abs_before_epoch`), `{ rel_before:
 * <seconds> }`, or `and` / `or` / `not` over nested predicates.
 */
export type ClaimPredicate = Record<string, unknown>;

/**
 * Whether `predicate` holds at `at`, for a balance created at `createdAt`.
 *
 * `rel_before` is relative to the creation ledger's close time: Core turns it
 * into an absolute deadline when the balance is created. Returns null for a
 * predicate this cannot read, so a malformed one is reported as unknown
 * rather than guessed at.
 */
export function evaluatePredicate(predicate: unknown, createdAt: Date, at: Date): boolean | null {
  if (typeof predicate !== 'object' || predicate === null || Array.isArray(predicate)) return null;
  const p = predicate as ClaimPredicate;

  if (p['unconditional'] === true) return true;

  if (p['and'] !== undefined || p['or'] !== undefined) {
    const parts = (p['and'] ?? p['or']) as unknown;
    if (!Array.isArray(parts) || parts.length === 0) return null;
    const results = parts.map(part => evaluatePredicate(part, createdAt, at));
    if (p['and'] !== undefined) {
      if (results.includes(false)) return false;
      return results.includes(null) ? null : true;
    }
    if (results.includes(true)) return true;
    return results.includes(null) ? null : false;
  }

  if (p['not'] !== undefined) {
    const inner = evaluatePredicate(p['not'], createdAt, at);
    return inner === null ? null : !inner;
  }

  const deadline = predicateDeadline(p, createdAt);
  if (deadline === undefined) return null;
  return at.getTime() < deadline.getTime();
}

/** The absolute deadline of a time predicate; undefined when it is not one. */
function predicateDeadline(p: ClaimPredicate, createdAt: Date): Date | undefined {
  if (p['abs_before_epoch'] !== undefined) {
    const seconds = Number(p['abs_before_epoch']);
    if (Number.isFinite(seconds)) return new Date(seconds * 1000);
  }
  if (typeof p['abs_before'] === 'string') {
    const parsed = Date.parse(p['abs_before']);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  if (p['rel_before'] !== undefined) {
    const seconds = Number(p['rel_before']);
    if (Number.isFinite(seconds)) return new Date(createdAt.getTime() + seconds * 1000);
  }
  return undefined;
}

/** `"native"` as the API spells it everywhere else. */
function apiAsset(stored: string): string {
  return stored === 'native' ? 'XLM' : stored;
}

/** The API's asset string as the indexer stores it. */
function storedAsset(asset: string): string {
  return asset === 'XLM' || asset === 'native' ? 'native' : asset;
}

export interface ClaimableBalanceRow {
  balance_id: string;
  asset: string;
  amount: string;
  sponsor: string | null;
  claimants: { destination?: string; predicate?: unknown }[] | null;
  status: string;
  claimed_by: string | null;
  claimed_at: Date | null;
  claimed_ledger: string | number | null;
  created_ledger: string | number;
  created_at: Date;
  network: string;
}

/**
 * A balance with its claimability resolved at `at`.
 *
 * A balance that has left the ledger (claimed or clawed back) is claimable by
 * nobody, whatever its predicates say.
 */
export function mapClaimableBalance(row: ClaimableBalanceRow, at: Date, claimant?: string | null) {
  const open = row.status === 'unclaimed';
  const claimants = (row.claimants ?? []).map(entry => {
    const evaluated = evaluatePredicate(entry.predicate ?? null, row.created_at, at);
    return {
      destination: entry.destination ?? '',
      predicate: JSON.stringify(entry.predicate ?? null),
      claimableNow: open ? evaluated : false,
    };
  });
  const forClaimant = claimant ? claimants.find(entry => entry.destination === claimant) : undefined;
  return {
    network: row.network,
    id: row.balance_id,
    asset: apiAsset(row.asset),
    amount: row.amount,
    sponsor: row.sponsor,
    status: row.status.toUpperCase(),
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at ? row.claimed_at.toISOString() : null,
    claimedLedger: row.claimed_ledger === null ? null : Number(row.claimed_ledger),
    createdLedger: Number(row.created_ledger),
    createdAt: row.created_at.toISOString(),
    claimants,
    // With a claimant filter: whether *that* account can claim it now. Without
    // one: whether anyone can.
    claimableNow: forClaimant
      ? forClaimant.claimableNow
      : claimant
        ? false
        : claimants.some(entry => entry.claimableNow === true)
          ? true
          : claimants.some(entry => entry.claimableNow === null)
            ? null
            : false,
  };
}

export type ClaimableBalance = ReturnType<typeof mapClaimableBalance>;

const COLUMNS =
  'balance_id, asset, amount, sponsor, claimants, status, claimed_by, claimed_at, claimed_ledger, created_ledger, created_at, network';

export interface ClaimableBalanceFilter {
  network: string;
  /** Balances this account is a claimant of. */
  claimant?: string | null;
  sponsor?: string | null;
  /** `"XLM"` or `"CODE:ISSUER"`. */
  asset?: string | null;
  /** Include balances that have been claimed or clawed back. */
  includeClaimed?: boolean | null;
  limit: number;
  cursor?: string | null;
  /** Time predicates are evaluated against; the request time by default. */
  at?: Date;
}

/**
 * One page of claimable balances, newest first, resumed by
 * `(created_ledger, balance_id)`.
 *
 * At least one of `claimant`, `sponsor` or `asset` is required: each is served
 * by an index, and the whole table in creation order is not a question any
 * client asks.
 */
export async function getClaimableBalances(
  pool: Pick<Pool, 'query'>,
  filter: ClaimableBalanceFilter
): Promise<{ items: ClaimableBalance[]; evaluatedAt: string }> {
  const claimant = filter.claimant?.trim() || null;
  const sponsor = filter.sponsor?.trim() || null;
  const asset = filter.asset?.trim() || null;
  if (!claimant && !sponsor && !asset) {
    throw new GraphQLError('Pass at least one of `claimant`, `sponsor` or `asset`.', {
      extensions: { code: ERROR_CODES.BAD_USER_INPUT },
    });
  }

  const params: unknown[] = [filter.network];
  const conditions = ['network = $1'];
  if (claimant) {
    params.push(claimant);
    conditions.push(
      `EXISTS (SELECT 1 FROM claimable_balance_claimants c WHERE c.destination = $${params.length} ` +
        'AND c.network = claimable_balances.network AND c.balance_id = claimable_balances.balance_id)'
    );
  }
  if (sponsor) {
    params.push(sponsor);
    conditions.push(`sponsor = $${params.length}`);
  }
  if (asset) {
    params.push(storedAsset(asset));
    conditions.push(`asset = $${params.length}`);
  }
  if (!filter.includeClaimed) conditions.push(`status = 'unclaimed'`);
  const cursor = cursorCondition(params, KEYSETS.claimableBalances, filter.cursor);
  if (cursor) conditions.push(cursor);
  params.push(filter.limit);

  const { rows } = await pool.query<ClaimableBalanceRow>(
    `SELECT ${COLUMNS} FROM claimable_balances WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY created_ledger DESC, balance_id DESC LIMIT $${params.length}`,
    params
  );
  const at = filter.at ?? new Date();
  return { items: rows.map(row => mapClaimableBalance(row, at, claimant)), evaluatedAt: at.toISOString() };
}
