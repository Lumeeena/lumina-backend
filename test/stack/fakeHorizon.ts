/**
 * A Horizon that produces a deterministic chain the indexer can follow.
 *
 * The chain's tip advances by one ledger every `ledgerIntervalMs`, computed
 * from the clock rather than a timer, so a paused test or a slow machine never
 * leaves a gap. Every ledger, transaction and operation is derived from its
 * sequence alone: two requests for the same ledger return the same bytes, and
 * a test can say exactly what the indexer should have written.
 *
 * Records carry the fields `shared/src/validate.ts` checks, in the shapes
 * Horizon returns them (see indexer/src/__fixtures__/horizon.json), because the
 * indexer validates every response and a fake it rejects would test nothing.
 */
import { createHash } from 'crypto';
import type { ServerResponse } from 'http';
import { StrKey } from '@stellar/stellar-sdk';
import { FaultyHttpServer, json } from './faultyHttp';

export interface FakeHorizonOptions {
  startLedger: number;
  ledgerIntervalMs: number;
  transactionsPerLedger: number;
  operationsPerTransaction: number;
  /** Distinct accounts the chain's activity is spread across. */
  accounts: number;
}

const DEFAULTS: FakeHorizonOptions = {
  startLedger: 1_000,
  ledgerIntervalMs: 500,
  transactionsPerLedger: 4,
  operationsPerTransaction: 2,
  accounts: 25,
};

const PAGE_LIMIT_MAX = 200;

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest();
}

/** Horizon's operation/transaction id: ledger, application order and index packed into 64 bits. */
function toid(ledger: number, tx: number, op: number): string {
  return ((BigInt(ledger) << 32n) | (BigInt(tx) << 12n) | BigInt(op)).toString();
}

export class FakeHorizon extends FaultyHttpServer {
  readonly options: FakeHorizonOptions;
  readonly accounts: string[];
  private readonly startedAt = Date.now();
  /** Set to stop the tip advancing; the chain then stays at the tip it reached. */
  private frozenTip: number | null = null;

  constructor(options: Partial<FakeHorizonOptions> = {}) {
    super((req, _body, res) => this.route(req.url ?? '/', res));
    this.options = { ...DEFAULTS, ...options };
    this.accounts = Array.from({ length: this.options.accounts }, (_, i) =>
      StrKey.encodeEd25519PublicKey(sha256(`lumina-fake-account-${i}`))
    );
  }

  tip(): number {
    if (this.frozenTip !== null) return this.frozenTip;
    return this.options.startLedger + Math.floor((Date.now() - this.startedAt) / this.options.ledgerIntervalMs);
  }

  freeze(): void {
    this.frozenTip = this.tip();
  }

  closedAt(sequence: number): string {
    return new Date(this.startedAt + (sequence - this.options.startLedger) * this.options.ledgerIntervalMs).toISOString();
  }

  ledger(sequence: number) {
    const { transactionsPerLedger, operationsPerTransaction } = this.options;
    return {
      id: sha256(`ledger-${sequence}`).toString('hex'),
      paging_token: toid(sequence, 0, 0),
      hash: sha256(`ledger-${sequence}`).toString('hex'),
      prev_hash: sha256(`ledger-${sequence - 1}`).toString('hex'),
      sequence,
      successful_transaction_count: transactionsPerLedger,
      failed_transaction_count: 0,
      operation_count: transactionsPerLedger * operationsPerTransaction,
      tx_set_operation_count: transactionsPerLedger * operationsPerTransaction,
      closed_at: this.closedAt(sequence),
      total_coins: '105443902087.3472865',
      fee_pool: '0.0000000',
      base_fee_in_stroops: 100,
      base_reserve_in_stroops: 5_000_000,
      max_tx_set_size: 1000,
      protocol_version: 23,
    };
  }

  private account(index: number): string {
    return this.accounts[((index % this.accounts.length) + this.accounts.length) % this.accounts.length]!;
  }

  transactions(sequence: number) {
    return Array.from({ length: this.options.transactionsPerLedger }, (_, i) => ({
      id: sha256(`tx-${sequence}-${i}`).toString('hex'),
      paging_token: toid(sequence, i + 1, 0),
      successful: true,
      hash: sha256(`tx-${sequence}-${i}`).toString('hex'),
      ledger: sequence,
      created_at: this.closedAt(sequence),
      source_account: this.account(sequence * 7 + i),
      fee_charged: '100',
      max_fee: '100',
      operation_count: this.options.operationsPerTransaction,
      memo_type: i % 2 === 0 ? 'none' : 'text',
      ...(i % 2 === 0 ? {} : { memo: `ledger ${sequence} tx ${i}` }),
    }));
  }

