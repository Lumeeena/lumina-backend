/**
 * The notification wire contract, as the GraphQL server sees it.
 *
 * Deliberately a second copy of `indexer/src/notify.ts`'s shape rather than a
 * shared import — the two packages don't share code (see `horizon.ts`, which is
 * duplicated for the same reason), and the honest framing is that this is a
 * *protocol* between two processes that deploy independently. The reader has to
 * tolerate a writer at a different version, which is exactly what the parser
 * below does.
 *
 * The channel name and the `ledger`/`kind` fields are the compatibility
 * surface. Everything else is optional commentary and may be absent — which
 * includes `network`: an indexer that predates per-network notifications does
 * not send it, and the reader treats its absence as the one network that
 * indexer was running.
 */

export const INDEXED_CHANNEL = 'lumina_indexed';

export type IndexedKind = 'ledger' | 'events';

export interface IndexedNotification {
  kind: IndexedKind;
  ledger: number;
  /**
   * Network the ledger landed on, lowercase (the `network` column's value).
   *
   * Present from the multi-network indexer on. Optional so a reader never has
   * to know which side of that change it is talking to.
   */
  network?: string | undefined;
  transactions?: number | undefined;
  operations?: number | undefined;
  events?: number | undefined;
}

/**
 * Parse a payload off the wire.
 *
 * Returns `null` for anything unrecognised rather than throwing: an indexer
 * running ahead of this server may emit a shape it has never seen, and that
 * must not kill the LISTEN connection every other subscriber depends on.
 */
export function parseNotification(payload: string | undefined): IndexedNotification | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<IndexedNotification>;
    if (typeof parsed.ledger !== 'number' || !Number.isFinite(parsed.ledger)) return null;
    if (parsed.kind !== 'ledger' && parsed.kind !== 'events') return null;
    return {
      kind: parsed.kind,
      ledger: parsed.ledger,
      network: stringOrUndefined(parsed.network),
      transactions: numberOrUndefined(parsed.transactions),
      operations: numberOrUndefined(parsed.operations),
      events: numberOrUndefined(parsed.events),
    };
  } catch {
    return null;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
