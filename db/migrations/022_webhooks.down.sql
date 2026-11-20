-- Down migration 022: Remove persisted webhook registrations and delivery attempts (#377).

DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhook_registrations;

DELETE FROM schema_migrations WHERE version = '022_webhooks';
