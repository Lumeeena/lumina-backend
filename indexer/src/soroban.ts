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
import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { sorobanRequests } from './metrics';

export const GET_LEDGER_ENTRIES_MAX_KEYS = 200;

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
  value: string; // base64 XDR ScVal
}

interface RpcGetEventsResult {
  events?: RpcEventRecord[];
  latestLedger: number;
}

export interface GetEventsResult {
  events: ContractEvent[];
  /** The RPC's current ledger at call time — use to advance the polling cursor. */
  latestLedger: number;
}

export interface LedgerEntryResult {
  entries: Array<{ key: string; xdr: string; lastModifiedLedgerSeq: number }>;
  latestLedger: number;
}

function decodeScVal(base64: string): unknown {
  try {
    return scValToNative(xdr.ScVal.fromXDR(base64, 'base64'));
  } catch {
    return null;
  }
}

async function rpcCall<T>(rpcUrl: string, method: string, params: Record<string, unknown>): Promise<T> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`Soroban RPC request failed (${res.status}): ${method}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`Soroban RPC error in ${method}: ${body.error.message}`);
    sorobanRequests.inc({ method, outcome: 'success' });
    return body.result as T;
  } catch (error) {
    sorobanRequests.inc({ method, outcome: 'error' });
    throw error;
  }
}

/** Fetch ledger keys in RPC-sized batches, preserving key order across responses. */
export async function getLedgerEntries(rpcUrl: string, keys: string[]): Promise<LedgerEntryResult> {
  if (keys.length === 0) return { entries: [], latestLedger: 0 };
  const entries: LedgerEntryResult['entries'] = [];
  let latestLedger = 0;
  for (let offset = 0; offset < keys.length; offset += GET_LEDGER_ENTRIES_MAX_KEYS) {
    const result = await rpcCall<LedgerEntryResult>(rpcUrl, 'getLedgerEntries', {
      keys: keys.slice(offset, offset + GET_LEDGER_ENTRIES_MAX_KEYS),
    });
    entries.push(...(result.entries ?? []));
    latestLedger = Math.max(latestLedger, result.latestLedger ?? 0);
  }
  return { entries, latestLedger };
}

/**
 * Fetches contract events for the given contract IDs starting at startLedger.
 * events is [] if none of the contract IDs emitted anything in range —
 * latestLedger is still returned so the caller can advance its cursor.
 */
export async function getEvents(
  rpcUrl: string,
  contractIds: string[],
  startLedger: number
): Promise<GetEventsResult> {
  if (contractIds.length === 0) {
    return { events: [], latestLedger: startLedger };
  }

  const result = await rpcCall<RpcGetEventsResult>(rpcUrl, 'getEvents', {
    startLedger,
    filters: [{ type: 'contract', contractIds }],
    pagination: { limit: 200 },
  });

  const events = (result.events ?? []).map(record => ({
    id: record.id,
    type: record.type,
    contractId: record.contractId,
    ledger: record.ledger,
    createdAt: record.ledgerClosedAt,
    pagingToken: record.pagingToken,
    topics: record.topic.map(t => JSON.stringify(decodeScVal(t))),
    value: decodeScVal(record.value),
  }));

  return { events, latestLedger: result.latestLedger };
}

/** The RPC's current ledger — used to seed the event-polling cursor on first run. */
export async function getLatestLedgerSequence(rpcUrl: string): Promise<number> {
  const result = await rpcCall<{ sequence: number }>(rpcUrl, 'getLatestLedger', {});
  return result.sequence;
}
