-- Migration 008: data-quality CHECK constraints for values the indexer assumes
-- Run with: psql $DATABASE_URL -f db/migrations/008_data_constraints.sql
--
-- ## Why
--
-- The columns below are typed but were unconstrained, so an indexer bug (a
-- negative operation count, an empty hash, a zero ledger sequence) would be
-- stored happily and surface much later as a confusing query result. These
-- constraints let the database reject implausible rows at write time.
--
-- ## Validating existing rows
--
-- `ADD CONSTRAINT ... CHECK` validates existing rows as it is added: Postgres
-- scans the table once and fails the migration if any row violates a
-- constraint. On a populated deployment that scan is the one meaningful cost
-- of this migration, and it takes a lock that blocks writes for its duration.
-- The tables are small except `operations` and `transactions`; if that scan is
-- too expensive to run inline on a large deployment, add the constraints with
-- `NOT VALID` here and run `ALTER TABLE ... VALIDATE CONSTRAINT ...` in a
-- separate, quieter step instead. Every row the indexer has written so far
-- satisfies these constraints, so validation is expected to pass.
--
-- ## Idempotency
--
-- Migration 001 builds from db/schema.sql, which already carries these
-- constraints, so on a freshly built database each `ADD CONSTRAINT` below is
-- skipped. The guards make this migration safe to re-run.

\echo 'Running migration 008: data-quality check constraints...'

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledgers_sequence_check') THEN
    ALTER TABLE ledgers ADD CONSTRAINT ledgers_sequence_check CHECK (sequence > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledgers_transaction_count_check') THEN
    ALTER TABLE ledgers ADD CONSTRAINT ledgers_transaction_count_check CHECK (transaction_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledgers_operation_count_check') THEN
    ALTER TABLE ledgers ADD CONSTRAINT ledgers_operation_count_check CHECK (operation_count >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_hash_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_hash_check CHECK (hash <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_ledger_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_ledger_check CHECK (ledger > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_source_account_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_source_account_check CHECK (source_account <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_operation_count_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_operation_count_check CHECK (operation_count >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operations_id_check') THEN
    ALTER TABLE operations ADD CONSTRAINT operations_id_check CHECK (id <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operations_type_check') THEN
    ALTER TABLE operations ADD CONSTRAINT operations_type_check CHECK (type <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operations_transaction_hash_check') THEN
    ALTER TABLE operations ADD CONSTRAINT operations_transaction_hash_check CHECK (transaction_hash <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operations_ledger_check') THEN
    ALTER TABLE operations ADD CONSTRAINT operations_ledger_check CHECK (ledger > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operations_source_account_check') THEN
    ALTER TABLE operations ADD CONSTRAINT operations_source_account_check CHECK (source_account <> '');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_address_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_address_check CHECK (address <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_sequence_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_sequence_check CHECK (sequence <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_subentry_count_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_subentry_count_check CHECK (subentry_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_last_modified_ledger_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_last_modified_ledger_check CHECK (last_modified_ledger > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_num_sponsored_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_num_sponsored_check CHECK (num_sponsored >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_num_sponsoring_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_num_sponsoring_check CHECK (num_sponsoring >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_events_id_check') THEN
    ALTER TABLE contract_events ADD CONSTRAINT contract_events_id_check CHECK (id <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_events_contract_id_check') THEN
    ALTER TABLE contract_events ADD CONSTRAINT contract_events_contract_id_check CHECK (contract_id <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_events_ledger_check') THEN
    ALTER TABLE contract_events ADD CONSTRAINT contract_events_ledger_check CHECK (ledger > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_events_paging_token_check') THEN
    ALTER TABLE contract_events ADD CONSTRAINT contract_events_paging_token_check CHECK (paging_token <> '');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_events_event_id_check') THEN
    ALTER TABLE custom_events ADD CONSTRAINT custom_events_event_id_check CHECK (event_id <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_events_contract_id_check') THEN
    ALTER TABLE custom_events ADD CONSTRAINT custom_events_contract_id_check CHECK (contract_id <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_events_event_name_check') THEN
    ALTER TABLE custom_events ADD CONSTRAINT custom_events_event_name_check CHECK (event_name <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_events_ledger_check') THEN
    ALTER TABLE custom_events ADD CONSTRAINT custom_events_ledger_check CHECK (ledger > 0);
  END IF;
END $$;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('008_data_constraints', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 008 complete.'
