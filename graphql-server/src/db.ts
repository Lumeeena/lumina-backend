/**
 * PostgreSQL-backed query layer for the GraphQL resolvers. All functions
 * take a `Pool` (or anything with a compatible `.query()`) so tests can
 * inject a fake client the same way indexer/src/db.test.ts does.
 */
import { Pool } from 'pg';

// ─── Row shapes (snake_case, matching db/schema.sql) ──────────────────────────

interface LedgerRow {
  sequence: string;
  network: string;
  closed_at: Date;
  transaction_count: number;
  operation_count: number;
  base_fee: string;
  base_reserve: string;
}

export interface TransactionRow {
  hash: string;
  network: string;
  ledger: string;
  created_at: Date;
  source_account: string;
  fee_charged: string;
  operation_count: number;
  successful: boolean;
  memo_type: string | null;
  memo: string | null;
}

export interface OperationRow {
  id: string;
  network: string;
  type: string;
  transaction_hash: string;
  ledger: string;
  created_at: Date;
  source_account: string;
  details: Record<string, unknown>;
}

interface AccountRow {
  address: string;
  network: string;
  sequence: string;
  subentry_count: number;
  last_modified_ledger: string;
  num_sponsored: number;
  num_sponsoring: number;
  balances: HorizonBalance[];
  flags: Record<string, boolean>;
  thresholds: Record<string, number>;
}

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
}

interface EventRow {
  id: string;
  network: string;
  type: string;
  contract_id: string;
  ledger: string;
  created_at: Date;
  paging_token: string;
  topics: string[];
  value: unknown;
}

// ─── GraphQL-shaped mappers (camelCase, matching schema.graphql) ──────────────

export function mapLedger(row: LedgerRow) {
  return {
    network: row.network,
    sequence: Number(row.sequence),
    closedAt: row.closed_at.toISOString(),
    transactionCount: row.transaction_count,
    operationCount: row.operation_count,
    baseFee: Number(row.base_fee),
    baseReserve: Number(row.base_reserve),
  };
}

export function mapTransaction(row: TransactionRow) {
  return {
    network: row.network,
    hash: row.hash,
    ledger: Number(row.ledger),
    createdAt: row.created_at.toISOString(),
    sourceAccount: row.source_account,
    feeCharged: row.fee_charged,
    operationCount: row.operation_count,
    successful: row.successful,
    memoType: row.memo_type,
    memo: row.memo,
  };
}

/** Horizon's asset_type/asset_code/asset_issuer triplet, collapsed to the single string GraphQL exposes. */
function formatAsset(type?: string, code?: string, issuer?: string): string | null {
  if (!type) return null;
  if (type === 'native') return 'XLM';
  return `${code}:${issuer}`;
}

export function mapOperation(row: OperationRow) {
  const d = row.details;
  return {
    network: row.network,
    id: row.id,
    type: row.type.toUpperCase(),
    createdAt: row.created_at.toISOString(),
    transactionHash: row.transaction_hash,
    sourceAccount: row.source_account,
    from: (d['from'] as string) ?? null,
    to: (d['to'] as string) ?? null,
    amount: (d['amount'] as string) ?? null,
    asset: formatAsset(d['asset_type'] as string, d['asset_code'] as string, d['asset_issuer'] as string),
    startingBalance: (d['starting_balance'] as string) ?? null,
    funder: (d['funder'] as string) ?? null,
    offerId: (d['offer_id'] as string) ?? null,
    price: (d['price'] as string) ?? null,
    selling: formatAsset(d['selling_asset_type'] as string, d['selling_asset_code'] as string, d['selling_asset_issuer'] as string),
    buying: formatAsset(d['buying_asset_type'] as string, d['buying_asset_code'] as string, d['buying_asset_issuer'] as string),
  };
}

export interface NormalizedAccount {
  network: string;
  address: string;
  sequence: string;
  subentry_count: number;
  last_modified_ledger: number;
  num_sponsored: number;
  num_sponsoring: number;
  balances: HorizonBalance[];
  flags: Record<string, boolean>;
  thresholds: Record<string, number>;
}

export function mapAccount(a: NormalizedAccount) {
  return {
    network: a.network,
    address: a.address,
    sequence: a.sequence,
    subentryCount: a.subentry_count,
    lastModifiedLedger: a.last_modified_ledger,
    numSponsored: a.num_sponsored,
    numSponsoring: a.num_sponsoring,
    balances: a.balances.map(b => ({
      assetType: b.asset_type,
      assetCode: b.asset_code ?? null,
      assetIssuer: b.asset_issuer ?? null,
      balance: b.balance,
      limit: b.limit ?? null,
      buyingLiabilities: b.buying_liabilities ?? null,
      sellingLiabilities: b.selling_liabilities ?? null,
    })),
    flags: {
      authRequired: a.flags['auth_required'] ?? false,
      authRevocable: a.flags['auth_revocable'] ?? false,
      authImmutable: a.flags['auth_immutable'] ?? false,
      authClawbackEnabled: a.flags['auth_clawback_enabled'] ?? false,
    },
    thresholds: {
      lowThreshold: a.thresholds['low_threshold'] ?? 0,
      medThreshold: a.thresholds['med_threshold'] ?? 0,
      highThreshold: a.thresholds['high_threshold'] ?? 0,
    },
  };
}

