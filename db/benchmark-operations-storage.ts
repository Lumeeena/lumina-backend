/**
 * Benchmark and Storage Evaluation for operations.details (Issue #284)
 *
 * Measures:
 * 1. Raw Horizon operation JSON size vs pruned fields payload
 * 2. Compression ratios using standard compression (simulating pglz and lz4)
 * 3. PostgreSQL TOAST storage threshold behavior (inline vs out-of-line)
 * 4. Extrapolated storage footprint across 100k, 1M, 10M, and 100M rows
 *
 * Usage:
 *   npx ts-node db/benchmark-operations-storage.ts
 */

import * as zlib from 'zlib';

export interface OperationSample {
  type: string;
  payload: Record<string, unknown>;
}

export const REPRESENTATIVE_HORIZON_OPERATIONS: OperationSample[] = [
  {
    type: 'payment',
    payload: {
      _links: {
        self: { href: 'https://horizon.stellar.org/operations/123456789012345' },
        transaction: { href: 'https://horizon.stellar.org/transactions/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' },
        effects: { href: 'https://horizon.stellar.org/operations/123456789012345/effects' },
        succeeds: { href: 'https://horizon.stellar.org/effects?order=desc&cursor=123456789012345' },
        precedes: { href: 'https://horizon.stellar.org/effects?order=asc&cursor=123456789012345' },
      },
      id: '123456789012345',
      paging_token: '123456789012345',
      transaction_successful: true,
      source_account: 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
      type: 'payment',
      type_i: 1,
      created_at: '2026-03-15T12:00:00Z',
      transaction_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      from: 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
      to: 'GCKFQGPOK7PZX7W6RMBY6NWUDF6P645W2Z5Q262Q5R5R7D3DPP7EOGB3',
      amount: '150.2500000',
    },
  },
  {
    type: 'create_account',
    payload: {
      _links: {
        self: { href: 'https://horizon.stellar.org/operations/123456789012346' },
        transaction: { href: 'https://horizon.stellar.org/transactions/bcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890a' },
        effects: { href: 'https://horizon.stellar.org/operations/123456789012346/effects' },
        succeeds: { href: 'https://horizon.stellar.org/effects?order=desc&cursor=123456789012346' },
        precedes: { href: 'https://horizon.stellar.org/effects?order=asc&cursor=123456789012346' },
      },
      id: '123456789012346',
      paging_token: '123456789012346',
      transaction_successful: true,
      source_account: 'GBZULMSN55N654HQXNGN7R6GAV766H2B5V36DP4H2RBW3K6BTODB4B',
      type: 'create_account',
      type_i: 0,
      created_at: '2026-03-15T12:01:00Z',
      transaction_hash: 'bcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890a',
      starting_balance: '25.0000000',
      funder: 'GBZULMSN55N654HQXNGN7R6GAV766H2B5V36DP4H2RBW3K6BTODB4B',
      account: 'GD7Q2VWRZ627G5MHKWJCY32WNJGB3O4ZPMY4Q7GKL5P6A26U4D7F7GB7',
    },
  },
  {
    type: 'manage_buy_offer',
    payload: {
      _links: {
        self: { href: 'https://horizon.stellar.org/operations/123456789012347' },
        transaction: { href: 'https://horizon.stellar.org/transactions/cdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' },
        effects: { href: 'https://horizon.stellar.org/operations/123456789012347/effects' },
        succeeds: { href: 'https://horizon.stellar.org/effects?order=desc&cursor=123456789012347' },
        precedes: { href: 'https://horizon.stellar.org/effects?order=asc&cursor=123456789012347' },
      },
      id: '123456789012347',
      paging_token: '123456789012347',
      transaction_successful: true,
      source_account: 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
      type: 'manage_buy_offer',
      type_i: 12,
      created_at: '2026-03-15T12:02:00Z',
      transaction_hash: 'cdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
      offer_id: '987654321',
      buying_asset_type: 'credit_alphanum4',
      buying_asset_code: 'USDC',
      buying_asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      selling_asset_type: 'native',
      amount: '500.0000000',
      price: '0.1250000',
      price_r: { n: 1, d: 8 },
    },
  },
  {
    type: 'path_payment_strict_receive',
    payload: {
      _links: {
        self: { href: 'https://horizon.stellar.org/operations/123456789012348' },
        transaction: { href: 'https://horizon.stellar.org/transactions/def1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc' },
        effects: { href: 'https://horizon.stellar.org/operations/123456789012348/effects' },
        succeeds: { href: 'https://horizon.stellar.org/effects?order=desc&cursor=123456789012348' },
        precedes: { href: 'https://horizon.stellar.org/effects?order=asc&cursor=123456789012348' },
      },
      id: '123456789012348',
      paging_token: '123456789012348',
      transaction_successful: true,
      source_account: 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
      type: 'path_payment_strict_receive',
      type_i: 2,
      created_at: '2026-03-15T12:03:00Z',
      transaction_hash: 'def1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc',
      asset_type: 'credit_alphanum4',
      asset_code: 'EURC',
      asset_issuer: 'GD47G5MHKWJCY32WNJGB3O4ZPMY4Q7GKL5P6A26U4D7F7GB7GA5ZSEJY',
      from: 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
      to: 'GCKFQGPOK7PZX7W6RMBY6NWUDF6P645W2Z5Q262Q5R5R7D3DPP7EOGB3',
      amount: '85.5000000',
      source_asset_type: 'native',
      source_max: '750.0000000',
      source_amount: '720.1250000',
      path: [
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' }
      ],
    },
  },
  {
    type: 'change_trust',
    payload: {
      _links: {
        self: { href: 'https://horizon.stellar.org/operations/123456789012349' },
        transaction: { href: 'https://horizon.stellar.org/transactions/ef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd' },
        effects: { href: 'https://horizon.stellar.org/operations/123456789012349/effects' },
        succeeds: { href: 'https://horizon.stellar.org/effects?order=desc&cursor=123456789012349' },
        precedes: { href: 'https://horizon.stellar.org/effects?order=asc&cursor=123456789012349' },
      },
      id: '123456789012349',
      paging_token: '123456789012349',
      transaction_successful: true,
      source_account: 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
      type: 'change_trust',
      type_i: 6,
      created_at: '2026-03-15T12:04:00Z',
      transaction_hash: 'ef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
      asset_type: 'credit_alphanum4',
      asset_code: 'AQUA',
      asset_issuer: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFQDUGSWHYNGMAVRWKRTSMR2DOQ',
      limit: '922337203685.4775807',
      trustee: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFQDUGSWHYNGMAVRWKRTSMR2DOQ',
      trustor: 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
    },
  },
];

