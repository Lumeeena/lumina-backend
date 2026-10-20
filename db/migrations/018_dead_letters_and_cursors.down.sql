DROP TABLE IF EXISTS dead_letter_operations;
DROP TABLE IF EXISTS indexer_cursors;
DELETE FROM schema_migrations WHERE version = '018_dead_letters_and_cursors';
