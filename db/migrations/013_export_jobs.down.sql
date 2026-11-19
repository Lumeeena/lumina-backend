-- Migration 013 Down: Export jobs and API usage tracking
-- Run with: psql $DATABASE_URL -f db/migrations/013_export_jobs.down.sql

\echo 'Reverting migration 013: export_jobs and api_usage...'

DROP INDEX IF EXISTS idx_api_usage_key_time;
DROP TABLE IF EXISTS api_usage CASCADE;

DROP INDEX IF EXISTS idx_export_jobs_requested_by;
DROP INDEX IF EXISTS idx_export_jobs_status;
DROP TABLE IF EXISTS export_jobs CASCADE;

DELETE FROM schema_migrations WHERE version = '013_export_jobs';

\echo 'Migration 013 (export_jobs) down complete.'
