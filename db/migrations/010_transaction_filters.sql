-- Migration 010: indexes for filtered transaction pagination
-- Run with: psql $DATABASE_URL -f db/migrations/010_transaction_filters.sql
--
-- Concurrent builds avoid blocking indexer writes on populated deployments.
-- This migration must run outside a transaction, like migration 004.

\echo 'Running migration 010: transaction filter indexes...'

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_network_ledger_hash
    ON transactions (network, ledger DESC, hash DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_network_successful_page
    ON transactions (network, successful, ledger DESC, hash DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_network_source_page
    ON transactions (network, source_account, ledger DESC, hash DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_network_created_at
    ON transactions (network, created_at DESC);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('010_transaction_filters', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 010 complete.'