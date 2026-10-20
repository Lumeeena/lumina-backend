/**
 * Soroban RPC client for the indexer.
 *
 * Talks directly to the RPC's JSON-RPC `getEvents` method (stable across
 * stellar-sdk versions) rather than going through the SDK's `rpc.Server`
 * wrapper, and uses `@stellar/stellar-sdk` only for XDR ScVal decoding.
 *
 * Indexing is opt-in: the indexer runs exactly as it does without any
 * Soroban configuration. Set SOROBAN_RPC_URL + INDEXED_CONTRACT_IDS to
 * enable it (see indexer/src/index.ts).
 *
 * ## Why direct JSON-RPC instead of the SDK's rpc.Server
 *
 * The SDK's `rpc.Server` wrapper is higher-level but ties the indexer to a
 * specific SDK version. JSON-RPC `getEvents` is a stable wire protocol — the
 * method name and parameter shape have not changed across SDK majors — so
 * using it directly lets the indexer stay on an older or newer SDK without
 * being blocked by wrapper API changes.
 *
 * ## Why contract IDs are split across multiple calls
 *
 * The Soroban RPC `getEvents` filter accepts at most `GET_EVENTS_MAX_CONTRACT_IDS`
 * contract IDs per call (currently 5). A list longer than that causes the
 * entire call to fail with an error. The indexer splits longer lists into
 * chunks and makes one call per chunk, sharing a per-cycle event budget across
 * all of them so the total number of decoded events stays bounded.
 *
 * ## Tuning constants
 *
 * `GET_LEDGER_ENTRIES_MAX_KEYS = 200` — the RPC's own page size for ledger
 * entry reads. Requests with more keys than this are split across multiple
 * calls and their results concatenated, preserving key order.
 *
 * `GET_EVENTS_MAX_CONTRACT_IDS = 5` — the RPC rejects a filter with more than
 * this many contract IDs. Split here rather than surface an opaque RPC error.
 *
 * `SOROBAN_MIN_REQUEST_INTERVAL_MS` (default 100 ms) — minimum spacing between
 * outbound Soroban RPC requests, matching the Horizon throttle default. Most
 * public RPC endpoints are more permissive than Horizon, but the same guard
 * prevents accidental burst traffic during backfill or a large contract list.
 * Override with the environment variable of the same name.
 *
 * `SOROBAN_REQUEST_TIMEOUT_MS` (default 10 s, the same as Horizon's) — how long
 * one JSON-RPC call may take, response body included. Event polling runs in the
 * same loop as ledger indexing, so a node that accepts a call and never answers
 * would otherwise stop ledger indexing too, for as long as the platform's own
 * fetch timeout (five minutes in Node) — and a call already hanging stays hung
 * after the node recovers. The clock starts when the call is made, so it also
 * covers the call's wait for the pacer above, which for these sequential calls
 * is at most one interval. The chaos suite's `soroban-hanging` scenario is the
 * measurement: see docs/CHAOS_TESTING.md.
 */
import { scValToNative, StrKey, xdr } from '@stellar/stellar-sdk';
import { sorobanRequestDuration, sorobanRequests } from './metrics';
import { createThrottle } from '@lumina/shared';
import { subsystem } from './logger';

const log = subsystem('soroban');

export const GET_LEDGER_ENTRIES_MAX_KEYS = 200;

/**
 * Soroban RPC accepts at most 5 contract ids in a single getEvents filter
 * (see the getEvents docs); a longer list fails the whole call. Longer lists
 * are split across several calls of this size.
 */
export const GET_EVENTS_MAX_CONTRACT_IDS = 5;

export interface ContractEvent {
  id: string;
  type: string;
  contractId: string;
  ledger: number;
  createdAt: string;
  pagingToken: string;
  topics: string[];
  value: unknown;
  /** The transaction that emitted the event, when the RPC supplied one. */
  transactionHash: string | null;
}

