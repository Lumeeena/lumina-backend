/**
 * A Soroban RPC that emits one contract event per ledger for the contract it
 * is told to watch, following the same clock as the fake Horizon.
 *
 * Only the JSON-RPC methods the indexer calls are answered (see
 * indexer/src/soroban.ts). Topics and values are real base64 ScVal XDR, so the
 * indexer decodes them through the same path it uses against a real node.
 */
import { nativeToScVal } from '@stellar/stellar-sdk';
import type { ServerResponse } from 'http';
import { FaultyHttpServer, json } from './faultyHttp';
import type { FakeHorizon } from './fakeHorizon';

const TOPIC = nativeToScVal('transfer', { type: 'symbol' }).toXDR('base64');

export class FakeSorobanRpc extends FaultyHttpServer {
  constructor(private readonly chain: FakeHorizon, readonly contractId: string) {
    super((_req, body, res) => this.call(body, res));
  }

  private event(ledger: number) {
    const id = `${((BigInt(ledger) << 32n) | (1n << 12n)).toString().padStart(19, '0')}-0000000001`;
    return {
      type: 'contract',
      ledger,
      ledgerClosedAt: this.chain.closedAt(ledger),
      contractId: this.contractId,
      id,
      pagingToken: id,
      topic: [TOPIC],
      value: nativeToScVal({ amount: BigInt(ledger) * 1_000n }, { type: { amount: ['symbol', 'i128'] } }).toXDR('base64'),
      inSuccessfulContractCall: true,
      txHash: this.chain.transactions(ledger)[0]!.hash,
    };
  }

  private call(body: string, res: ServerResponse): void {
    let request: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      request = JSON.parse(body);
    } catch {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const tip = this.chain.tip();
    const reply = (result: unknown) => json(res, 200, { jsonrpc: '2.0', id: request.id ?? 1, result });

    switch (request.method) {
      case 'getLatestLedger':
        return reply({ id: String(tip), sequence: tip, protocolVersion: 23 });
      case 'getNetwork':
        return reply({ passphrase: 'Test SDF Network ; September 2015', protocolVersion: 23 });
      case 'getEvents': {
        const params = request.params ?? {};
        const pagination = (params['pagination'] ?? {}) as { limit?: number; cursor?: string };
        const filters = (params['filters'] ?? []) as Array<{ contractIds?: string[] }>;
        const watched = filters.some(f => f.contractIds?.includes(this.contractId));
        const limit = pagination.limit ?? 100;
        let from = Number(params['startLedger'] ?? tip);
        if (pagination.cursor) from = Number(BigInt(pagination.cursor.split('-')[0]!) >> 32n) + 1;
        const events = [];
        for (let ledger = Math.max(from, this.chain.options.startLedger); watched && ledger <= tip && events.length < limit; ledger++) {
          events.push(this.event(ledger));
        }
        return reply({ events, latestLedger: tip, cursor: events.at(-1)?.pagingToken });
      }
      case 'getTransactions':
        return reply({ transactions: [], latestLedger: tip });
      case 'getLedgerEntries':
        return reply({ entries: [], latestLedger: tip });
      default:
        return json(res, 200, { jsonrpc: '2.0', id: request.id ?? 1, error: { code: -32601, message: 'method not found' } });
    }
  }
}
