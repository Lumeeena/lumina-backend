# Runbook: Full PostgreSQL Database Backup and Restore

This runbook documents the official operational procedures for creating consistent backups, executing full database restores, understanding post-restore indexer behavior, and verifying ledger integrity for Lumina Backend.

---

## 1. Motivation & Overview

The Lumina indexer ingests Stellar ledger headers, transactions, operations, affected accounts, and Soroban contract events from Horizon and Soroban RPC into PostgreSQL. Because re-indexing from the chain tip does not recover historical transactions, maintaining verified backups and having a documented restore procedure is critical to disaster recovery and data retention.

### Architecture Data Flow
```
Horizon / Soroban RPC ──▶ Lumina Indexer ──▶ PostgreSQL (ledgers, txs, ops, events)
                                                     │
                                                     ▼
                                          Apollo GraphQL Server
```

---

## 2. Backup Approach & Cadence

### 2.1 Backup Methodology

Lumina utilizes native PostgreSQL logical dumps created via `pg_dump` with custom archive format (`-Fc`):
- **Snapshot Isolation**: Logical backups execute inside a single transaction snapshot (`REPEATABLE READ`), ensuring foreign key integrity between `ledgers`, `transactions`, `operations`, `accounts`, `contract_events`, and `custom_events`.
- **Compression & Flexibility**: The custom format is compressed and allows parallel restores via `pg_restore -j <jobs>`.
- **Zero Lock Contention**: `pg_dump` does not block read queries or concurrent `INSERT` operations executed by the indexer.

### 2.2 Recommended Cadence & Retention

| Backup Tier | Cadence | Retention Policy | Storage Destination |
|---|---|---|---|
| **Full Logical Backup** | Daily (02:00 UTC off-peak) | Retain 14 daily, 8 weekly, 12 monthly | Encrypted cloud object store (S3 / GCS) |
| **Point-in-Time Recovery (PITR)** | Continuous WAL archiving | 7-day continuous replay window | Cloud archive volume (`pg_receivewal` / WAL-G) |
| **Pre-Migration Snapshot** | Ad-hoc before schema migrations | Retain until migration verification completes | Local / Cloud backup storage |

### 2.3 Backup Execution Command

Run the following command against the primary database instance:

```bash
# Set timestamp and destination
TIMESTAMP=$(date -u +'%Y%m%d_%H%M%SZ')
BACKUP_DIR="/var/backups/lumina"
BACKUP_FILE="${BACKUP_DIR}/lumina_backup_${TIMESTAMP}.dump"

mkdir -p "${BACKUP_DIR}"

# Execute snapshot backup using custom format
pg_dump \
  --dbname="${DATABASE_URL}" \
  --format=c \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --file="${BACKUP_FILE}"

# Compute SHA-256 checksum for artifact verification
sha256sum "${BACKUP_FILE}" > "${BACKUP_FILE}.sha256"

# Verify backup structure
pg_restore --list "${BACKUP_FILE}" > /dev/null && echo "Backup verified successfully."
```

For dockerized deployments:
```bash
docker compose -f docker/docker-compose.yml exec -T postgres \
  pg_dump -U lumina -d lumina -Fc -f "/var/lib/postgresql/data/backup_${TIMESTAMP}.dump"
```

---

## 3. Restore Procedure & Expected Duration

### 3.1 Estimated Restore Durations

Restore times depend on database size, disk I/O, and CPU core availability for index recreation:

| Database Size | Compressed Archive Size | Expected Duration (`-j 4`) | Notes |
|---|---|---|---|
| **Small (< 10 GB)** | ~1.5 - 2 GB | 2 – 5 minutes | Quick staging recovery |
| **Medium (10 – 50 GB)** | ~5 - 10 GB | 10 – 20 minutes | Production checkpoint |
| **Large (> 100 GB)** | > 20 GB | 30 – 60 minutes | Bound by GIN trigram index builds |

### 3.2 Step-by-Step Restore Procedure

#### Step 1: Drain Traffic and Stop Writers
To avoid race conditions or dirty writes during restoration, stop the indexer and GraphQL services:

```bash
# If using Docker Compose:
docker compose -f docker/docker-compose.yml stop indexer graphql

# If managing systemd services:
sudo systemctl stop lumina-indexer lumina-graphql
```

#### Step 2: Validate the Backup Archive Checksum
```bash
sha256sum -c "${BACKUP_FILE}.sha256"
```

#### Step 3: Prepare the Target Database
You can restore into a fresh database or overwrite the existing schema:

```bash
# Option A: Clean restore into an existing database
# (Uses --clean --if-exists during pg_restore, shown below)

# Option B: Recreate clean database
dropdb --if-exists -h localhost -U lumina lumina
createdb -h localhost -U lumina lumina
```

#### Step 4: Execute Restoration
Execute `pg_restore` using multiple parallel workers matching available CPU cores:

```bash
pg_restore \
  --dbname="${DATABASE_URL}" \
  --jobs=4 \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --verbose \
  "${BACKUP_FILE}"
```

