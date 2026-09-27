-- Durable retry queue for failed ledgers
-- Part of issue #67: ensures failed ledgers are retried after process restart

CREATE TABLE IF NOT EXISTS ledger_retry_queue (
    ledger              BIGINT NOT NULL,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error          TEXT,
    first_failed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempted_at   TIMESTAMPTZ,
    permanently_failed  BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (ledger, network)
);

CREATE INDEX idx_retry_queue_next_attempt ON ledger_retry_queue (next_attempt_at)
    WHERE NOT permanently_failed;