interface RpcEventRecord {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  topic: string[];
  value: string;
  /** Present on current RPC versions; older nodes may omit it. */
  txHash?: string;
  /** Used as a fallback when an older node omits txHash. */
  transactionIndex?: number;
}

interface RpcGetEventsResult {
  events?: RpcEventRecord[];
  latestLedger: number;
  cursor?: string;
}

export interface GetEventsResult {
  events: ContractEvent[];
  /** The RPC's current ledger at call time — use to advance the polling cursor. */
  latestLedger: number;
  /** Whether the result was truncated due to the per-cycle limit. */
  truncated: boolean;
}

export interface SorobanTransaction {
  txHash: string;
  status: string;
  ledger: number;
  createdAt: string;
  applicationOrder: number;
}

interface RpcTransactionRecord {
  status: string;
  txHash: string;
  ledger: number;
  createdAt: string;
  applicationOrder: number;
}

interface RpcGetTransactionsResult {
  transactions?: RpcTransactionRecord[];
  latestLedger: number;
  cursor?: string;
}

export interface LedgerEntryResult {
  entries: Array<{ key: string; xdr: string; lastModifiedLedgerSeq: number; liveUntilLedgerSeq?: number }>;
  latestLedger: number;
}

/**
 * Decode result: either the native value or a structured error.
 */
export type DecodeScValResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Decode an ScVal from base64 XDR to its native JavaScript representation.
 *
 * All ScVal types are supported: scalars, maps, vectors, nested structs, bytes,
 * addresses, and symbols. i128 and u128 values are decoded to bigint, which
 * preserves precision above 2^53 — callers must serialize them as strings for
 * JSON storage (see bigintReplacer in db.ts).
 *
 * Returns a structured result rather than throwing or returning null, so
 * undecodable entries are reported rather than silently dropped.
 */
