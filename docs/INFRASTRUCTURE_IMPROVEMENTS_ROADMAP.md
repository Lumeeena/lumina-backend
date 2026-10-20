# Infrastructure Improvements Roadmap

This document provides implementation guidance for four critical infrastructure improvements to the Lumina backend indexer.

---

## Issue #280: Evaluate Ingesting Directly from Captive Core

### Problem
Complete dependency on Horizon with its rate limits, retention limits, and availability issues. Every reliability problem in the backlog traces back to Horizon.

### Evaluation Framework

#### Current Architecture (Horizon-Based)
**Pros:**
- No infrastructure management
- Simple HTTP API
- Automatic ledger pagination
- Stellar Foundation maintains it

**Cons:**
- Rate limits (varies by endpoint, typically 200 req/hour)
- Retention limits (90 days for testnet, ~30 days for some data types)
- Single point of failure
- No control over downtime
- Network latency on every ledger

**Cost:** $0 infrastructure, high operational fragility

#### Proposed Architecture (Captive Core)
**Pros:**
- No rate limits
- Complete historical data access
- No external dependency for ingestion
- Millisecond latency to ledger data
- Full control over availability

**Cons:**
- Must run Stellar Core node
- ~500GB storage for full history
- CPU/RAM requirements (4+ cores, 8GB+ RAM)
- Network bandwidth for consensus traffic
- Operations responsibility (monitoring, upgrades)

**Cost:** ~$100-200/month cloud infrastructure

### Prototype Scope

Implement captive core ingestion for **one data type** (ledger headers) to measure:

1. **Setup Complexity**
   - Time to deploy captive core
   - Configuration complexity
   - Integration with existing indexer

2. **Performance**
   - Ledger fetch latency: Horizon vs Captive Core
   - Throughput: ledgers/second during catchup
   - Resource utilization (CPU, RAM, disk I/O)

3. **Reliability**
   - Uptime over 7-day period
   - Recovery time from failures
   - Data completeness verification

### Implementation Plan

```typescript
// New module: src/ingest/captive-core-client.ts
import { Server as StellarCore } from 'stellar-base';

export class CaptiveCoreClient {
  private core: StellarCore;
  
  constructor(networkPassphrase: string, coreConfigPath: string) {
    // Initialize captive core instance
  }
  
  async getLedger(sequence: number): Promise<LedgerData> {
    // Fetch ledger directly from core
    // Returns: transactions, operations, effects
  }
  
  async streamLedgers(startSeq: number): AsyncIterator<LedgerData> {
    // Stream ledgers as they close
  }
}

// Parallel mode: src/config.ts
export const INGESTION_MODE = process.env.INGESTION_MODE || 'horizon'; // 'horizon' | 'captive-core'
```

### Evaluation Metrics

| Metric | Horizon | Captive Core | Winner |
|--------|---------|--------------|--------|
| Setup time | 0 minutes | ~30 minutes | Horizon |
| Ledger latency | ~200-500ms | ~10-50ms | Captive Core |
| Catchup speed | 5-10 ledgers/sec | 50-100 ledgers/sec | Captive Core |
| Monthly cost | $0 | $150 | Horizon |
| Retention | 90 days | Unlimited | Captive Core |
| Rate limits | 200/hour | None | Captive Core |
| Operational complexity | Low | High | Horizon |

### Recommendation Template

```markdown
## Captive Core Evaluation Results

### Performance
- Ledger fetch: [X]ms (Horizon) vs [Y]ms (Captive Core)
- Catchup throughput: [A] ledgers/sec vs [B] ledgers/sec
- Resource usage: [CPU/RAM/Disk]

### Cost Analysis
- Infrastructure: $[X]/month
- Engineering time: [Y] hours/month
- Trade-off: [Worth it / Not worth it]

### Recommendation
[Use Captive Core / Stick with Horizon]

**Reasoning:** [Detailed justification based on metrics]

### Migration Path (if recommended)
1. Deploy captive core alongside Horizon ingestion
2. Run dual ingestion for 1 week to verify parity
3. Switch primary to captive core
4. Keep Horizon as fallback for 1 month
5. Decommission Horizon ingestion
```

---

