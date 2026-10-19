import { gunzipSync } from 'node:zlib';
import { TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import type { HorizonLedger, HorizonOperation, HorizonTransaction } from './horizon';

const CHECKPOINT_FREQUENCY = 64;
const MAX_XDR_RECORD_BYTES = 128 * 1024 * 1024;

type HistoryArchiveLedger = {
  ledger: HorizonLedger;
  transactions: HorizonTransaction[];
  operations: HorizonOperation[];
};

type ArchiveFiles = {
  ledgers: Map<number, xdr.LedgerHeaderHistoryEntry>;
  transactions: Map<number, xdr.TransactionHistoryEntry>;
  results: Map<number, xdr.TransactionHistoryResultEntry>;
};

function checkpointForLedger(sequence: number): number {
  return Math.ceil(sequence / CHECKPOINT_FREQUENCY) * CHECKPOINT_FREQUENCY;
}

export function historyArchiveFilePath(type: 'ledger' | 'transactions' | 'results', checkpoint: number): string {
  const hex = checkpoint.toString(16).padStart(8, '0');
  return `${type}/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4, 6)}/${type}-${hex}.xdr.gz`;
}

export function parseXdrRecordStream<T>(data: Buffer, decode: (record: Buffer) => T): T[] {
  const records: T[] = [];
  let offset = 0;

  while (offset < data.length) {
    if (data.length - offset < 4) {
      throw new Error('Truncated Stellar history archive XDR record marker');
    }
    const marker = data.readUInt32BE(offset);
    const isLastFragment = (marker & 0x80000000) !== 0;
    const size = marker & 0x7fffffff;
    offset += 4;

    if (!isLastFragment) {
      throw new Error('Fragmented XDR records are not supported in Stellar history archive files');
    }
    if (size === 0 || size > MAX_XDR_RECORD_BYTES || offset + size > data.length) {
      throw new Error('Invalid or truncated Stellar history archive XDR record');
    }

    records.push(decode(data.subarray(offset, offset + size)));
    offset += size;
  }
  return records;
}

function records<T>(
  compressed: Buffer,
  decode: (record: Buffer) => T
): T[] {
  return parseXdrRecordStream(gunzipSync(compressed), decode);
}

function getRecord<T>(
  response: Response,
  fileType: string,
  decode: (record: Buffer) => T
): Promise<T[]> {
  if (!response.ok) {
    throw new Error(`Stellar history archive request for ${fileType} failed with HTTP ${response.status}`);
  }
  return response.arrayBuffer().then(bytes => records(Buffer.from(bytes), decode));
}

function transactionEnvelopes(entry: xdr.TransactionHistoryEntry): xdr.TransactionEnvelope[] {
  if (entry.ext().switch() === 0) {
    return entry.txSet().txes();
  }

  const generalized = entry.ext().generalizedTxSet().v1TxSet();
  const envelopes: xdr.TransactionEnvelope[] = [];
  for (const phase of generalized.phases()) {
    if (phase.switch() === 0) {
      for (const component of phase.v0Components()) {
        envelopes.push(...component.txsMaybeDiscountedFee().txes());
      }
    } else {
      for (const stage of phase.parallelTxsComponent().executionStages()) {
        for (const cluster of stage) {
          envelopes.push(...cluster);
        }
      }
    }
  }
  return envelopes;
}

function safeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === 'object') {
    if ('code' in value && typeof value.code === 'string') {
      return {
        code: value.code,
        issuer: 'issuer' in value && typeof value.issuer === 'string' ? value.issuer : undefined,
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, safeValue(entry)])
    );
  }
  return value;
}

function addAssetFields(
  target: Record<string, unknown>,
  prefix: string,
  assetValue: unknown
): void {
  if (!assetValue || typeof assetValue !== 'object') return;
  if (!('code' in assetValue) || typeof assetValue.code !== 'string') return;

  const issuer = 'issuer' in assetValue ? assetValue.issuer : undefined;
  if (assetValue.code === 'XLM' && typeof issuer !== 'string') {
    target[`${prefix}asset_type`] = 'native';
    return;
  }
  target[`${prefix}asset_type`] = assetValue.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';
  target[`${prefix}asset_code`] = assetValue.code;
  if (typeof issuer === 'string') target[`${prefix}asset_issuer`] = issuer;
}

function operationRow(
  operationValue: object,
  transaction: { hash: string; source: string; createdAt: string },
  ledger: number,
  index: number
): HorizonOperation {
  const operation = Object.fromEntries(Object.entries(operationValue));
  const source = typeof operation.source === 'string' ? operation.source : transaction.source;
  const type = typeof operation.type === 'string' ? operation.type : 'unknown';
  const row: HorizonOperation = {
    ...Object.fromEntries(
      Object.entries(operation)
        .filter(([key]) => !['source', 'asset', 'line', 'selling', 'buying', 'sendAsset', 'destAsset'].includes(key))
        .map(([key, value]) => [key, safeValue(value)])
    ),
    id: (BigInt(ledger) * 1_000_000n + BigInt(index)).toString(),
    transaction_hash: transaction.hash,
    created_at: transaction.createdAt,
    source_account: source,
    from: source,
    type: type.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
  };

  const destination = operation.destination;
  if (typeof destination === 'string') row.to = destination;
  addAssetFields(row, '', operation.asset ?? operation.line);
  addAssetFields(row, 'selling_', operation.selling);
  addAssetFields(row, 'buying_', operation.buying);
  addAssetFields(row, 'source_', operation.sendAsset);
  addAssetFields(row, 'dest_', operation.destAsset);

  const aliases: Record<string, string> = {
    offerId: 'offer_id',
    sendMax: 'source_max',
    sendAmount: 'source_amount',
    destMin: 'dest_min',
    destAmount: 'dest_amount',
    destAsset: 'dest_asset',
    sendAsset: 'source_asset',
  };
  for (const [sourceKey, destinationKey] of Object.entries(aliases)) {
    if (operation[sourceKey] !== undefined) row[destinationKey] = safeValue(operation[sourceKey]);
  }

  return row;
}

