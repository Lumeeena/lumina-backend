# Staging Deployment

This document describes the staging deployment configuration and the promotion process from staging to production.

## Overview

The staging environment allows testing changes against realistic data before deploying to production. It uses a separate PostgreSQL database and can be seeded from a production backup subset.

## Configuration

Staging is configured via `docker/docker-compose.staging.yml`. Key differences from production:

- **Database**: `lumina_staging` (separate from production `lumina`)
- **GraphQL Port**: `4001` (to avoid conflict with production on `4000`)
- **Horizon**: Defaults to testnet (`https://horizon-testnet.stellar.org`)
- **Environment Variables**: Prefixed with `STAGING_` to avoid conflicts

### Environment Variables

Staging-specific environment variables (override in `.env` or pass to docker-compose):

```bash
# Database
STAGING_POSTGRES_PASSWORD=lumina_staging_dev
STAGING_LUMINA_GRAPHQL_PASSWORD=lumina_graphql_staging
STAGING_LUMINA_INDEXER_PASSWORD=lumina_indexer_staging

# Horizon/RPC
STAGING_HORIZON_URL=https://horizon-testnet.stellar.org
STAGING_SOROBAN_RPC_URL=
STAGING_INDEXED_CONTRACT_IDS=
STAGING_REGISTRY_CONTRACT_ID=
STAGING_REGISTRY_READ_ACCOUNT=

# Indexing
STAGING_START_LEDGER=

# S3 Exports (optional)
STAGING_S3_EXPORT_BUCKET=
STAGING_S3_EXPORT_PREFIX=lumina-staging/exports
```

## Running Staging

```bash
# Start staging environment
docker compose -f docker/docker-compose.staging.yml up

# With custom environment file
docker compose -f docker/docker-compose.staging.yml --env-file .env.staging up

# In detached mode
docker compose -f docker/docker-compose.staging.yml up -d
```

## Seeding from Production

To seed staging with a subset of production data:

1. **Create a production backup**:
```bash
pg_dump -h production-host -U lumina_owner lumina > production-backup.sql
```

2. **Restore to staging** (modify backup to use staging database name):
```bash
sed 's/lumina/lumina_staging/g' production-backup.sql > staging-backup.sql
psql -h localhost -U lumina lumina_staging < staging-backup.sql
```

3. **Alternatively, use a subset** (e.g., recent ledgers only):
```bash
# Extract recent data from production
pg_dump -h production-host -U lumina_owner \
  --table=ledgers --table=transactions --table=operations \
  --where="sequence > (SELECT MAX(sequence) - 10000 FROM ledgers)" \
  lumina > production-recent.sql

# Restore to staging
psql -h localhost -U lumina lumina_staging < production-recent.sql
```

## Promotion to Production

### Process

1. **Validate in Staging**:
   - Run the indexer with the new code/migrations
   - Verify data integrity with realistic data
   - Test GraphQL queries and subscriptions
   - Monitor performance metrics

2. **Prepare Production**:
   - Review migration scripts that modify primary keys or large tables
   - Ensure production database backup is current
   - Schedule maintenance window if needed

3. **Apply to Production**:
   ```bash
   # Apply migrations
   psql $DATABASE_URL -f db/migrations/XXX_migration.sql

   # Deploy new code
   # (Use your deployment process)
   ```

4. **Verify Production**:
   - Monitor indexer progress
   - Check GraphQL server health
   - Validate data consistency

### Migration Precautions

For migrations that rewrite primary keys on large tables (as mentioned in issue #250):

- **Never run directly on production without testing on staging first**
- Staging should have a realistic dataset size to expose performance issues
- Measure migration time on staging to estimate production impact
- Consider using `CREATE INDEX CONCURRENTLY` for non-blocking operations

## Monitoring

Staging exposes the same health endpoints as production:

- **Indexer Health**: `http://localhost:9090/health`
- **GraphQL Health**: `http://localhost:4001/health`

Use these to verify the staging environment is operating correctly before promotion.

## Cleanup

To tear down staging and remove all data:

```bash
docker compose -f docker/docker-compose.staging.yml down -v
```

This removes the staging database volume. Use with caution.