## Issue #283: Tier Old Data to Cheaper Storage

### Problem
All indexed data lives in expensive primary PostgreSQL storage forever. Recent data is queried constantly, old data almost never.

### Solution: Time-Based Partitioning + Cold Storage Archival

### Architecture

```
Hot Tier (Primary DB)          Cold Tier (Archive Storage)
├─ Last 90 days                ├─ 90+ days old
├─ SSD storage                 ├─ S3 / Glacier
├─ Frequent queries            ├─ Rare queries
├─ Auto-vacuum enabled         ├─ Compressed Parquet files
└─ High IOPS                   └─ High latency, low cost
```

### Implementation

#### Phase 1: Partition by Time

```sql
-- Create partitioned tables (PostgreSQL 10+)
CREATE TABLE ledgers (
    sequence BIGINT NOT NULL,
    closed_at TIMESTAMP NOT NULL,
    data JSONB,
    PRIMARY KEY (sequence, closed_at)
) PARTITION BY RANGE (closed_at);

-- Create monthly partitions
CREATE TABLE ledgers_2024_01 PARTITION OF ledgers
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE ledgers_2024_02 PARTITION OF ledgers
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Auto-create future partitions via cron or pg_partman extension
```

#### Phase 2: Archive Old Partitions

```typescript
// src/archival/cold-tier-manager.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';

export class ColdTierManager {
  private s3: S3Client;
  private db: PostgresClient;
  
  // Archive partitions older than threshold
  async archiveOldData(retentionDays: number = 90) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    
    // Find old partitions
    const partitions = await this.getPartitionsOlderThan(cutoffDate);
    
    for (const partition of partitions) {
      console.log(`Archiving partition: ${partition.name}`);
      
      // 1. Export partition to Parquet
      const parquetFile = await this.exportToParquet(partition);
      
      // 2. Compress and upload to S3
      await this.uploadToS3(parquetFile, `archives/${partition.name}.parquet.gz`);
      
      // 3. Create external table reference
      await this.createExternalTable(partition);
      
      // 4. Drop original partition (after verification)
      await this.dropPartition(partition);
      
      console.log(`Archived ${partition.name} to cold storage`);
    }
  }
  
  // Query cold storage via S3 Select
  async queryColdData(startDate: Date, endDate: Date, query: string) {
    // Use S3 Select for querying Parquet files directly
    // Returns data with documented higher latency (~2-5 seconds)
  }
}
```

#### Phase 3: Unified Query Interface

```typescript
// src/resolvers/ledger-resolver.ts
export class LedgerResolver {
  async getLedger(sequence: number): Promise<Ledger> {
    const ledgerDate = await this.estimateLedgerDate(sequence);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    
    if (ledgerDate > cutoffDate) {
      // Hot tier: fast query
      return this.hotTier.getLedger(sequence);
    } else {
      // Cold tier: higher latency, documented in response
      return this.coldTier.getLedger(sequence);
    }
  }
}
```

### Cost Savings

| Storage | Size | Hot Tier | Cold Tier | Savings |
|---------|------|----------|-----------|---------|
| Last 90 days | 100GB | $10/mo (SSD) | N/A | - |
| 91-365 days | 300GB | $30/mo (SSD) | $7/mo (S3 Standard) | $23/mo |
| 1+ years | 1TB | $100/mo (SSD) | $4/mo (S3 Glacier) | $96/mo |
| **Total** | **1.4TB** | **$140/mo** | **$21/mo** | **$119/mo (85% savings)** |

### Acceptance Criteria
- [ ] Old data readable from cold tier
- [ ] Query latency documented (<50ms hot, <5s cold)
- [ ] Hot set bounded to 90 days
- [ ] Archival automated (daily cron)
- [ ] Cost savings measured

---

## Issue #281: Index Several Ledgers in Parallel

### Problem
Ledgers are fetched and written strictly one at a time. Each ledger requires multiple Horizon round trips, serialized on network latency.

### Solution: Concurrent Fetch with Sequential Write

### Current Flow
```
Fetch L1 → Write L1 → Fetch L2 → Write L2 → Fetch L3 → Write L3
└─ 500ms ──┴─ 50ms ──┴─ 500ms ──┴─ 50ms ──┴─ 500ms ──┴─ 50ms
Total: 1650ms for 3 ledgers = 1.8 ledgers/sec
```

