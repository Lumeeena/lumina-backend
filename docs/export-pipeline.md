# Bulk Data Export / ETL Pipeline

## Overview
This document describes Lumina's bulk data export and ETL pipeline, allowing consumers to pull indexed data into their analytics stacks.

## Export Job Model

The `export_jobs` table tracks all export requests:

```sql
CREATE TABLE export_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by TEXT,  -- API key hash or 'anonymous'
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
    filters JSONB,      -- ExportFilter object
    format TEXT NOT NULL CHECK (format IN ('csv', 'parquet')),
    output_location TEXT,  -- S3 path or signed URL
    error_message TEXT,
    row_count INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
```

## GraphQL Mutations

### Request Export
```graphql
mutation {
  requestExport(filter: {
    table: "transactions"
    fromLedger: 1000000
    toLedger: 1100000
    format: CSV
  }) {
    id
    status
    createdAt
  }
}
```

### Check Export Status
```graphql
query {
  exportJob(id: "550e8400-e29b-41d4-a716-446655440000") {
    id
    status
    outputLocation
    rowCount
    errorMessage
    completedAt
  }
}
```

## Streaming Implementation

The export worker uses Postgres cursors to stream large result sets without loading everything into memory:

```typescript
// Pseudo-code for streaming implementation
async function* streamResults(query: string, params: any[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cursor = new Cursor(query, params);
    
    while (true) {
      const rows = await cursor.read(1000);
      if (rows.length === 0) break;
      yield rows;
    }
    
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}
```

## Supported Formats

### CSV
- Human-readable
- Compatible with Excel, Google Sheets
- Header row with column names
- UTF-8 encoding

### Parquet
- Columnar format optimized for analytics
- Significantly smaller file sizes
- Better performance for large datasets
- Requires parquet-compatible tools (DuckDB, pandas, Spark)

## Destinations

### S3-Compatible Storage
- MinIO for self-hosted deployments
- AWS S3, GCS, or any S3-compatible backend
- Signed URLs with 24-hour expiration

### Incremental Sync (Stretch Goal)
Scheduled exports that only include new rows since last sync:

```graphql
mutation {
  scheduleIncrementalSync(
    destination: "s3://my-bucket/lumina-data/"
    schedule: "0 2 * * *"  # Daily at 2am
    tables: ["transactions", "operations"]
  ) {
    syncId
    nextRunAt
  }
}
```

## Size & Rate Limits

- **Per-request limit**: 1M rows (configurable per tier)
- **Rate limit**: 2 exports per minute per API key
- **Concurrent exports**: Max 2 per API key
- **Anonymous tier**: No export access (requires API key)

## Testing Checklist

- [ ] CSV export row count matches direct SQL query
- [ ] Parquet export correctly decodes in DuckDB/pandas
- [ ] 10k+ row export doesn't spike memory (stays under 200MB)
- [ ] `exportJob(id)` status updates reflect reality
- [ ] Failed exports set error_message correctly
- [ ] Streaming cursor releases connection properly

## Usage Example

```bash
# Request an export
export JOB_ID=$(curl -H "X-API-Key: $API_KEY" \
  -d '{"query": "mutation { requestExport(...) { id } }"}' \
  https://lumina.example/graphql | jq -r '.data.requestExport.id')

# Poll for completion
while true; do
  STATUS=$(curl -H "X-API-Key: $API_KEY" \
    -d "{\"query\": \"query { exportJob(id: \\\"$JOB_ID\\\") { status outputLocation } }\"}" \
    https://lumina.example/graphql)
  echo $STATUS
  if echo $STATUS | jq -e '.data.exportJob.status == "complete"' > /dev/null; then
    break
  fi
  sleep 5
done

# Download the result
URL=$(echo $STATUS | jq -r '.data.exportJob.outputLocation')
curl -o export.csv "$URL"
```

## Implementation Status

- [x] Export limiter (export.ts)
- [x] Permission check (hasExportPermission)
- [ ] Export job table migration
- [ ] Job runner with streaming
- [ ] GraphQL mutations
- [ ] Parquet format support
- [ ] Incremental sync mode
- [ ] Comprehensive tests
