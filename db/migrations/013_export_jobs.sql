-- Migration 013: Export jobs table
-- Issue #10: Bulk data export / ETL pipeline

CREATE TABLE IF NOT EXISTS export_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
    filters JSONB,
    format TEXT NOT NULL CHECK (format IN ('csv', 'parquet')),
    output_location TEXT,
    error_message TEXT,
    row_count INTEGER,
    network TEXT NOT NULL DEFAULT 'mainnet',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CONSTRAINT export_jobs_status_check CHECK (
        (status = 'complete' AND completed_at IS NOT NULL) OR
        (status != 'complete')
    )
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_status
    ON export_jobs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_export_jobs_requested_by
    ON export_jobs (requested_by, created_at DESC);

-- API usage tracking table for rate limiting analytics
CREATE TABLE IF NOT EXISTS api_usage (
    id BIGSERIAL PRIMARY KEY,
    key_id INTEGER REFERENCES api_keys(id) ON DELETE CASCADE,
    operation_name TEXT,
    response_time_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network TEXT NOT NULL DEFAULT 'mainnet'
);

CREATE INDEX IF NOT EXISTS idx_api_usage_key_time
    ON api_usage (key_id, created_at DESC);

-- Partition api_usage by month for better performance
-- (Optional - uncomment if needed)
-- CREATE TABLE api_usage_partitioned (LIKE api_usage INCLUDING ALL)
--   PARTITION BY RANGE (created_at);
