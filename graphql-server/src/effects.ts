/**
 * Horizon effects for the `effects` query (issue #225).
 *
 * An effect row stores Horizon's type-specific fields verbatim in `details`
 * (see db/migrations/020_effects.sql). This module turns them into the typed
 * `EffectDetails` union: each Horizon effect type maps to one detail shape,
 * types that carry no fields map to `null`, and a type this server does not
 * know yet maps to `UnrecognizedEffectDetails` with the raw JSON, so a new
 * Horizon effect type reaches clients instead of failing the whole page.
 *
 * SQL follows docs/SQL_CONSTRUCTION.md: values are bound, identifiers fixed.
 */
import type { Pool } from 'pg';
import { GraphQLError } from 'graphql';
import { ERROR_CODES } from './errorCodes';
import { cursorCondition, KEYSETS } from './pagination';

/** The detail shapes, by GraphQL type name. */
export type EffectDetailsKind =
  | 'AccountCreatedEffectDetails'
  | 'AccountBalanceEffectDetails'
  | 'ContractBalanceEffectDetails'
  | 'AccountThresholdsEffectDetails'
  | 'AccountHomeDomainEffectDetails'
  | 'AccountFlagsEffectDetails'
  | 'SignerEffectDetails'
  | 'TrustlineEffectDetails'
  | 'TrustlineAuthorizationEffectDetails'
  | 'TradeEffectDetails'
  | 'DataEffectDetails'
  | 'SequenceBumpedEffectDetails'
  | 'ClaimableBalanceEffectDetails'
  | 'SponsorshipEffectDetails'
  | 'LiquidityPoolEffectDetails';

/**
 * Every Horizon effect type this server understands, with the detail shape it
 * maps to (`null`: Horizon gives the type no fields of its own).
 *
 * The keys are Horizon's type names exactly as they appear in `effects.type`;
 * the `EffectType` GraphQL enum is these names upper-cased.
 */
export const EFFECT_TYPES: Readonly<Record<string, EffectDetailsKind | null>> = {
  account_created: 'AccountCreatedEffectDetails',
  account_removed: null,
  account_credited: 'AccountBalanceEffectDetails',
  account_debited: 'AccountBalanceEffectDetails',
  account_thresholds_updated: 'AccountThresholdsEffectDetails',
  account_home_domain_updated: 'AccountHomeDomainEffectDetails',
  account_flags_updated: 'AccountFlagsEffectDetails',
  account_inflation_destination_updated: null,
  signer_created: 'SignerEffectDetails',
  signer_removed: 'SignerEffectDetails',
  signer_updated: 'SignerEffectDetails',
  trustline_created: 'TrustlineEffectDetails',
  trustline_removed: 'TrustlineEffectDetails',
  trustline_updated: 'TrustlineEffectDetails',
  trustline_authorized: 'TrustlineAuthorizationEffectDetails',
  trustline_deauthorized: 'TrustlineAuthorizationEffectDetails',
  trustline_authorized_to_maintain_liabilities: 'TrustlineAuthorizationEffectDetails',
  trustline_flags_updated: 'TrustlineAuthorizationEffectDetails',
  offer_created: null,
  offer_removed: null,
  offer_updated: null,
  trade: 'TradeEffectDetails',
  data_created: 'DataEffectDetails',
  data_removed: 'DataEffectDetails',
  data_updated: 'DataEffectDetails',
  sequence_bumped: 'SequenceBumpedEffectDetails',
  claimable_balance_created: 'ClaimableBalanceEffectDetails',
  claimable_balance_claimant_created: 'ClaimableBalanceEffectDetails',
  claimable_balance_claimed: 'ClaimableBalanceEffectDetails',
  claimable_balance_clawed_back: 'ClaimableBalanceEffectDetails',
  account_sponsorship_created: 'SponsorshipEffectDetails',
  account_sponsorship_updated: 'SponsorshipEffectDetails',
  account_sponsorship_removed: 'SponsorshipEffectDetails',
  trustline_sponsorship_created: 'SponsorshipEffectDetails',
  trustline_sponsorship_updated: 'SponsorshipEffectDetails',
  trustline_sponsorship_removed: 'SponsorshipEffectDetails',
  data_sponsorship_created: 'SponsorshipEffectDetails',
  data_sponsorship_updated: 'SponsorshipEffectDetails',
  data_sponsorship_removed: 'SponsorshipEffectDetails',
  claimable_balance_sponsorship_created: 'SponsorshipEffectDetails',
  claimable_balance_sponsorship_updated: 'SponsorshipEffectDetails',
  claimable_balance_sponsorship_removed: 'SponsorshipEffectDetails',
  signer_sponsorship_created: 'SponsorshipEffectDetails',
  signer_sponsorship_updated: 'SponsorshipEffectDetails',
  signer_sponsorship_removed: 'SponsorshipEffectDetails',
  liquidity_pool_deposited: 'LiquidityPoolEffectDetails',
  liquidity_pool_withdrew: 'LiquidityPoolEffectDetails',
  liquidity_pool_trade: 'LiquidityPoolEffectDetails',
  liquidity_pool_created: 'LiquidityPoolEffectDetails',
  liquidity_pool_removed: 'LiquidityPoolEffectDetails',
  liquidity_pool_revoked: 'LiquidityPoolEffectDetails',
  contract_credited: 'ContractBalanceEffectDetails',
  contract_debited: 'ContractBalanceEffectDetails',
};

