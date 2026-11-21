/**
 * Asset issuer metadata resolution.
 *
 * Fetches issuer home domains and stellar.toml files to provide self-declared
 * asset metadata. This helps users distinguish real assets from impostors.
 * Issue #257.
 */

import type { Pool } from 'pg';
import { subsystem } from './logger';
import { getAccount } from './horizon';
import { parse } from 'smol-toml';
import { Agent, get as httpsGet } from 'node:https';

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
  assetIssuer: string,
  horizonUrl: Parameters<typeof getAccount>[0]
): Promise<void> {
  const attemptedAt = new Date();
  try {
    const account = await getAccount(horizonUrl, assetIssuer);
    const domain = account?.home_domain?.trim();
    if (!domain || domain.length > 253 || /[^a-zA-Z0-9.-]/.test(domain) || domain.includes('..')) {
      throw new Error('Issuer has no valid home domain');
    }
    const host = new URL(`https://${domain}`).hostname;
    const addresses = await (await import('node:dns/promises')).lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error('Issuer domain resolves to a non-public address');
    }
    const address = addresses[0];
    const agent = new Agent({ lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, address.address, address.family)) as never });
    const text = await fetchToml(host, agent);
    const toml = parse(text) as { CURRENCIES?: Array<Record<string, unknown>> };
    const currency = toml.CURRENCIES?.find(entry => entry.code === assetCode && entry.issuer === assetIssuer);
    if (!currency) throw new Error('stellar.toml does not declare this asset');
    await pool.query(
      `UPDATE assets
       SET issuer_home_domain = $1, issuer_metadata = $2, issuer_metadata_fetched_at = NOW(),
           issuer_metadata_attempted_at = $3, issuer_metadata_error = NULL,
           updated_at = NOW()
       WHERE asset_code = $4 AND asset_issuer = $5 AND network = $6`,
      [domain, currency, attemptedAt, assetCode, assetIssuer, network]
    );
  } catch (err) {
    await pool.query(
      `UPDATE assets SET issuer_metadata_attempted_at = $1, issuer_metadata_error = $2
       WHERE asset_code = $3 AND asset_issuer = $4 AND network = $5`,
      [attemptedAt, (err instanceof Error ? err.message : String(err)).slice(0, 500), assetCode, assetIssuer, network]
    ).catch(() => undefined);
    log.error(
      { network, assetCode, assetIssuer, err: err instanceof Error ? err.message : String(err) },
      'Failed to update issuer metadata'
    );
  }
}

function fetchToml(host: string, agent: Agent): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpsGet({ hostname: host, path: '/.well-known/stellar.toml', agent, timeout: 8000, headers: { accept: 'text/plain' } }, response => {
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
        response.resume();
        reject(new Error(`stellar.toml returned HTTP ${response.statusCode ?? 500}`));
        return;
      }
      const length = Number(response.headers['content-length'] || 0);
      if (length > 1_000_000) { response.destroy(); reject(new Error('stellar.toml exceeds 1 MB')); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_000_000) { response.destroy(new Error('stellar.toml exceeds 1 MB')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('stellar.toml request timed out')));
    request.on('error', reject);
  });
}

/** Refresh a small stale-asset batch so metadata work cannot delay ledger indexing. */
export async function refreshIssuerMetadataBatch(pool: Pool, network: string, horizonUrl: Parameters<typeof getAccount>[0], limit = 5): Promise<void> {
  const { rows } = await pool.query<{ asset_code: string; asset_issuer: string }>(
    `SELECT asset_code, asset_issuer FROM assets
     WHERE network = $1
       AND (issuer_metadata_fetched_at IS NULL OR issuer_metadata_fetched_at < NOW() - INTERVAL '7 days')
       AND (issuer_metadata_attempted_at IS NULL OR issuer_metadata_attempted_at < NOW() - INTERVAL '1 hour')
     ORDER BY issuer_metadata_fetched_at NULLS FIRST, asset_code, asset_issuer LIMIT $2`,
    [network, limit]
  );
  for (const asset of rows) await updateIssuerMetadata(pool, network, asset.asset_code, asset.asset_issuer, horizonUrl);
}

function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const value = address.toLowerCase();
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
  }
  const octets = address.split('.').map(Number);
  return octets.length !== 4 || octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224;
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
