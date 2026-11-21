-- Track refresh attempts without replacing previously fetched issuer metadata.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS issuer_metadata_fetched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS issuer_metadata_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS issuer_metadata_error TEXT;

-- Sponsorship entries of different kinds may have the same raw id.
ALTER TABLE sponsorships DROP CONSTRAINT IF EXISTS sponsorships_pkey;
ALTER TABLE sponsorships ADD PRIMARY KEY (sponsored_type, sponsored_id, network);

-- Trustline history is not written or queried by the application.
DROP TABLE IF EXISTS trustline_changes;

INSERT INTO schema_migrations (version)
VALUES ('025_sponsorship_metadata_and_trustline_cleanup')
ON CONFLICT (version) DO NOTHING;
