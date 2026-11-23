/**
 * API key storage for the GraphQL server: generating keys, storing only their
 * hashes, and reading or changing the `api_keys` rows that the auth and export
 * paths check.
 *
 * The plaintext key is shown to the operator once, at creation, and never
 * stored. Every later lookup is by its SHA-256 hash (see `hashApiKey`). The
 * functions that take an `identifier` accept either a numeric row id or a
 * hash; see `getApiKey` for how the two are told apart.
 */
import crypto from 'crypto';
import { Pool } from 'pg';

/**
 * A row of the `api_keys` table as this module reads it. Never contains the
 * plaintext key, because the table has no column for it.
 */
export interface ApiKeyRecord {
  id: number;
  /** SHA-256 hex digest of the plaintext key. This is the stored lookup value. */
  keyHash: string;
  /** Display prefix, `deriveKeyPrefix` output (first 12 characters then `...`). */
  keyPrefix: string;
  label: string;
  /** Requests per minute allowed for this key. */
  rateLimit: number;
  createdAt: Date;
  /** Set when the key was revoked. Null while the key is active. */
  revokedAt: Date | null;
  updatedAt: Date;
}

/**
 * Returned only by `createApiKey`. It is the one place the plaintext key exists
 * after generation, and it is not recoverable from the database afterwards.
 */
export interface CreatedApiKey extends ApiKeyRecord {
  /** The full `lum_…` key. Show it to the operator now; it cannot be shown again. */
  plaintextKey: string;
}

/**
 * Generates a cryptographically secure API key with the "lum_" prefix.
 *
 * The key is `lum_` followed by 32 random bytes (256 bits) in hex, 68 characters
 * in total. Randomness comes from `crypto.randomBytes`.
 */
export function generateApiKey(): string {
  const token = crypto.randomBytes(32).toString('hex');
  return `lum_${token}`;
}

/**
 * Computes the SHA-256 hex digest of an API key, for storage and lookup.
 *
 * The input is trimmed of leading and trailing whitespace before hashing, so
 * `hashApiKey(' key ')` equals `hashApiKey('key')`. Callers therefore never need
 * to trim first, and a key pasted with a trailing newline still matches. Nothing
 * else is normalised: case and interior characters are significant.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key.trim()).digest('hex');
}

/**
 * Derives the display prefix for a key: its first 12 characters followed by
 * `...`, for example `lum_a1b2c3d4...`.
 *
 * The prefix is stored in `key_prefix` at creation so CLI listings can show a key
 * without revealing it. It takes the plaintext key only. Passing a hash gives the
 * first 12 hex characters of the hash, which is not a meaningful prefix.
 */
export function deriveKeyPrefix(plaintextKey: string): string {
  // e.g. "lum_a1b2c3d4..."
  return plaintextKey.slice(0, 12) + '...';
}

/**
 * Maps a raw `api_keys` row to `ApiKeyRecord`. `revoked_at` is kept as null when
 * the column is null, so callers can test `revokedAt === null` for "active".
 */
function mapApiKeyRow(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: Number(row.id),
    keyHash: String(row.key_hash),
    keyPrefix: String(row.key_prefix),
    label: String(row.label),
    rateLimit: Number(row.rate_limit),
    createdAt: new Date(row.created_at as string | number | Date),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string | number | Date) : null,
    updatedAt: new Date(row.updated_at as string | number | Date),
  };
}

/**
 * Creates a new active API key and inserts its hash, prefix and label.
 *
 * The label is trimmed and must not be empty afterwards. `rateLimit` must be a
 * positive integer, in requests per minute. The default of 60 applies when the
 * argument is omitted. The source does not record why 60 was chosen.
 *
 * The plaintext key is returned in the result and must be displayed immediately,
 * because only its cryptographic hash is stored in the database.
 *
 * @throws if the label is blank or the rate limit is not a positive integer.
 */
export async function createApiKey(
  pool: Pool,
  label: string,
  rateLimit: number = 60
): Promise<CreatedApiKey> {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    throw new Error('API key label cannot be empty');
  }
  if (!Number.isInteger(rateLimit) || rateLimit <= 0) {
    throw new Error(`Rate limit must be a positive integer, got: ${rateLimit}`);
  }

  const plaintextKey = generateApiKey();
  const keyHash = hashApiKey(plaintextKey);
  const keyPrefix = deriveKeyPrefix(plaintextKey);

  const query = `
    INSERT INTO api_keys (key_hash, key_prefix, label, rate_limit, created_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW(), NOW())
    RETURNING id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
  `;

  const res = await pool.query(query, [keyHash, keyPrefix, trimmedLabel, rateLimit]);
  const record = mapApiKeyRow(res.rows[0]);

  return {
    ...record,
    plaintextKey,
  };
}

/**
 * Lists every API key, revoked ones included, newest first.
 *
 * Ordered by `created_at` descending, with `id` descending as the tie-break.
 * Returns hashes and metadata only. Plaintext keys are not stored, so they
 * cannot be listed.
 */
