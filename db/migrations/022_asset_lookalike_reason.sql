-- Persist the detection rule for each asset flagged as a well-known-code lookalike.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS lookalike_reason TEXT;

UPDATE assets
SET lookalike_reason = 'issuer_mismatch:' || asset_code
WHERE is_lookalike IS TRUE AND lookalike_reason IS NULL;

INSERT INTO schema_migrations (version)
VALUES ('022_asset_lookalike_reason')
ON CONFLICT (version) DO NOTHING;
