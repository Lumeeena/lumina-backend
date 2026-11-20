-- Migration 022: Persist webhook registrations and delivery attempts (#377).
--
-- Moves webhook registrations out of process memory so registrations survive
-- restarts and are shared across replicas, scoped to the owning API key.

CREATE TABLE IF NOT EXISTS webhook_registrations (
  id                UUID PRIMARY KEY,
  api_key_id        INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  network           TEXT NOT NULL DEFAULT 'mainnet',
  url               TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  filter            JSONB NOT NULL DEFAULT '{}',
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  failure_count     INTEGER NOT NULL DEFAULT 0,
  last_delivery_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT webhook_registrations_url_check CHECK (url <> ''),
  CONSTRAINT webhook_registrations_failure_count_check CHECK (failure_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_webhook_registrations_owner
  ON webhook_registrations (api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_registrations_active_network
  ON webhook_registrations (network, active)
  WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           BIGSERIAL PRIMARY KEY,
  webhook_id   UUID NOT NULL REFERENCES webhook_registrations(id) ON DELETE CASCADE,
  api_key_id   INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  attempt      INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'dead_lettered')),
  http_status  INTEGER,
  error        TEXT,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_owner_time
  ON webhook_deliveries (api_key_id, delivered_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_time
  ON webhook_deliveries (webhook_id, delivered_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('022_webhooks')
ON CONFLICT (version) DO NOTHING;
