-- Migration 021: index the bounded recent-ledger integrity audit window.
-- Run with: psql $DATABASE_URL -f db/migrations/021_ledger_audit_window_index.sql

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledgers_network_sequence
    ON ledgers (network, sequence DESC);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('021_ledger_audit_window_index', NOW())
ON CONFLICT (version) DO NOTHING;