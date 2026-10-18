ALTER TABLE transactions RESET (
  autovacuum_vacuum_insert_threshold,
  autovacuum_vacuum_insert_scale_factor,
  autovacuum_analyze_threshold,
  autovacuum_analyze_scale_factor
);

ALTER TABLE operations RESET (
  autovacuum_vacuum_insert_threshold,
  autovacuum_vacuum_insert_scale_factor,
  autovacuum_analyze_threshold,
  autovacuum_analyze_scale_factor
);

DELETE FROM schema_migrations WHERE version = '006_autovacuum';
