-- Migration 013: Record failed ledgers when retries are exhausted
-- Run with: psql $DATABASE_URL -f db/migrations/013_failed_ledgers.sql
--
-- When retries are exhausted in fetchAndIndexLedgerWithRetry, the indexer
-- logs and moves on so the pipeline stays alive. This table creates a
-- durable record of those failed ledgers so gap detection and repair
-- can pick them up later, and clears them once indexed successfully.

CREATE TABLE IF NOT EXISTS failed_ledgers (
    sequence        BIGINT NOT NULL,
    network         TEXT NOT NULL DEFAULT 'mainnet',
    error           TEXT,
    attempt_count   INTEGER NOT NULL DEFAULT 1,
    failed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sequence, network)
);

CREATE INDEX IF NOT EXISTS idx_failed_ledgers_sequence ON failed_ledgers (sequence, network);