export interface EffectRow {
  id: string;
  paging_token: string;
  operation_id: string;
  ledger: string | number;
  account: string;
  type: string;
  type_i: number;
  created_at: Date;
  details: Record<string, unknown> | null;
  network: string;
}

type Raw = Record<string, unknown>;

/** A value Horizon sent as a string or number, as a string; null when absent. */
function str(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Horizon's `asset_type` / `asset_code` / `asset_issuer` triplet as the one
 * string the rest of the API uses: `"XLM"` for native, `"CODE:ISSUER"`
 * otherwise. Null for a pool share, which has neither code nor issuer.
 */
function tripletAsset(raw: Raw, prefix = '', issuerFallback?: string): string | null {
  const type = str(raw[`${prefix}asset_type`]);
  if (!type) return null;
  if (type === 'native') return 'XLM';
  const code = str(raw[`${prefix}asset_code`]);
  const issuer = str(raw[`${prefix}asset_issuer`]) ?? issuerFallback ?? null;
  return code && issuer ? `${code}:${issuer}` : null;
}

/** Horizon's canonical asset string (`"native"` or `"CODE:ISSUER"`), in the API's form. */
function canonicalAsset(value: unknown): string | null {
  const asset = str(value);
  if (!asset) return null;
  return asset === 'native' ? 'XLM' : asset;
}

function assetAmounts(value: unknown): { asset: string | null; amount: string | null; claimableBalanceId: string | null }[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((entry): entry is Raw => typeof entry === 'object' && entry !== null)
    .map(entry => ({
      asset: canonicalAsset(entry['asset']),
      amount: str(entry['amount']),
      claimableBalanceId: str(entry['claimable_balance_id']),
    }));
}

function assetAmount(value: unknown) {
  return typeof value === 'object' && value !== null ? assetAmounts([value])![0] : null;
}

/**
 * The typed detail object for one effect, tagged with its GraphQL type name.
 *
 * `account` is the effect's own account: Horizon leaves the issuer out of the
 * legacy trustline (de)authorization effects because it is the account the
 * effect belongs to.
 */
export function mapEffectDetails(type: string, details: Raw | null, account: string): Record<string, unknown> | null {
  const d: Raw = details ?? {};
  if (!(type in EFFECT_TYPES)) {
    return { __typename: 'UnrecognizedEffectDetails', raw: JSON.stringify(d) };
  }
  const kind = EFFECT_TYPES[type];
  if (kind === null) return null;

  const tagged = (fields: Record<string, unknown>) => ({ __typename: kind, ...fields });

  switch (kind) {
    case 'AccountCreatedEffectDetails':
      return tagged({ startingBalance: str(d['starting_balance']) });
    case 'AccountBalanceEffectDetails':
      return tagged({ amount: str(d['amount']), asset: tripletAsset(d) });
    case 'ContractBalanceEffectDetails':
      return tagged({ contract: str(d['contract']), amount: str(d['amount']), asset: tripletAsset(d) });
    case 'AccountThresholdsEffectDetails':
      return tagged({
        lowThreshold: int(d['low_threshold']),
        medThreshold: int(d['med_threshold']),
        highThreshold: int(d['high_threshold']),
      });
    case 'AccountHomeDomainEffectDetails':
      return tagged({ homeDomain: str(d['home_domain']) });
    case 'AccountFlagsEffectDetails':
      return tagged({
        authRequired: bool(d['auth_required_flag']),
        // Horizon spells it "revokable".
        authRevocable: bool(d['auth_revokable_flag'] ?? d['auth_revocable_flag']),
        authImmutable: bool(d['auth_immutable_flag']),
        authClawbackEnabled: bool(d['auth_clawback_enabled_flag']),
      });
    case 'SignerEffectDetails':
      return tagged({ publicKey: str(d['public_key']), key: str(d['key']), weight: int(d['weight']) });
    case 'TrustlineEffectDetails':
      return tagged({
        asset: tripletAsset(d),
        limit: str(d['limit']),
        liquidityPoolId: str(d['liquidity_pool_id']),
      });
    case 'TrustlineAuthorizationEffectDetails': {
      // The legacy effects say what changed through their type alone;
      // trustline_flags_updated carries the flags it set.
      const implied: Record<string, boolean | null> = {
        trustline_authorized: true,
        trustline_deauthorized: false,
      };
      return tagged({
        trustor: str(d['trustor']),
        asset: tripletAsset(d, '', account),
        authorized: type in implied ? implied[type] : bool(d['authorized_flag']),
        authorizedToMaintainLiabilities:
          type === 'trustline_authorized_to_maintain_liabilities'
            ? true
            : // Horizon spells it "liabilites".
              bool(d['authorized_to_maintain_liabilites_flag'] ?? d['authorized_to_maintain_liabilities_flag']),
        clawbackEnabled: bool(d['clawback_enabled_flag']),
      });
    }
    case 'TradeEffectDetails':
      return tagged({
        seller: str(d['seller']),
        offerId: str(d['offer_id']),
        soldAmount: str(d['sold_amount']),
        soldAsset: tripletAsset(d, 'sold_'),
        boughtAmount: str(d['bought_amount']),
        boughtAsset: tripletAsset(d, 'bought_'),
      });
    case 'DataEffectDetails':
      return tagged({ name: str(d['name']), value: str(d['value']) });
    case 'SequenceBumpedEffectDetails':
      return tagged({ newSequence: str(d['new_seq']) });
    case 'ClaimableBalanceEffectDetails':
      return tagged({
        balanceId: str(d['balance_id']),
        asset: canonicalAsset(d['asset']),
        amount: str(d['amount']),
        predicate: d['predicate'] === undefined ? null : JSON.stringify(d['predicate']),
      });
    case 'SponsorshipEffectDetails':
      return tagged({
        sponsor: str(d['sponsor']),
        formerSponsor: str(d['former_sponsor']),
        newSponsor: str(d['new_sponsor']),
        signer: str(d['signer']),
        dataName: str(d['data_name']),
        asset: canonicalAsset(d['asset']),
        liquidityPoolId: str(d['liquidity_pool_id']),
        balanceId: str(d['balance_id']),
      });
    case 'LiquidityPoolEffectDetails': {
      const pool = typeof d['liquidity_pool'] === 'object' && d['liquidity_pool'] !== null ? (d['liquidity_pool'] as Raw) : null;
      return tagged({
        liquidityPoolId: str(pool?.['id']) ?? str(d['liquidity_pool_id']),
        feeBp: int(pool?.['fee_bp']),
        totalShares: str(pool?.['total_shares']),
        totalTrustlines: str(pool?.['total_trustlines']),
        reserves: assetAmounts(pool?.['reserves']),
        reservesDeposited: assetAmounts(d['reserves_deposited']),
        reservesReceived: assetAmounts(d['reserves_received']),
        reservesRevoked: assetAmounts(d['reserves_revoked']),
        sharesReceived: str(d['shares_received']),
        sharesRedeemed: str(d['shares_redeemed']),
        sharesRevoked: str(d['shares_revoked']),
        sold: assetAmount(d['sold']),
        bought: assetAmount(d['bought']),
      });
    }
  }
}

export function mapEffect(row: EffectRow) {
  return {
    network: row.network,
    id: row.id,
    pagingToken: row.paging_token,
    operationId: row.operation_id,
    ledger: Number(row.ledger),
    account: row.account,
    type: row.type,
    typeId: row.type_i,
    createdAt: row.created_at.toISOString(),
    details: mapEffectDetails(row.type, row.details, row.account),
  };
}

export type Effect = ReturnType<typeof mapEffect>;

const EFFECT_COLUMNS = 'id, paging_token, operation_id, ledger, account, type, type_i, created_at, details, network';

export interface EffectFilter {
  network: string;
  account: string;
  /** Horizon's effect type name (lower-case), e.g. `account_credited`. */
  type?: string | null;
  limit: number;
  cursor?: string | null;
}

/**
 * One page of an account's effects, newest first, resumed by `(ledger, id)`.
 *
 * Served by `idx_effects_account` / `idx_effects_account_type`.
 */
export async function getEffects(pool: Pick<Pool, 'query'>, filter: EffectFilter): Promise<Effect[]> {
  if (!filter.account.trim()) {
    throw new GraphQLError('`account` must be a non-empty address.', {
      extensions: { code: ERROR_CODES.BAD_USER_INPUT },
    });
  }
  const params: unknown[] = [filter.network, filter.account];
  const conditions = ['network = $1', 'account = $2'];
  if (filter.type) {
    params.push(filter.type);
    conditions.push(`type = $${params.length}`);
  }
  const cursor = cursorCondition(params, KEYSETS.effects, filter.cursor);
  if (cursor) conditions.push(cursor);
  params.push(filter.limit);
  const { rows } = await pool.query<EffectRow>(
    `SELECT ${EFFECT_COLUMNS} FROM effects WHERE ${conditions.join(' AND ')} ORDER BY ledger DESC, id DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(mapEffect);
}