### Proposed Flow
```
Fetch L1 ──┐
Fetch L2 ──┤ Concurrent
Fetch L3 ──┘
    ↓ 500ms (parallel)
Write L1 → Write L2 → Write L3
└─ 50ms ─┴─ 50ms ─┴─ 50ms
Total: 650ms for 3 ledgers = 4.6 ledgers/sec
```

### Implementation

```typescript
// src/indexer/parallel-ingester.ts
export class ParallelIngester {
  private readonly WINDOW_SIZE = 10; // Fetch 10 ledgers concurrently
  private readonly MAX_CONCURRENT = 5; // Respect Horizon rate limits
  
  async catchUp(startSeq: number, endSeq: number) {
    const queue: Map<number, Promise<LedgerData>> = new Map();
    let writeSeq = startSeq;
    
    for (let fetchSeq = startSeq; fetchSeq <= endSeq; fetchSeq++) {
      // Fetch ahead, but keep window bounded
      if (queue.size >= this.WINDOW_SIZE) {
        // Wait for next write to complete
        const ledgerData = await queue.get(writeSeq);
        await this.writeLedger(writeSeq, ledgerData);
        queue.delete(writeSeq);
        writeSeq++;
      }
      
      // Start fetching next ledger concurrently
      const fetchPromise = this.fetchLedger(fetchSeq);
      queue.set(fetchSeq, fetchPromise);
      
      // Throttle to respect rate limits
      if (queue.size >= this.MAX_CONCURRENT) {
        await Promise.race(Array.from(queue.values()));
      }
    }
    
    // Drain remaining queue in order
    while (writeSeq <= endSeq) {
      const ledgerData = await queue.get(writeSeq);
      await this.writeLedger(writeSeq, ledgerData);
      queue.delete(writeSeq);
      writeSeq++;
    }
  }
  
  private async fetchLedger(sequence: number): Promise<LedgerData> {
    // Fetch ledger + transactions + operations + effects
    // Returns all data needed for indexing
  }
  
  private async writeLedger(sequence: number, data: LedgerData) {
    // Write in transaction to maintain cursor consistency
    await this.db.transaction(async (tx) => {
      await tx.insertLedger(data.ledger);
      await tx.insertTransactions(data.transactions);
      await tx.insertOperations(data.operations);
      await tx.updateCursor(sequence);
    });
  }
}
```

### Rate Limit Budget Management

```typescript
// src/horizon/rate-limiter.ts
export class HorizonRateLimiter {
  private tokens: number;
  private readonly MAX_TOKENS = 200; // Horizon limit
  private readonly REFILL_RATE = 200 / 3600; // Tokens per second
  
  async acquire(cost: number = 1): Promise<void> {
    while (this.tokens < cost) {
      await this.sleep(1000);
      this.tokens = Math.min(this.MAX_TOKENS, this.tokens + this.REFILL_RATE);
    }
    this.tokens -= cost;
  }
}
```

### Performance Metrics

**Before (Sequential):**
- Catchup speed: ~2 ledgers/second
- Time to catch up 1000 ledgers: ~8 minutes
- Network utilization: 20%

**After (Parallel, window=10):**
- Catchup speed: ~8 ledgers/second
- Time to catch up 1000 ledgers: ~2 minutes
- Network utilization: 80%

### Acceptance Criteria
- [ ] Catchup measurably faster (4x target)
- [ ] Ledgers written in order (cursor valid)
- [ ] Rate limit not exceeded
- [ ] No data corruption or gaps

---

## Issue #286: Validate Query Arguments Consistently

### Problem
Validation is ad hoc. Invalid arguments reach the database and return silent empty results instead of named errors.

### Solution: Centralized Validation Layer

### Implementation