function decodeCheckpointLedger(
  sequence: number,
  passphrase: string,
  files: ArchiveFiles
): HistoryArchiveLedger {
  const headerEntry = files.ledgers.get(sequence);
  if (!headerEntry) throw new Error(`Ledger ${sequence} is missing from its Stellar history checkpoint`);

  const header = headerEntry.header();
  const closedAt = new Date(Number(header.scpValue().closeTime()) * 1000).toISOString();
  const txHistory = files.transactions.get(sequence);
  const resultHistory = files.results.get(sequence);
  const envelopes = txHistory ? transactionEnvelopes(txHistory) : [];
  const results = resultHistory?.txResultSet().results() ?? [];
  if (envelopes.length !== results.length) {
    throw new Error(`Ledger ${sequence} has mismatched transaction and result counts in the archive`);
  }

  const resultByHash = new Map(results.map(result => [
    result.transactionHash().toString('hex'),
    result.result(),
  ]));
  const transactions: HorizonTransaction[] = [];
  const operations: HorizonOperation[] = [];

  envelopes.forEach(envelope => {
    const parsed = TransactionBuilder.fromXDR(envelope.toXDR('base64'), passphrase);
    const transaction = 'innerTransaction' in parsed ? parsed.innerTransaction : parsed;
    const hash = parsed.hash().toString('hex');
    const result = resultByHash.get(hash);
    if (!result) throw new Error(`Ledger ${sequence} is missing a result for transaction ${hash}`);

    const feeCharged = result.feeCharged().toString();
    const successCode = result.result().switch();
    const memoType = transaction.memo.type;
    const memoValue = transaction.memo.value;
    const row: HorizonTransaction = {
      hash,
      ledger: sequence,
      created_at: closedAt,
      source_account: transaction.source,
      fee_charged: feeCharged,
      operation_count: transaction.operations.length,
      successful: successCode.value === 0 || successCode.name === 'txFeeBumpInnerSuccess',
      memo_type: memoType,
      ...(memoType === 'none' ? {} : {
        memo: Buffer.isBuffer(memoValue)
          ? memoValue.toString(memoType === 'text' ? 'utf8' : 'hex')
          : String(memoValue),
      }),
    };
    transactions.push(row);

    for (const operation of transaction.operations) {
      operations.push(operationRow(
        operation,
        { hash, source: transaction.source, createdAt: closedAt },
        sequence,
        operations.length
      ));
    }
  });

  const successfulCount = transactions.filter(transaction => transaction.successful).length;
  return {
    ledger: {
      sequence,
      closed_at: closedAt,
      successful_transaction_count: successfulCount,
      failed_transaction_count: transactions.length - successfulCount,
      operation_count: operations.length,
      base_fee_in_stroops: header.baseFee(),
      base_reserve_in_stroops: header.baseReserve(),
    },
    transactions,
    operations,
  };
}

export class HistoryArchiveReader {
  private cachedCheckpoint: number | undefined;
  private cachedFiles: ArchiveFiles | undefined;

  constructor(
    private readonly archiveUrl: string,
    private readonly networkPassphrase: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async getLedger(sequence: number): Promise<HistoryArchiveLedger> {
    const checkpoint = checkpointForLedger(sequence);
    if (checkpoint !== this.cachedCheckpoint || !this.cachedFiles) {
      this.cachedFiles = await this.loadCheckpoint(checkpoint);
      this.cachedCheckpoint = checkpoint;
    }
    return decodeCheckpointLedger(sequence, this.networkPassphrase, this.cachedFiles);
  }

  private async loadCheckpoint(checkpoint: number): Promise<ArchiveFiles> {
    const base = this.archiveUrl.replace(/\/+$/, '');
    const request = async <T>(
      type: 'ledger' | 'transactions' | 'results',
      decode: (record: Buffer) => T
    ): Promise<T[]> => {
      const path = historyArchiveFilePath(type, checkpoint);
      const response = await this.fetcher(`${base}/${path}`);
      if ((type === 'transactions' || type === 'results') && response.status === 404) return [];
      return getRecord(response, path, decode);
    };
    const [ledgerRows, transactionRows, resultRows] = await Promise.all([
      request('ledger', record => xdr.LedgerHeaderHistoryEntry.fromXDR(record)),
      request('transactions', record => xdr.TransactionHistoryEntry.fromXDR(record)),
      request('results', record => xdr.TransactionHistoryResultEntry.fromXDR(record)),
    ]);
    const byLedger = <T>(rows: T[], sequence: (row: T) => number) =>
      new Map(rows.map(row => [sequence(row), row]));
    return {
      ledgers: byLedger(
        ledgerRows as xdr.LedgerHeaderHistoryEntry[],
        row => row.header().ledgerSeq()
      ),
      transactions: byLedger(
        transactionRows as xdr.TransactionHistoryEntry[],
        row => row.ledgerSeq()
      ),
      results: byLedger(
        resultRows as xdr.TransactionHistoryResultEntry[],
        row => row.ledgerSeq()
      ),
    };
  }
}
