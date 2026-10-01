-- Migration 008: durable, asynchronous account refresh work
-- Run with: psql $DATABASE_URL -f db/migrations/008_account_refresh_queue.sql

CREATE TABLE IF NOT EXISTS account_refresh_queue (
    network                 TEXT NOT NULL,
    address                 TEXT NOT NULL,
    last_requested_ledger   BIGINT NOT NULL,
    queued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (network, address)
);

CREATE INDEX IF NOT EXISTS idx_account_refresh_queue_pending
    ON account_refresh_queue (network, queued_at);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('008_account_refresh_queue', NOW())
ON CONFLICT (version) DO NOTHING;