#### Step 5: Apply Any Pending Schema Migrations
If the restore image is from an earlier release, ensure all database migrations are applied:

```bash
for migration in db/migrations/*.sql; do
  echo "Applying migration: ${migration}"
  psql "${DATABASE_URL}" -f "${migration}"
done
```

---

## 4. Post-Restore Indexer Behavior

When the Lumina indexer starts up against a restored database, it automatically resumes without manual intervention:

### 4.1 Horizon Ledger Resume Point
1. **Cursor Discovery**: Upon startup, the indexer executes `getLatestIndexedLedger(pool)` in `indexer/src/db.ts`:
   ```sql
   SELECT MAX(sequence) AS max FROM ledgers;
   ```
2. **Resume Sequence**:
   - If the database contains ledgers up to sequence $K$, `cursor` is initialized to $K$.
   - The indexer fetches the live network tip $T$ from Stellar Horizon via `getLatestLedgerSequence(HORIZON_URL)`.
   - The indexer enters the catch-up loop:
     ```typescript
     for (let seq = cursor + 1; seq <= latest; seq++) {
       await fetchAndIndexLedgerWithRetry(seq);
       cursor = seq;
       recordHorizonTip(latest, cursor);
     }
     ```
3. **Catch-up Phase**:
   - The indexer sequentially processes each missing ledger from $K + 1$ to $T$.
   - Each ledger write (`indexLedger`) wraps the ledger header, transactions, operations, and account balances in an atomic database transaction (`BEGIN ... COMMIT`) with `ON CONFLICT DO NOTHING`.
   - Once caught up ($cursor == T$), the indexer drops back to polling every `POLL_INTERVAL_MS` (default: 5000 ms).

### 4.2 Soroban Contract Events Resume Point
1. **Cursor Discovery**: The contract event loop inspects `getLatestIndexedEventLedger(pool)`:
   ```sql
   SELECT MAX(ledger_sequence) AS max FROM contract_events;
   ```
2. **Resume Sequence**:
   - If the restored database contains events up to ledger $E$, `eventsCursor` begins at $E + 1$.
   - Events are fetched via Soroban RPC `getEvents` for all configured and dynamically discovered contract IDs.
   - Idempotency is maintained via `insertContractEvents` using `ON CONFLICT (id) DO NOTHING`.

---

## 5. Ledger Continuity & Gap Analysis

### 5.1 Are Gap Repairs Needed?
- **Standard Scenario**: **No gap repair is needed**. Because the backup was produced using a transactionally consistent snapshot at ledger $K$, ledgers $1 \dots K$ are intact. When the indexer restarts, it resumes at $K + 1$ and processes sequentially to the chain tip.
- **Abnormal Failure Scenarios**: A gap can only occur if an operator manually configured `START_LEDGER` to skip ahead, or if past network failures exceeded `LEDGER_RETRY_ATTEMPTS` without fatal halt.

### 5.2 Verification Query for Missing Ledgers
Run this query to check for any missing ledger sequences in the restored database:

```sql
SELECT
  sequence + 1 AS gap_start,
  next_seq - 1 AS gap_end,
  (next_seq - sequence - 1) AS missing_ledgers
FROM (
  SELECT
    sequence,
    LEAD(sequence) OVER (ORDER BY sequence) AS next_seq
  FROM ledgers
) t
WHERE next_seq > sequence + 1;
```
If the query returns 0 rows, the restored ledger history is completely continuous.

### 5.3 Remediating an Identified Gap
If a gap is ever detected between `gap_start` and `gap_end`:
1. Temporarily run a targeted indexer instance pointing to the gap range:
   ```bash
   START_LEDGER=<gap_start> npm run dev -w @lumina/indexer
   ```
2. Because `indexLedger` specifies `ON CONFLICT DO NOTHING`, already-indexed ledgers are safely skipped while missing ledgers are populated.

---

## 6. Post-Restore Verification Checklist

Execute these checks before reopening services to public traffic:

- [ ] **Row counts and tips**:
  ```sql
  SELECT 'ledgers' as table_name, count(*), max(sequence) as latest FROM ledgers
  UNION ALL
  SELECT 'transactions', count(*), max(ledger) FROM transactions
  UNION ALL
  SELECT 'contract_events', count(*), max(ledger_sequence) FROM contract_events;
  ```
- [ ] **Continuous sequence verification**:
  Execute the gap analysis query in Section 5.2.
- [ ] **Restart services**:
  ```bash
  docker compose -f docker/docker-compose.yml start indexer graphql
  ```
- [ ] **Health endpoint confirmation**:
  ```bash
  curl -s http://localhost:9090/health | jq .
  # Verify status is "ok" and lag is within HEALTH_MAX_LAG_LEDGERS
  ```
- [ ] **GraphQL query verification**:
  ```bash
  curl -s -X POST http://localhost:4000/graphql \
    -H "Content-Type: application/json" \
    -d '{"query":"{ latestLedgers(limit: 1) { sequence closedAt } }"}' | jq .
  ```
