ALTER TABLE ledgers DROP CONSTRAINT IF EXISTS ledgers_sequence_check;
ALTER TABLE ledgers DROP CONSTRAINT IF EXISTS ledgers_transaction_count_check;
ALTER TABLE ledgers DROP CONSTRAINT IF EXISTS ledgers_operation_count_check;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_hash_check;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_ledger_check;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_source_account_check;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_operation_count_check;

ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_id_check;
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_type_check;
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_transaction_hash_check;
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_ledger_check;
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_source_account_check;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_address_check;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_sequence_check;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_subentry_count_check;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_last_modified_ledger_check;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_num_sponsored_check;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_num_sponsoring_check;

ALTER TABLE contract_events DROP CONSTRAINT IF EXISTS contract_events_id_check;
ALTER TABLE contract_events DROP CONSTRAINT IF EXISTS contract_events_contract_id_check;
ALTER TABLE contract_events DROP CONSTRAINT IF EXISTS contract_events_ledger_check;
ALTER TABLE contract_events DROP CONSTRAINT IF EXISTS contract_events_paging_token_check;

ALTER TABLE custom_events DROP CONSTRAINT IF EXISTS custom_events_event_id_check;
ALTER TABLE custom_events DROP CONSTRAINT IF EXISTS custom_events_contract_id_check;
ALTER TABLE custom_events DROP CONSTRAINT IF EXISTS custom_events_event_name_check;
ALTER TABLE custom_events DROP CONSTRAINT IF EXISTS custom_events_ledger_check;

DELETE FROM schema_migrations WHERE version = '008_data_constraints';
