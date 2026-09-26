/**
 * Automatic persisted queries (APQ).
 *
 * ## What this is
 *
 * A client sends the SHA-256 of its document plus, the first time, the
 * document itself. Afterwards the hash alone is enough, which is the point:
 * a full query document is often kilobytes of a request that weighs a few
 * hundred bytes as JSON. `extensions.persistedQuery.version = 1` plus
 * `sha256Hash` is the wire shape; Apollo Server stores hash → document in its
 * cache and answers a hash-only request from there.
 *
 * ## Why it is configured here rather than left to the default
 *
 * Apollo Server has APQ switched on unless it is explicitly switched off, so
 * this could have been left implicit. Two reasons not to:
 *
 * - "On by default" is a behaviour a client can observe but an operator
 *   cannot see. When a client gets `PERSISTED_QUERY_NOT_FOUND` at 3am, the
 *   answer should be a documented variable, not a reading of the framework's
 *   source.
 * - The TTL is a real trade-off. Long enough that a client's hash survives a
 *   redeploy of the API process (the cache is in-memory, so every restart
 *   empties it and every client re-registers), short enough that the cache
 *   cannot grow without bound across distinct documents.
 *
 * ## What this is not
 *
 * Not a safelist. APQ stores whatever document arrives under its hash; it
 * answers "I have seen this document", not "this document is allowed". An
 * allow-listed-persisted-queries deployment, where only reviewed documents are
 * accepted, is a different feature with different failure modes and is not
 * what `PERSISTED_QUERIES=true` means here.
 */

type Env = Record<string, string | undefined>;

/** Seven days: long enough to outlive a client session, short enough to turn over. */
export const DEFAULT_PERSISTED_QUERY_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface PersistedQueryConfig {
  /** False means hash-only requests are answered with `PERSISTED_QUERY_NOT_SUPPORTED`. */
  enabled: boolean;
  /** How long a registered hash stays in the cache, in seconds. */
  ttlSeconds: number;
}

const DISABLED_VALUES = new Set(['false', '0', 'no', 'off']);
const ENABLED_VALUES = new Set(['true', '1', 'yes', 'on']);

/**
 * Read the persisted-query settings, or throw on a value that cannot be
 * understood.
 *
 * A typo in a flag is otherwise invisible: `PERSISTED_QUERIES=falsee` would
 * silently leave APQ enabled, and the operator who meant to turn it off would
 * find out only by watching the cache. Configuration that decides which
 * requests the API accepts should fail at startup instead.
 */
export function persistedQueryConfig(env: Env = process.env): PersistedQueryConfig {
  const rawEnabled = env['PERSISTED_QUERIES'];
  let enabled = true;
  if (rawEnabled !== undefined && rawEnabled.trim() !== '') {
    const normalized = rawEnabled.trim().toLowerCase();
    if (!ENABLED_VALUES.has(normalized) && !DISABLED_VALUES.has(normalized)) {
      throw new Error(
        `PERSISTED_QUERIES must be one of ${[...ENABLED_VALUES].join(', ')} (or ${[...DISABLED_VALUES].join(', ')} to disable), got "${rawEnabled}".`
      );
    }
    enabled = ENABLED_VALUES.has(normalized);
  }

  const rawTtl = env['PERSISTED_QUERIES_TTL_SECONDS'];
  let ttlSeconds = DEFAULT_PERSISTED_QUERY_TTL_SECONDS;
  if (rawTtl !== undefined && rawTtl.trim() !== '') {
    const parsed = Number(rawTtl.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `PERSISTED_QUERIES_TTL_SECONDS must be a positive whole number of seconds, got "${rawTtl}".`
      );
    }
    ttlSeconds = parsed;
  }

  return { enabled, ttlSeconds };
}

/**
 * The value for Apollo Server's `persistedQueries` option.
 *
 * `false` disables it outright — Apollo then answers any `persistedQuery`
 * extension with `PERSISTED_QUERY_NOT_SUPPORTED`, which is what a client needs
 * to hear so it can fall back to sending full documents rather than retrying
 * a hash forever.
 */
export function persistedQueryOption(env: Env = process.env): { ttl: number } | false {
  const config = persistedQueryConfig(env);
  return config.enabled ? { ttl: config.ttlSeconds } : false;
}
