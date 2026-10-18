-- Migration 013: Backfill progress tracking
--
-- Tracks backward ledger backfill progress independently of the forward indexing cursor.
-- Progress is recorded per network and range so backfilling resumes after restart
-- rather than starting over.

CREATE TABLE IF NOT EXISTS backfill_progress (
    network             TEXT NOT NULL,
    start_ledger        BIGINT NOT NULL,
    end_ledger          BIGINT NOT NULL,
    current_ledger      BIGINT NOT NULL,
    completed_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (network, start_ledger, end_ledger),
    CONSTRAINT backfill_progress_range_check CHECK (start_ledger <= end_ledger),
    CONSTRAINT backfill_progress_current_check CHECK (current_ledger >= start_ledger - 1 AND current_ledger <= end_ledger)
);

CREATE INDEX IF NOT EXISTS idx_backfill_progress_network
    ON backfill_progress (network)
    WHERE completed_at IS NULL;