export async function listApiKeys(pool: Pool): Promise<ApiKeyRecord[]> {
  const query = `
    SELECT id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    FROM api_keys
    ORDER BY created_at DESC, id DESC
  `;
  const res = await pool.query(query);
  return res.rows.map(mapApiKeyRow);
}

/**
 * Retrieves metadata for one key, by row id or by hash.
 *
 * The identifier is treated as a row id when it is a number or a string of
 * digits (after trimming). Anything else is treated as a hash. A hash that
 * happens to be all digits is therefore looked up as an id and will not match;
 * `findApiKeyByHash` exists for callers that already hold a hash.
 *
 * Revoked keys are returned, with `revokedAt` set.
 *
 * @returns The record, or `null` if no row matches.
 */
export async function getApiKey(
  pool: Pool,
  identifier: number | string
): Promise<ApiKeyRecord | null> {
  const isNumeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier).trim());
  const query = isNumeric
    ? `
      SELECT id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
      FROM api_keys
      WHERE id = $1
    `
    : `
      SELECT id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
      FROM api_keys
      WHERE key_hash = $1
    `;

  const res = await pool.query(query, [identifier]);
  if (res.rows.length === 0) return null;
  return mapApiKeyRow(res.rows[0]);
}

/**
 * Retrieve a key by its hash, and only by its hash.
 *
 * Deliberately distinct from `getApiKey`, which infers id-versus-hash from the
 * shape of its argument. That inference is fine for a human typing a CLI
 * argument, but the request path already knows it holds a digest and must not
 * have it second-guessed: a SHA-256 hash is hex and could in principle be all
 * digits, in which case the guess would silently look up an id and miss.
 */
export async function findApiKeyByHash(pool: Pool, keyHash: string): Promise<ApiKeyRecord | null> {
  // The hash is passed through unmodified. It is not trimmed or case-folded.
  const query = `
    SELECT id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    FROM api_keys
    WHERE key_hash = $1
  `;

  const res = await pool.query(query, [keyHash]);
  if (res.rows.length === 0) return null;
  return mapApiKeyRow(res.rows[0]);
}

/**
 * Revokes an API key by setting `revoked_at` to now.
 *
 * Identifier rules match `getApiKey`. Revoking an already-revoked key succeeds
 * and overwrites `revoked_at` with the new time, so the original revocation time
 * is lost.
 *
 * @throws `API key not found` if no row matches.
 */
export async function revokeApiKey(
  pool: Pool,
  identifier: number | string
): Promise<ApiKeyRecord> {
  const isNumeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier).trim());
  const query = isNumeric
    ? `
      UPDATE api_keys
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    `
    : `
      UPDATE api_keys
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE key_hash = $1
      RETURNING id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    `;

  const res = await pool.query(query, [identifier]);
  if (res.rows.length === 0) {
    throw new Error(`API key not found: ${identifier}`);
  }
  return mapApiKeyRow(res.rows[0]);
}

/**
 * Sets a new rate limit, in requests per minute, for an API key.
 *
 * Identifier rules match `getApiKey`. The limit is validated before the database
 * is touched, so an invalid value never issues a query. Revoked keys can be
 * updated too.
 *
 * @throws if `newLimit` is not a positive integer, or `API key not found` if no
 *   row matches.
 */
export async function setApiKeyLimit(
  pool: Pool,
  identifier: number | string,
  newLimit: number
): Promise<ApiKeyRecord> {
  if (!Number.isInteger(newLimit) || newLimit <= 0) {
    throw new Error(`Rate limit must be a positive integer, got: ${newLimit}`);
  }

  const isNumeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier).trim());
  const query = isNumeric
    ? `
      UPDATE api_keys
      SET rate_limit = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    `
    : `
      UPDATE api_keys
      SET rate_limit = $2, updated_at = NOW()
      WHERE key_hash = $1
      RETURNING id, key_hash, key_prefix, label, rate_limit, created_at, revoked_at, updated_at
    `;

  const res = await pool.query(query, [identifier, newLimit]);
  if (res.rows.length === 0) {
    throw new Error(`API key not found: ${identifier}`);
  }
  return mapApiKeyRow(res.rows[0]);
}

/**
 * Turns the export permission for an API key on or off by setting `export_enabled`.
 *
 * This is separate from revocation. The export check in `export.ts` requires both
 * `revoked_at IS NULL` and `export_enabled = TRUE`, so a revoked key cannot export
 * whatever this flag says, and an active key cannot export while this flag is off.
 * This function does not check `revoked_at`, so it can change the flag on a
 * revoked key.
 *
 * Identifier rules match `getApiKey`. The update is a single statement, and the
 * function requires it to match exactly one row.
 *
 * @throws `API key not found` if no row matches.
 */
export async function setApiKeyExportPermission(pool: Pool, identifier: number | string, enabled: boolean): Promise<void> {
  const numeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier).trim());
  const result = numeric
    ? await pool.query('UPDATE api_keys SET export_enabled = $2, updated_at = NOW() WHERE id = $1', [identifier, enabled])
    : await pool.query('UPDATE api_keys SET export_enabled = $2, updated_at = NOW() WHERE key_hash = $1', [identifier, enabled]);
  if (result.rowCount !== 1) throw new Error(`API key not found: ${identifier}`);
}
