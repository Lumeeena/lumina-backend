-- Durable records for payloads that cannot be interpreted by an indexer handler,
-- plus explicit cursors independent of derived ledger maxima.

CREATE TABLE IF NOT EXISTS dead_letter_operations (
    id              BIGSERIAL PRIMARY KEY,
    network         TEXT NOT NULL,
    ledger          BIGINT NOT NULL,
    operation_id    TEXT,
    payload         JSONB NOT NULL,
    error           TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,
    CONSTRAINT dead_letter_operations_status_check CHECK (status IN ('pending', 'processed'))
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_operations_pending
    ON dead_letter_operations (network, created_at)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS indexer_cursors (
    network         TEXT NOT NULL,
    purpose         TEXT NOT NULL,
    cursor          BIGINT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (network, purpose),
    CONSTRAINT indexer_cursors_purpose_check CHECK (purpose IN ('forward', 'backfill', 'events'))
);
