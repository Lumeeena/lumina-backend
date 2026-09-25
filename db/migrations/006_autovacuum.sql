-- High-insert tables benefit from earlier insert-triggered vacuum/analyze.
ALTER TABLE transactions SET (
  autovacuum_vacuum_insert_threshold = 5000,
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_analyze_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE operations SET (
  autovacuum_vacuum_insert_threshold = 5000,
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_analyze_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.02
);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('006_autovacuum', NOW())
ON CONFLICT (version) DO NOTHING;
