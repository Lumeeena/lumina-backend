import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { HistoryArchiveReader, historyArchiveFilePath, parseXdrRecordStream } from './historyArchive';

function recordStream(...records: Buffer[]): Buffer {
  return Buffer.concat(records.flatMap(record => {
    const marker = Buffer.alloc(4);
    marker.writeUInt32BE((0x80000000 + record.length) >>> 0);
    return [marker, record];
  }));
}

function headerRecord(sequence: number): Buffer {
  const hash = Buffer.alloc(32);
  const value = new xdr.StellarValue({
    txSetHash: hash,
    closeTime: xdr.Uint64.fromString('1750000000'),
    upgrades: [],
    ext: xdr.StellarValueExt.stellarValueBasic(),
  });
  const header = new xdr.LedgerHeader({
    ledgerVersion: 1,
    previousLedgerHash: hash,
    scpValue: value,
    txSetResultHash: hash,
    bucketListHash: hash,
    ledgerSeq: sequence,
    totalCoins: xdr.Int64.fromString('0'),
    feePool: xdr.Int64.fromString('0'),
    inflationSeq: 0,
    idPool: xdr.Uint64.fromString('0'),
    baseFee: 100,
    baseReserve: 5_000_000,
    maxTxSetSize: 1_000,
    skipList: [hash, hash, hash, hash],
    ext: new xdr.LedgerHeaderExt(0),
  });
  return new xdr.LedgerHeaderHistoryEntry({
    hash,
    header,
    ext: new xdr.LedgerHeaderHistoryEntryExt(0),
  }).toXDR('raw');
}

function historyResponse(content: Buffer): Response {
  return new Response(gzipSync(content), { status: 200 });
}

test('archive file path uses Stellar checkpoint sharding and hex names', () => {
  assert.equal(
    historyArchiveFilePath('ledger', 64),
    'ledger/00/00/00/ledger-00000040.xdr.gz'
  );
});

test('XDR record parser reads records and rejects incomplete fragments', () => {
  const records = recordStream(Buffer.from('one'), Buffer.from('two'));
  assert.deepEqual(
    parseXdrRecordStream(records, record => record.toString()),
    ['one', 'two']
  );
  assert.throws(
    () => parseXdrRecordStream(Buffer.from([0, 0, 0, 3, 1, 2, 3]), record => record),
    /Fragmented XDR records/
  );
  assert.throws(
    () => parseXdrRecordStream(Buffer.from([0x80, 0, 0]), record => record),
    /Truncated Stellar history archive XDR record marker/
  );
});

test('reader decodes checkpoint XDR into the live indexer ledger rows', async () => {
  const source = Keypair.random();
  const destination = Keypair.random();
  const passphrase = Networks.TESTNET;
  const transaction = new TransactionBuilder(
    new Account(source.publicKey(), '1'),
    { fee: '100', networkPassphrase: passphrase }
  )
    .addOperation(Operation.payment({
      destination: destination.publicKey(),
      asset: Asset.native(),
      amount: '1.25',
    }))
    .addMemo(Memo.text('archive'))
    .setTimeout(30)
    .build();
  const sequence = 64;
  const txHistory = new xdr.TransactionHistoryEntry({
    ledgerSeq: sequence,
    txSet: new xdr.TransactionSet({
      previousLedgerHash: Buffer.alloc(32),
      txes: [transaction.toEnvelope()],
    }),
    ext: new xdr.TransactionHistoryEntryExt(0),
  });
  const transactionResult = new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('100'),
    result: xdr.TransactionResultResult.txTooEarly(),
    ext: new xdr.TransactionResultExt(0),
  });
  const resultHistory = new xdr.TransactionHistoryResultEntry({
    ledgerSeq: sequence,
    txResultSet: new xdr.TransactionResultSet({
      results: [new xdr.TransactionResultPair({
        transactionHash: transaction.hash(),
        result: transactionResult,
      })],
    }),
    ext: new xdr.TransactionHistoryResultEntryExt(0),
  });
  const files: Record<string, Buffer> = {
    'ledger/00/00/00/ledger-00000040.xdr.gz': recordStream(headerRecord(sequence)),
    'transactions/00/00/00/transactions-00000040.xdr.gz': recordStream(txHistory.toXDR('raw')),
    'results/00/00/00/results-00000040.xdr.gz': recordStream(resultHistory.toXDR('raw')),
  };
  const requested: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    const path = new URL(url).pathname.slice(1);
    requested.push(path);
    const content = files[path];
    if (!content) return new Response(null, { status: 404 });
    return historyResponse(content);
  };

  const reader = new HistoryArchiveReader('https://archive.example', passphrase, fetcher);
  const decoded = await reader.getLedger(sequence);

  assert.equal(decoded.ledger.sequence, sequence);
  assert.equal(decoded.ledger.base_fee_in_stroops, 100);
  assert.equal(decoded.ledger.base_reserve_in_stroops, 5_000_000);
  assert.equal(decoded.ledger.failed_transaction_count, 1);
  assert.equal(decoded.transactions[0]?.source_account, source.publicKey());
  assert.equal(decoded.transactions[0]?.memo, 'archive');
  assert.equal(decoded.transactions[0]?.successful, false);
  assert.equal(decoded.operations[0]?.type, 'payment');
  assert.equal(decoded.operations[0]?.transaction_hash, transaction.hash().toString('hex'));
  assert.equal(decoded.operations[0]?.source_account, source.publicKey());
  assert.equal(requested.length, 3);
});