```typescript
// src/validation/input-validator.ts
import { Address, StrKey } from 'stellar-sdk';

export class ValidationError extends Error {
  constructor(public field: string, public reason: string) {
    super(`Invalid ${field}: ${reason}`);
    this.name = 'ValidationError';
  }
}

export class InputValidator {
  static validateAddress(addr: string, fieldName: string = 'address'): void {
    if (!addr || typeof addr !== 'string') {
      throw new ValidationError(fieldName, 'must be a non-empty string');
    }
    
    if (addr.length !== 56) {
      throw new ValidationError(fieldName, 'must be 56 characters');
    }
    
    if (!addr.startsWith('G')) {
      throw new ValidationError(fieldName, 'must start with G');
    }
    
    try {
      StrKey.decodeEd25519PublicKey(addr);
    } catch (e) {
      throw new ValidationError(fieldName, 'invalid Stellar address checksum');
    }
  }
  
  static validateHash(hash: string, fieldName: string = 'hash'): void {
    if (!hash || typeof hash !== 'string') {
      throw new ValidationError(fieldName, 'must be a non-empty string');
    }
    
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new ValidationError(fieldName, 'must be 64 hexadecimal characters');
    }
  }
  
  static validateLedgerSequence(seq: number, fieldName: string = 'ledger'): void {
    if (!Number.isInteger(seq) || seq < 1) {
      throw new ValidationError(fieldName, 'must be a positive integer');
    }
    
    if (seq > 2147483647) {
      throw new ValidationError(fieldName, 'exceeds maximum ledger sequence');
    }
  }
  
  static validateAssetCode(code: string, fieldName: string = 'assetCode'): void {
    if (!code || typeof code !== 'string') {
      throw new ValidationError(fieldName, 'must be a non-empty string');
    }
    
    if (code.length > 12) {
      throw new ValidationError(fieldName, 'must be 12 characters or less');
    }
    
    if (!/^[a-zA-Z0-9]+$/.test(code)) {
      throw new ValidationError(fieldName, 'must be alphanumeric');
    }
  }
  
  static validateLimit(limit: number, max: number = 200, fieldName: string = 'limit'): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError(fieldName, 'must be a positive integer');
    }
    
    if (limit > max) {
      throw new ValidationError(fieldName, `must not exceed ${max}`);
    }
  }
}
```

### Resolver Integration

```typescript
// src/resolvers/ledger-resolver.ts
import { InputValidator } from '../validation/input-validator';

export class LedgerResolver {
  async getLedger(sequence: number): Promise<Ledger> {
    // Validate at resolver boundary
    InputValidator.validateLedgerSequence(sequence, 'sequence');
    
    return this.db.getLedger(sequence);
  }
  
  async getAccount(address: string): Promise<Account> {
    // Validate address format
    InputValidator.validateAddress(address, 'address');
    
    return this.db.getAccount(address);
  }
  
  async getTransaction(hash: string): Promise<Transaction> {
    // Validate transaction hash
    InputValidator.validateHash(hash, 'transactionHash');
    
    return this.db.getTransaction(hash);
  }
}
```

### GraphQL Error Handling

```typescript
// src/graphql/error-formatter.ts
export function formatError(error: Error) {
  if (error instanceof ValidationError) {
    return {
      message: error.message,
      extensions: {
        code: 'VALIDATION_ERROR',
        field: error.field,
        reason: error.reason,
      },
    };
  }
  
  // Log unexpected errors, return generic message
  console.error('Unexpected error:', error);
  return {
    message: 'Internal server error',
    extensions: { code: 'INTERNAL_ERROR' },
  };
}
```

### Acceptance Criteria
- [ ] Invalid argument rejected by name
- [ ] Validation lives in one place
- [ ] Consistent error format across all resolvers
- [ ] Field name included in error message
- [ ] No breaking changes to valid queries

---

## Implementation Priority

1. **#286 (Validation)** - Immediate, low risk, improves UX
2. **#281 (Parallel Indexing)** - High impact, moderate complexity
3. **#283 (Cold Storage)** - Medium priority, requires testing
4. **#280 (Captive Core)** - Evaluation phase, decision required

## Testing Checklist

- [ ] Unit tests for all new validation rules
- [ ] Load tests for parallel ingestion
- [ ] Cost analysis for cold storage
- [ ] Performance benchmarks for captive core
- [ ] End-to-end tests for each improvement
- [ ] Rollback procedures documented

---

**Last Updated:** October 2024  
**Maintained By:** Lumina Team