  operations(sequence: number) {
    const ops: Record<string, unknown>[] = [];
    const issuer = this.account(0);
    this.transactions(sequence).forEach((tx, i) => {
      for (let j = 0; j < this.options.operationsPerTransaction; j++) {
        const id = toid(sequence, i + 1, j + 1);
        const base = {
          id,
          paging_token: id,
          transaction_successful: true,
          source_account: tx.source_account,
          created_at: tx.created_at,
          transaction_hash: tx.hash,
        };
        const from = tx.source_account;
        const to = this.account(sequence * 7 + i + j + 1);
        switch ((sequence + i + j) % 4) {
          case 0:
            ops.push({ ...base, type: 'payment', type_i: 1, asset_type: 'native', from, to, amount: `${(sequence % 97) + 1}.0000000` });
            break;
          case 1:
            ops.push({
              ...base, type: 'payment', type_i: 1, asset_type: 'credit_alphanum4', asset_code: 'USDC',
              asset_issuer: issuer, from, to, amount: `${(sequence % 13) + 1}.5000000`,
            });
            break;
          case 2:
            ops.push({
              ...base, type: 'manage_sell_offer', type_i: 3, amount: '10.0000000', price: '0.5000000',
              price_r: { n: 1, d: 2 }, offer_id: '0', buying_asset_type: 'credit_alphanum4', buying_asset_code: 'USDC',
              buying_asset_issuer: issuer, selling_asset_type: 'native',
            });
            break;
          default:
            ops.push({
              ...base, type: 'change_trust', type_i: 6, asset_type: 'credit_alphanum4', asset_code: 'USDC',
              asset_issuer: issuer, limit: '922337203685.4775807', trustee: issuer, trustor: from,
            });
        }
      }
    });
    return ops;
  }

  private page(records: Array<{ paging_token: string }>, url: URL, path: string) {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 10) || 10, PAGE_LIMIT_MAX);
    const order = url.searchParams.get('order') ?? 'asc';
    const cursor = url.searchParams.get('cursor');
    let ordered = order === 'desc' ? [...records].reverse() : records;
    if (cursor) {
      const after = BigInt(cursor);
      ordered = ordered.filter(r => (order === 'desc' ? BigInt(r.paging_token) < after : BigInt(r.paging_token) > after));
    }
    const slice = ordered.slice(0, limit);
    const last = slice[slice.length - 1];
    const next = new URL(`${this.url}${path}`);
    next.searchParams.set('order', order);
    next.searchParams.set('limit', String(limit));
    if (last) next.searchParams.set('cursor', last.paging_token);
    return { _links: { next: { href: next.toString() } }, _embedded: { records: slice } };
  }

  private route(rawUrl: string, res: ServerResponse): void {
    const url = new URL(rawUrl, this.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const tip = this.tip();

    if (parts[0] === 'ledgers' && parts.length === 1) {
      const order = url.searchParams.get('order') ?? 'asc';
      const sequence = order === 'desc' ? tip : this.options.startLedger;
      return json(res, 200, { _links: {}, _embedded: { records: [this.ledger(sequence)] } });
    }
    if (parts[0] === 'ledgers' && parts.length >= 2) {
      const sequence = Number(parts[1]);
      if (!Number.isInteger(sequence) || sequence < this.options.startLedger || sequence > tip) {
        return json(res, 404, { status: 404, title: 'Resource Missing' });
      }
      if (parts.length === 2) return json(res, 200, this.ledger(sequence));
      if (parts[2] === 'transactions') return json(res, 200, this.page(this.transactions(sequence), url, url.pathname));
      if (parts[2] === 'operations') {
        return json(res, 200, this.page(this.operations(sequence) as Array<{ paging_token: string }>, url, url.pathname));
      }
    }
    if (parts[0] === 'accounts' && parts.length === 2) {
      const address = parts[1]!;
      return json(res, 200, {
        id: address,
        account_id: address,
        sequence: String(BigInt(tip) << 32n),
        subentry_count: 1,
        last_modified_ledger: tip,
        num_sponsored: 0,
        num_sponsoring: 0,
        balances: [{ balance: '1000.0000000', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000', asset_type: 'native' }],
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      });
    }
    if (parts[0] === 'accounts' && parts[2] === 'transactions') {
      return json(res, 200, { _links: {}, _embedded: { records: [] } });
    }
    if (parts[0] === 'transactions' && parts.length === 1) {
      return json(res, 200, this.page(this.transactions(tip), url, url.pathname));
    }
    if (parts[0] === 'trades') {
      return json(res, 200, { _links: {}, _embedded: { records: [] } });
    }
    json(res, 404, { status: 404, title: 'Resource Missing' });
  }
}
