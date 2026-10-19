-- Migration 015: Admin operations audit table
-- Run with: psql $DATABASE_URL -f db/migrations/015_admin_operations.sql

CREATE TABLE IF NOT EXISTS admin_operations (
    id              BIGSERIAL PRIMARY KEY,
    network         TEXT NOT NULL,
    command         TEXT NOT NULL,
    arguments       JSONB NOT NULL,
    success         BOOLEAN NOT NULL,
    details         TEXT,
    executed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_operations_network ON admin_operations (network, executed_at DESC);