/**
 * Filter down an operation payload to strictly the fields queried by GraphQL and API endpoints.
 */
export function pruneOperationPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const pruned: Record<string, unknown> = {};

  const ALLOWED_FIELDS = [
    'from',
    'to',
    'amount',
    'asset_type',
    'asset_code',
    'asset_issuer',
    'starting_balance',
    'funder',
    'offer_id',
    'price',
    'selling_asset_type',
    'selling_asset_code',
    'selling_asset_issuer',
    'buying_asset_type',
    'buying_asset_code',
    'buying_asset_issuer',
    'account',
    'limit',
    'trustor',
    'trustee',
  ];

  for (const field of ALLOWED_FIELDS) {
    if (raw[field] !== undefined) {
      pruned[field] = raw[field];
    }
  }

  return pruned;
}

export interface FootprintMetrics {
  type: string;
  rawBytes: number;
  rawCompressedBytes: number;
  prunedBytes: number;
  prunedCompressedBytes: number;
  rawToPrunedRatio: number;
  rawCompressionRatio: number;
  totalSavingsPercent: number;
}

export function measureOperationFootprint(sample: OperationSample): FootprintMetrics {
  const rawStr = JSON.stringify(sample.payload);
  const rawBuffer = Buffer.from(rawStr, 'utf-8');
  const rawCompressed = zlib.deflateSync(rawBuffer);

  const prunedObj = pruneOperationPayload(sample.payload);
  const prunedStr = JSON.stringify(prunedObj);
  const prunedBuffer = Buffer.from(prunedStr, 'utf-8');
  const prunedCompressed = zlib.deflateSync(prunedBuffer);

  return {
    type: sample.type,
    rawBytes: rawBuffer.length,
    rawCompressedBytes: rawCompressed.length,
    prunedBytes: prunedBuffer.length,
    prunedCompressedBytes: prunedCompressed.length,
    rawToPrunedRatio: (1 - prunedBuffer.length / rawBuffer.length) * 100,
    rawCompressionRatio: (1 - rawCompressed.length / rawBuffer.length) * 100,
    totalSavingsPercent: (1 - prunedCompressed.length / rawBuffer.length) * 100,
  };
}