export function mapEvent(row: EventRow) {
  return {
    network: row.network,
    id: row.id,
    type: row.type,
    contractId: row.contract_id,
    ledger: Number(row.ledger),
    createdAt: row.created_at.toISOString(),
    pagingToken: row.paging_token,
    topics: row.topics,
    value: row.value === null ? null : JSON.stringify(row.value),
  };
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function getTransactions(pool: Pool, network: string, limit: number, cursor?: string | null) {
  const { rows } = await pool.query<TransactionRow>(
    `SELECT * FROM transactions
     WHERE network = $1
       AND ($3::text IS NULL OR (ledger, hash) < (SELECT ledger, hash FROM transactions WHERE hash = $3 AND network = $1))
     ORDER BY ledger DESC, hash DESC
     LIMIT $2`,
    [network, limit, cursor ?? null]
  );
  return rows.map(mapTransaction);
}

export async function getTransactionByHash(pool: Pool, network: string, hash: string) {
  const { rows } = await pool.query<TransactionRow>(
    'SELECT * FROM transactions WHERE hash = $1 AND network = $2',
    [hash, network]
  );
  return rows[0] ? mapTransaction(rows[0]) : null;
}

export async function getTransactionsByHashes(pool: Pool, network: string, hashes: readonly string[]) {
  if (hashes.length === 0) return new Map<string, ReturnType<typeof mapTransaction>>();
  const { rows } = await pool.query<TransactionRow>(
    'SELECT * FROM transactions WHERE hash = ANY($1::text[]) AND network = $2',
    [hashes, network]
  );
  return new Map(rows.map(row => [row.hash, mapTransaction(row)]));
}

export async function getOperations(
  pool: Pool,
  opts: {
    network: string;
    account?: string | null;
    type?: string | null;
    limit: number;
    cursor?: string | null;
  }
) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  params.push(opts.network);
  conditions.push(`network = $${params.length}`);

  if (opts.account) {
    params.push(opts.account);
    conditions.push(`source_account = $${params.length}`);
  }
  if (opts.type) {
    params.push(opts.type.toLowerCase());
    conditions.push(`type = $${params.length}`);
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    // The cursor's own row is looked up inside the same network: an operation
    // id repeats across networks now that the key is composite.
    conditions.push(
      `(ledger, id) < (SELECT ledger, id FROM operations WHERE id = $${params.length} AND network = $1)`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(opts.limit);

  const { rows } = await pool.query<OperationRow>(
    `SELECT * FROM operations ${where} ORDER BY ledger DESC, id DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(mapOperation);
}

export async function getOperationsByTransactionHash(pool: Pool, network: string, hash: string) {
  const { rows } = await pool.query<OperationRow>(
    'SELECT * FROM operations WHERE transaction_hash = $1 AND network = $2 ORDER BY id ASC',
    [hash, network]
  );
  return rows.map(mapOperation);
}

export async function getOperationsByTransactionHashes(
  pool: Pool,
  network: string,
  hashes: readonly string[]
) {
  if (hashes.length === 0) return new Map<string, ReturnType<typeof mapOperation>[]>();
  const { rows } = await pool.query<OperationRow>(
    'SELECT * FROM operations WHERE transaction_hash = ANY($1::text[]) AND network = $2 ORDER BY transaction_hash ASC, id ASC',
    [hashes, network]
  );
  const byHash = new Map<string, ReturnType<typeof mapOperation>[]>();
  for (const row of rows) {
    const mapped = mapOperation(row);
    const existing = byHash.get(row.transaction_hash);
    if (existing) existing.push(mapped);
    else byHash.set(row.transaction_hash, [mapped]);
  }
  return byHash;
}

export async function getLedgerBySequence(pool: Pool, network: string, sequence: number) {
  const { rows } = await pool.query<LedgerRow>(
    'SELECT * FROM ledgers WHERE sequence = $1 AND network = $2',
    [sequence, network]
  );
  return rows[0] ? mapLedger(rows[0]) : null;
}

export async function getLedgersBySequences(pool: Pool, network: string, sequences: readonly number[]) {
  if (sequences.length === 0) return new Map<number, ReturnType<typeof mapLedger>>();
  const { rows } = await pool.query<LedgerRow>(
    'SELECT * FROM ledgers WHERE sequence = ANY($1::bigint[]) AND network = $2',
    [sequences, network]
  );
  return new Map(rows.map(row => [Number(row.sequence), mapLedger(row)]));
}

export async function getLatestLedgerFromDb(pool: Pool, network: string) {
  const { rows } = await pool.query<LedgerRow>(
    'SELECT * FROM ledgers WHERE network = $1 ORDER BY sequence DESC LIMIT 1',
    [network]
  );
  return rows[0] ? mapLedger(rows[0]) : null;
}

/**
 * The indexed tip for one network: the highest ledger it has written and when
 * that write happened. `indexerStatus` reports it against Horizon's tip to say
 * how stale the data is — the read that question needs, in one round trip.
 */
export async function getIndexedTip(
  pool: Pool,
  network: string
): Promise<{ sequence: number | null; indexedAt: string | null }> {
  const { rows } = await pool.query<{ sequence: string | null; indexed_at: Date | null }>(
    'SELECT MAX(sequence) AS sequence, MAX(indexed_at) AS indexed_at FROM ledgers WHERE network = $1',
    [network]
  );
  const row = rows[0];
  return {
    sequence: row?.sequence == null ? null : Number(row.sequence),
    indexedAt: row?.indexed_at == null ? null : row.indexed_at.toISOString(),
  };
}

export async function getAccountFromDb(pool: Pool, network: string, address: string) {
  const { rows } = await pool.query<AccountRow>(
    'SELECT * FROM accounts WHERE address = $1 AND network = $2',
    [address, network]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return mapAccount({
    network: row.network,
    address: row.address,
    sequence: row.sequence,
    subentry_count: row.subentry_count,
    last_modified_ledger: Number(row.last_modified_ledger),
    num_sponsored: row.num_sponsored,
    num_sponsoring: row.num_sponsoring,
    balances: row.balances,
    flags: row.flags,
    thresholds: row.thresholds,
  });
}

export async function getAccountsFromDb(pool: Pool, network: string, addresses: readonly string[]) {
  if (addresses.length === 0) return new Map<string, ReturnType<typeof mapAccount>>();
  const { rows } = await pool.query<AccountRow>(
    'SELECT * FROM accounts WHERE address = ANY($1::text[]) AND network = $2',
    [addresses, network]
  );
  return new Map(rows.map(row => [
    row.address,
    mapAccount({
      network: row.network,
      address: row.address,
      sequence: row.sequence,
      subentry_count: row.subentry_count,
      last_modified_ledger: Number(row.last_modified_ledger),
      num_sponsored: row.num_sponsored,
      num_sponsoring: row.num_sponsoring,
      balances: row.balances,
      flags: row.flags,
      thresholds: row.thresholds,
    }),
  ]));
}

export async function getAccountTransactions(pool: Pool, network: string, address: string, limit: number) {
  const { rows } = await pool.query<TransactionRow>(
    'SELECT * FROM transactions WHERE source_account = $1 AND network = $2 ORDER BY ledger DESC LIMIT $3',
    [address, network, limit]
  );
  return rows.map(mapTransaction);
}

export async function getAccountOperations(pool: Pool, network: string, address: string, limit: number) {
  const { rows } = await pool.query<OperationRow>(
    'SELECT * FROM operations WHERE source_account = $1 AND network = $2 ORDER BY ledger DESC LIMIT $3',
    [address, network, limit]
  );
  return rows.map(mapOperation);
}

export async function getEventsByContract(
  pool: Pool,
  opts: {
    network: string;
    contractId: string;
    topic?: string | null;
    limit: number;
    cursor?: string | null;
  }
) {
  const conditions = ['contract_id = $1'];
  const params: unknown[] = [opts.contractId];

  params.push(opts.network);
  conditions.push(`network = $${params.length}`);

  if (opts.topic) {
    params.push(opts.topic);
    conditions.push(`$${params.length} = ANY(topics)`);
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    conditions.push(
      `(ledger, id) < (SELECT ledger, id FROM contract_events WHERE id = $${params.length} AND network = $2)`
    );
  }

  params.push(opts.limit);

  const { rows } = await pool.query<EventRow>(
    `SELECT * FROM contract_events WHERE ${conditions.join(' AND ')} ORDER BY ledger DESC, id DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(mapEvent);
}

/**
 * Transactions belonging to one ledger, oldest first.
 *
 * Ordered ascending because a subscriber is replaying the ledger in the order
 * it happened, which is the opposite of every paginated query above.
 */
export async function getTransactionsByLedger(pool: Pool, network: string, ledger: number) {
  const { rows } = await pool.query<TransactionRow>(
    'SELECT * FROM transactions WHERE ledger = $1 AND network = $2 ORDER BY hash ASC',
    [ledger, network]
  );
  return rows.map(mapTransaction);
}

/**
 * Operations in one ledger that *touch* `address` — not merely those it
 * submitted.
 *
 * `source_account` alone would miss the case people care about most: being paid.
 * The counterparty fields live in the `details` JSONB, so they are matched
 * there. `account` covers account creation/merge, `funder` covers a sponsored
 * create.
 */
export async function getAccountOperationsInLedger(
  pool: Pool,
  network: string,
  ledger: number,
  address: string
) {
  const { rows } = await pool.query<OperationRow>(
    `SELECT * FROM operations
      WHERE ledger = $1
        AND network = $3
        AND ( source_account = $2
           OR details->>'from'    = $2
           OR details->>'to'      = $2
           OR details->>'account' = $2
           OR details->>'funder'  = $2 )
      ORDER BY id ASC`,
    [ledger, address, network]
  );
  return rows.map(mapOperation);
}
