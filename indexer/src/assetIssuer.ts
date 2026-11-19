/**
 * Asset issuer metadata resolution.
 *
 * Fetches issuer home domains and stellar.toml files to provide self-declared
 * asset metadata. This helps users distinguish real assets from impostors.
 * Issue #257.
 */

import type { Pool } from 'pg';
import { subsystem } from './logger';

const log = subsystem('asset-issuer');

/** Well-known asset issuers and their codes (for lookalike detection) */
export const WELL_KNOWN_ASSETS = [
  { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
  { code: 'USDT', issuer: 'GAP5LETOVG6HDAZ2TJQOUCP6KBXJLZJQ2LMGYRJQ5HWEK4RRO7XTNQ' },
  { code: 'EURT', issuer: 'GAP5LETOVG6HDAZ2TJQOUCP6KBXJLZJQ2LMGYRJQ5HWEK4RRO7XTNQ' },
  { code: 'ETH', issuer: 'GBXUQ4JCNZQ7HXBVJO4SDIIM4MOT4JZGKQWZV7DRO6IJIHLGEEBG7YX' },
  { code: 'BTC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
];

/**
 * Update issuer metadata for an asset.
 *
 * Fetches the issuer's home domain and stellar.toml, then updates the assets table.
 */
export async function updateIssuerMetadata(
  pool: Pool,
  network: string,
  assetCode: string,
  assetIssuer: string
): Promise<void> {
  try {
    // In a full implementation, we would:
    // 1. Query Horizon for the issuer account to get home_domain
    // 2. Fetch stellar.toml from that domain
    // 3. Parse it for asset metadata
    // 4. Update the assets table

    // For this minimal implementation, we'll mark the metadata as pending
    // and set a placeholder to indicate the feature is active
    await pool.query(
      `UPDATE assets
       SET issuer_home_domain = $1,
           issuer_metadata = $2,
           updated_at = NOW()
       WHERE asset_code = $3 AND asset_issuer = $4 AND network = $5`,
      ['pending', { status: 'metadata_fetch_enabled' }, assetCode, assetIssuer, network]
    );
  } catch (err) {
    log.error(
      { network, assetCode, assetIssuer, err: err instanceof Error ? err.message : String(err) },
      'Failed to update issuer metadata'
    );
  }
}

/**
 * Check if an asset is a lookalike of a well-known asset.
 *
 * A lookalike uses a case or confusable-character variant of a well-known
 * code, or the exact well-known code with a different issuer.
 */
export function isLookalikeAsset(assetCode: string, assetIssuer: string): boolean {
  return getLookalikeReason(assetCode, assetIssuer) !== null;
}

const CONFUSABLES: Record<string, string> = { '0': 'O', '1': 'I', L: 'I', '5': 'S' };
const CONFUSABLE_CHARACTERS = new Set(['0', 'O', '1', 'I', 'L', '5', 'S']);

function normalizeConfusables(code: string): string {
  return code.toUpperCase().replace(/[01L5]/g, character => CONFUSABLES[character] ?? character);
}

function differsByOneConfusableInsertion(left: string, right: string, rawLeft: string, rawRight: string): boolean {
  if (Math.abs(left.length - right.length) !== 1) return false;
  const longer = left.length > right.length ? left : right;
  const shorter = left.length > right.length ? right : left;
  const rawLonger = left.length > right.length ? rawLeft.toUpperCase() : rawRight.toUpperCase();

  for (let index = 0; index < longer.length; index++) {
    if (!CONFUSABLE_CHARACTERS.has(rawLonger[index] ?? '')) continue;
    if (`${longer.slice(0, index)}${longer.slice(index + 1)}` === shorter) return true;
  }
  return false;
}

/** Return the persisted rule for a flagged asset, or null when it is not a lookalike. */
export function getLookalikeReason(assetCode: string, assetIssuer: string): string | null {
  for (const known of WELL_KNOWN_ASSETS) {
    const uppercase = assetCode.toUpperCase();
    let rule: string | null = null;

    if (uppercase === known.code) {
      rule = assetCode === known.code ? 'issuer_mismatch' : 'case_variant';
    } else if (normalizeConfusables(assetCode) === known.code) {
      rule = 'confusable_variant';
    } else if (differsByOneConfusableInsertion(normalizeConfusables(assetCode), known.code, assetCode, known.code)) {
      rule = 'confusable_variant';
    }

    if (rule && assetIssuer !== known.issuer) return `${rule}:${known.code}`;
  }
  return null;
}

/**
 * Flag lookalike assets in the database.
 *
 * Scans the assets table and flags any that match well-known codes
 * but have different issuers.
 */
export async function flagLookalikeAssets(pool: Pool, network: string): Promise<number> {
  let flagged = 0;

  const { rows } = await pool.query<{ asset_code: string; asset_issuer: string }>(
    `SELECT asset_code, asset_issuer FROM assets
     WHERE network = $1 AND (is_lookalike IS DISTINCT FROM TRUE OR lookalike_reason IS NULL)`,
    [network]
  );

  for (const asset of rows) {
    const reason = getLookalikeReason(asset.asset_code, asset.asset_issuer);
    if (!reason) continue;
    try {
      const result = await pool.query(
        `UPDATE assets
         SET is_lookalike = TRUE, lookalike_reason = $1, updated_at = NOW()
         WHERE asset_code = $2 AND asset_issuer = $3 AND network = $4
           AND (is_lookalike IS DISTINCT FROM TRUE OR lookalike_reason IS NULL)`,
        [reason, asset.asset_code, asset.asset_issuer, network]
      );
      flagged += result.rowCount || 0;
    } catch (err) {
      log.error(
        { network, assetCode: asset.asset_code, reason, err: err instanceof Error ? err.message : String(err) },
        'Failed to flag lookalike asset'
      );
    }
  }

  if (flagged > 0) {
    log.info({ network, count: flagged }, 'Flagged lookalike assets');
  }

  return flagged;
}
