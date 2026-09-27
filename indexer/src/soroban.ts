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
 */
import { scValToNative, StrKey, xdr } from '@stellar/stellar-sdk';
import { sorobanRequestDuration, sorobanRequests } from './metrics';
import { createThrottle } from './throttle';
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

export interface LedgerEntryResult {
  entries: Array<{ key: string; xdr: string; lastModifiedLedgerSeq: number; liveUntilLedgerSeq?: number }>;
  latestLedger: number;
}

function decodeScVal(base64: string): unknown {
  try {
    return scValToNative(xdr.ScVal.fromXDR(base64, 'base64'));
  } catch {
    return null;
  }
}

const SOROBAN_MIN_REQUEST_INTERVAL_MS = parseInt(process.env.SOROBAN_MIN_REQUEST_INTERVAL_MS ?? '100', 10);

const { throttle, postJson } = createThrottle({
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
    const body = await postJson<{ result?: T; error?: { message: string } }>(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });
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
 * Fetches contract events for the given contract IDs starting at startLedger,
 * following pagination until the range is exhausted or the per-cycle limit is hit.
 * events is [] if none of the contract IDs emitted anything in range —
 * latestLedger is still returned so the caller can advance its cursor.
 */
export async function getEvents(
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

  const mappedEvents = allEvents.map(record => ({
    id: record.id,
    type: record.type,
    contractId: record.contractId,
    ledger: record.ledger,
    createdAt: record.ledgerClosedAt,
    pagingToken: record.pagingToken,
    topics: record.topic.map(t => JSON.stringify(decodeScVal(t))),
    value: decodeScVal(record.value),
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