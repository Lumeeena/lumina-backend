ALTER TABLE accounts DROP COLUMN IF EXISTS num_sponsored;
ALTER TABLE accounts DROP COLUMN IF EXISTS num_sponsoring;
ALTER TABLE contract_events DROP COLUMN IF EXISTS type;

DELETE FROM schema_migrations WHERE version = '002_account_event_columns';
