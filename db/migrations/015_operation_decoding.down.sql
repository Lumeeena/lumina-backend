-- Rollback migration 015: Decode bump_sequence, manage_data, revoke_sponsorship, restore_footprint, extend_footprint_ttl, and contract interfaces

DROP TABLE IF EXISTS contract_interfaces;
DROP TABLE IF EXISTS soroban_ttl;
DROP TABLE IF EXISTS sponsorships;

DELETE FROM schema_migrations WHERE version = '015_operation_decoding';