export function decodeScVal(base64: string): DecodeScValResult {
  try {
    const scVal = xdr.ScVal.fromXDR(base64, 'base64');
    const value = scValToNative(scVal);
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Legacy decoding helper that returns null on failure.
 *
 * Used for backward compatibility where callers expect null on decode failure.
 * New code should use decodeScVal() and handle the structured result.
 */
function decodeScValLegacy(base64: string): unknown {
  try {
    return scValToNative(xdr.ScVal.fromXDR(base64, 'base64'));
  } catch {
    return null;
  }
}

const SOROBAN_MIN_REQUEST_INTERVAL_MS = parseInt(process.env.SOROBAN_MIN_REQUEST_INTERVAL_MS ?? '100', 10);
const SOROBAN_REQUEST_TIMEOUT_MS = parseInt(process.env.SOROBAN_REQUEST_TIMEOUT_MS ?? '10000', 10);

const { postJson } = createThrottle({
  name: 'soroban',
  minIntervalMs: SOROBAN_MIN_REQUEST_INTERVAL_MS,
  metrics: {
    requestsTotal: { inc: () => {} }, // no-op, we handle metrics in rpcCall
    requestDuration: sorobanRequestDuration,
  },
});

async function rpcCall<T>(rpcUrl: string, method: string, params: Record<string, unknown>): Promise<T> {
  const stopTimer = sorobanRequestDuration.startTimer();
  try {
    const body = await postJson<{ result?: T; error?: { message: string } }>(
      rpcUrl,
      { jsonrpc: '2.0', id: 1, method, params },
      { signal: AbortSignal.timeout(SOROBAN_REQUEST_TIMEOUT_MS) }
    );
    if (body.error) {
      sorobanRequests.inc({ method, outcome: 'error' });
      stopTimer();
      throw new Error(`Soroban RPC error in ${method}: ${body.error.message}`);
    }
    sorobanRequests.inc({ method, outcome: 'success' });
    stopTimer();
    return body.result as T;
  } catch (error) {
    sorobanRequests.inc({ method, outcome: 'error' });
    stopTimer();
    throw error;
  }
}

/** Fetch ledger keys in RPC-sized batches, preserving key order across responses. */
export async function getLedgerEntries(rpcUrl: string, keys: string[]): Promise<LedgerEntryResult> {
  if (keys.length === 0) return { entries: [], latestLedger: 0 };
  const entries: LedgerEntryResult['entries'] = [];
  let latestLedger = 0;
  for (let offset = 0; offset < keys.length; offset += GET_LEDGER_ENTRIES_MAX_KEYS) {
    const result = await rpcCall<RpcGetLedgerEntriesResult>(rpcUrl, 'getLedgerEntries', {
      keys: keys.slice(offset, offset + GET_LEDGER_ENTRIES_MAX_KEYS),
    });
    entries.push(...(result.entries ?? []).map(record => ({
      key: record.key,
      xdr: record.xdr,
      lastModifiedLedgerSeq: record.lastModifiedLedgerSeq,
      ...(record.liveUntilLedgerSeq !== undefined && { liveUntilLedgerSeq: record.liveUntilLedgerSeq }),
    })));
    latestLedger = Math.max(latestLedger, result.latestLedger ?? 0);
  }
  return { entries, latestLedger };
}

interface RpcGetLedgerEntriesResult {
  entries?: RpcLedgerEntryRecord[];
  latestLedger: number;
}

interface RpcLedgerEntryRecord {
  key: string; // base64 XDR LedgerKey
  xdr: string; // base64 XDR LedgerEntryData
  lastModifiedLedgerSeq: number;
  liveUntilLedgerSeq?: number;
}

// ─── Contract storage entries ──────────────────────────────────────────────

export type ContractStorageDurability = 'persistent' | 'temporary';

export interface ContractStorageEntry {
  contractId: string;
  /** The full LedgerKey (base64 XDR) that addresses this entry. */
  key: string;
  durability: ContractStorageDurability;
  /** Decoded native value, or null when the entry is absent/archived. */
  value: unknown;
  /** The raw LedgerEntryData (base64 XDR). */
  valueXdr: string;
  /** The ledger at which this entry's TTL expires, if the RPC reported one. */
  liveUntilLedgerSeq: number | null;
  lastModifiedLedgerSeq: number;
}

export interface GetContractStorageEntriesResult {
  entries: ContractStorageEntry[];
  latestLedger: number;
}

/**
 * Parse a base64 LedgerKey into the contract id and durability it names.
 *
 * Only `contractData` keys address contract storage; anything else is a caller
 * error, so it throws rather than silently producing a row that cannot be
 * filtered or fetched back.
 */
export function parseLedgerKey(keyXdr: string): { contractId: string; durability: ContractStorageDurability } {
  const key = xdr.LedgerKey.fromXDR(keyXdr, 'base64');
  if (key.switch().name !== 'contractData') {
    throw new Error(`refusing to index a non-contract-data ledger key (${key.switch().name}) as contract storage`);
  }
  const data = key.contractData();
  // A contractData key always addresses a contract, so the ScAddress is a
  // contract hash; the union's value() is typed wider than that.
  const contractHash = data.contract().value() as unknown as Buffer;
  const contractId = StrKey.encodeContract(contractHash);
  const durability = data.durability().name as ContractStorageDurability;
  return { contractId, durability };
}

/**
 * Fetch and parse the contract storage entries for the given LedgerKey XDRs.
 *
 * Each returned entry carries the key it was addressed by, the durability and
 * contract id decoded from that key, the decoded value, the raw LedgerEntryData
 * XDR, and the last-modified ledger. Keys the RPC does not return are simply
 * absent from `entries` — distinguishing "archived" from "never existed" is
 * the caller's job (see indexer/src/db.ts markContractStorageEntriesArchived).
 */
export async function getContractStorageEntries(
  rpcUrl: string,
  keys: string[]
): Promise<GetContractStorageEntriesResult> {
  const { entries: raw, latestLedger } = await getLedgerEntries(rpcUrl, keys);
  const entries: ContractStorageEntry[] = [];
  for (const record of raw) {
    const { contractId, durability } = parseLedgerKey(record.key);
    const data = xdr.LedgerEntryData.fromXDR(record.xdr, 'base64');
    let value: unknown = null;
    if (data.switch().name === 'contractData') {
      value = scValToNative(data.contractData().val());
    }
    entries.push({
      contractId,
      key: record.key,
      durability,
      value,
      valueXdr: record.xdr,
      liveUntilLedgerSeq: record.liveUntilLedgerSeq ?? null,
      lastModifiedLedgerSeq: record.lastModifiedLedgerSeq,
    });
  }
  return { entries, latestLedger };
}

/**
 * Fetch transactions for the ledger range containing a batch of events.
 * Soroban RPC pages this endpoint independently from getEvents, so keeping
 * this lookup bounded to the event range avoids scanning unrelated history.
 */
export async function getTransactions(
  rpcUrl: string,
  startLedger: number,
  endLedger: number,
  maxTransactions = 10_000,
): Promise<{ transactions: SorobanTransaction[]; latestLedger: number }> {
  const PAGE_LIMIT = 200;
  const transactions: SorobanTransaction[] = [];
  let cursor: string | undefined;
  let latestLedger = startLedger;

  while (transactions.length < maxTransactions) {
    const remaining = maxTransactions - transactions.length;
    const limit = Math.min(PAGE_LIMIT, remaining);
    const pagination: Record<string, unknown> = { limit };
    if (cursor) pagination.cursor = cursor;

    const params: Record<string, unknown> = cursor
      ? { pagination }
      : { startLedger, endLedger, pagination };
    const result = await rpcCall<RpcGetTransactionsResult>(rpcUrl, 'getTransactions', params);
    latestLedger = Math.max(latestLedger, result.latestLedger ?? 0);
    transactions.push(...(result.transactions ?? []).map(transaction => ({
      txHash: transaction.txHash,
      status: transaction.status,
      ledger: transaction.ledger,
      createdAt: transaction.createdAt,
      applicationOrder: transaction.applicationOrder,
    })));

    if (!result.cursor || transactions.length >= maxTransactions) break;
    cursor = result.cursor;
  }

  return { transactions, latestLedger };
}

/**
 * One `getEvents` call for a single contract-id chunk, following pagination
 * until the range is exhausted or the call's event budget is hit.
 *
 * Split out of getEvents because the RPC caps a filter at
 * GET_EVENTS_MAX_CONTRACT_IDS contract ids: a longer list fails the whole call,
 * so each chunk gets its own request. `records` are still raw — decoding is
 * getEvents' job, done once over every chunk's output.
 */
async function getEventsChunk(
  rpcUrl: string,
  contractIds: string[],
  startLedger: number,
  maxEvents: number
): Promise<{ records: RpcEventRecord[]; latestLedger: number; truncated: boolean }> {
  const PAGE_LIMIT = 200;
  const allEvents: RpcEventRecord[] = [];
  let cursor: string | undefined;
  let latestLedger = startLedger;
  let truncated = false;

  while (allEvents.length < maxEvents) {
    const remaining = maxEvents - allEvents.length;
    const limit = Math.min(PAGE_LIMIT, remaining);

    const pagination: Record<string, unknown> = { limit };
    if (cursor) {
      pagination.cursor = cursor;
    }

    const params: Record<string, unknown> = {
      startLedger,
      filters: [{ type: 'contract', contractIds }],
      pagination,
    };

    const result = await rpcCall<RpcGetEventsResult>(rpcUrl, 'getEvents', params);

    const events = result.events ?? [];
    allEvents.push(...events);
    latestLedger = Math.max(latestLedger, result.latestLedger ?? 0);

    if (events.length < limit) {
      break;
    }

    if (result.cursor && allEvents.length < maxEvents) {
      cursor = result.cursor;
    } else if (events.length === limit && allEvents.length >= maxEvents) {
      truncated = true;
      break;
    } else {
      break;
    }
  }

  return { records: allEvents, latestLedger, truncated };
}

/**
 * Fetches contract events for the given contract IDs starting at startLedger,
 * following pagination until the range is exhausted or the per-cycle limit is hit.
 * events is [] if none of the contract IDs emitted anything in range —
 * latestLedger is still returned so the caller can advance its cursor.
 */
export async function getEvents(
  rpcUrl: string,
  contractIds: string[],
  startLedger: number,
  maxEventsPerCycle: number
): Promise<GetEventsResult> {
  const unique = [...new Set(contractIds)];
  if (unique.length === 0) {
    return { events: [], latestLedger: startLedger, truncated: false };
  }

  const allEvents: RpcEventRecord[] = [];
  let latestLedger = startLedger;
  let truncated = false;

  // One call (with its own pagination) per chunk; the per-cycle event budget
  // is shared across chunks so the total stays bounded.
  for (let offset = 0; offset < unique.length; offset += GET_EVENTS_MAX_CONTRACT_IDS) {
    const remaining = maxEventsPerCycle - allEvents.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const chunk = unique.slice(offset, offset + GET_EVENTS_MAX_CONTRACT_IDS);
    const result = await getEventsChunk(rpcUrl, chunk, startLedger, remaining);
    allEvents.push(...result.records);
    latestLedger = Math.max(latestLedger, result.latestLedger);
    if (result.truncated) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    log.warn(
      { contractCount: unique.length, startLedger, eventsCollected: allEvents.length, maxEventsPerCycle },
      'Soroban getEvents truncated by per-cycle limit; remaining events will be fetched in subsequent cycles'
    );
  }

  let transactionByPosition = new Map<string, SorobanTransaction>();
  if (allEvents.length > 0) {
    const minEventLedger = Math.min(...allEvents.map(event => event.ledger));
    const maxEventLedger = Math.max(...allEvents.map(event => event.ledger));
    try {
      const transactionResult = await getTransactions(rpcUrl, minEventLedger, maxEventLedger + 1);
      transactionByPosition = new Map(
        transactionResult.transactions.map(transaction => [
          `${transaction.ledger}:${transaction.applicationOrder}`,
          transaction,
        ])
      );
    } catch (error) {
      // Event ingestion must remain useful when the provider's transaction
      // history is temporarily unavailable. Current RPC event records carry
      // txHash themselves; older records will remain explicitly unlinked.
      log.warn({ error: error instanceof Error ? error.message : String(error) }, 'could not resolve event transaction context');
    }
  }

  const mappedEvents = allEvents.map(record => ({
    id: record.id,
    type: record.type,
    contractId: record.contractId,
    ledger: record.ledger,
    createdAt: record.ledgerClosedAt,
    pagingToken: record.pagingToken,
    topics: record.topic.map(t => JSON.stringify(decodeScValLegacy(t))),
    value: decodeScValLegacy(record.value),
    transactionHash:
      record.txHash ?? transactionByPosition.get(`${record.ledger}:${record.transactionIndex}`)?.txHash ?? null,
  }));

  return { events: mappedEvents, latestLedger, truncated };
}

/** The RPC's current ledger — used to seed the event-polling cursor on first run. */
export async function getLatestLedgerSequence(rpcUrl: string): Promise<number> {
  const result = await rpcCall<{ sequence: number }>(rpcUrl, 'getLatestLedger', {});
  return result.sequence;
}

/**
 * Fetches the RPC's ledger retention window info.
 * Returns the oldest ledger the RPC can serve, or undefined if not available.
 */
export async function getRetentionInfo(rpcUrl: string): Promise<{ oldestLedger: number } | undefined> {
  try {
    const result = await rpcCall<{ oldestLedger: number }>(rpcUrl, 'getNetwork', {});
    return { oldestLedger: result.oldestLedger };
  } catch {
    return undefined;
  }
}
