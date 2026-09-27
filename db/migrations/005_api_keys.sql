-- Migration 005: API keys table for GraphQL authentication and rate limiting
-- Run with: psql $DATABASE_URL -f db/migrations/005_api_keys.sql
--
-- Stores cryptographic hashes of API keys (never the raw plaintext), along
-- with their assigned label, rate limit configuration, and lifecycle timestamps.

\echo 'Running migration 005: api_keys table...'

CREATE TABLE IF NOT EXISTS api_keys (
    id                  SERIAL PRIMARY KEY,
    key_hash            TEXT NOT NULL UNIQUE,
    key_prefix          TEXT NOT NULL,
    label               TEXT NOT NULL,
    rate_limit          INTEGER NOT NULL DEFAULT 60, -- requests per minute
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at          TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at ON api_keys (revoked_at);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('005_api_keys', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 005 complete.'
