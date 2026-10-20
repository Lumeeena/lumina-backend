-- Rolls back migration 017. Drops the stored account history: the data cannot
-- be rebuilt, because it is a record of states that were observed and are no
-- longer observable.

DROP INDEX IF EXISTS idx_account_state_history_recorded_at;
DROP TABLE IF EXISTS account_state_history;

DELETE FROM schema_migrations WHERE version = '017_account_state_history';