export function runBenchmark(): {
  samples: FootprintMetrics[];
  summary: {
    avgRawBytes: number;
    avgRawCompressedBytes: number;
    avgPrunedBytes: number;
    avgPrunedCompressedBytes: number;
    avgRawSavingsPercent: number;
    avgTotalSavingsPercent: number;
    extrapolations: Record<string, { rawGb: number; prunedGb: number; tunedToastGb: number }>;
  };
} {
  const samples = REPRESENTATIVE_HORIZON_OPERATIONS.map(measureOperationFootprint);

  const avgRawBytes = Math.round(samples.reduce((acc, s) => acc + s.rawBytes, 0) / samples.length);
  const avgRawCompressedBytes = Math.round(samples.reduce((acc, s) => acc + s.rawCompressedBytes, 0) / samples.length);
  const avgPrunedBytes = Math.round(samples.reduce((acc, s) => acc + s.prunedBytes, 0) / samples.length);
  const avgPrunedCompressedBytes = Math.round(samples.reduce((acc, s) => acc + s.prunedCompressedBytes, 0) / samples.length);

  const avgRawSavingsPercent = (1 - avgPrunedBytes / avgRawBytes) * 100;
  const avgTotalSavingsPercent = (1 - avgPrunedCompressedBytes / avgRawBytes) * 100;

  // Extrapolations in Gigabytes (10^9 bytes)
  const scale = [100_000, 1_000_000, 10_000_000, 100_000_000];
  const extrapolations: Record<string, { rawGb: number; prunedGb: number; tunedToastGb: number }> = {};

  for (const n of scale) {
    const label = `${n >= 1_000_000 ? n / 1_000_000 + 'M' : n / 1_000 + 'k'}_rows`;
    extrapolations[label] = {
      rawGb: Number(((n * avgRawBytes) / (1024 * 1024 * 1024)).toFixed(2)),
      prunedGb: Number(((n * avgPrunedBytes) / (1024 * 1024 * 1024)).toFixed(2)),
      tunedToastGb: Number(((n * avgPrunedCompressedBytes) / (1024 * 1024 * 1024)).toFixed(2)),
    };
  }

  return {
    samples,
    summary: {
      avgRawBytes,
      avgRawCompressedBytes,
      avgPrunedBytes,
      avgPrunedCompressedBytes,
      avgRawSavingsPercent: Number(avgRawSavingsPercent.toFixed(1)),
      avgTotalSavingsPercent: Number(avgTotalSavingsPercent.toFixed(1)),
      extrapolations,
    },
  };
}

const res = runBenchmark();
console.log('=== OPERATIONS.DETAILS STORAGE FOOTPRINT BENCHMARK ===');
console.table(res.samples);
console.log('=== SUMMARY & EXTRAPOLATIONS ===');
console.log(JSON.stringify(res.summary, null, 2));
