import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchema, parse, validate } from 'graphql';
import * as generated from '../src/generated/graphql';
import {
  createLuminaClient,
  LuminaGraphQLError,
  LuminaHttpError,
  OperationsDocument,
  TransactionDocument,
  LatestLedgerDocument,
  type TransactionQuery,
} from '../src';

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function fakeFetch(respond: () => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: Call['init']) => {
    calls.push({ url, init });
    const { status = 200, body } = respond();
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('every shipped document is valid against the server schema', () => {
  const schema = buildSchema(readFileSync(resolve(__dirname, '..', '..', 'graphql-server', 'src', 'schema.graphql'), 'utf8'));
  const documents = Object.entries(generated).filter(([name]) => name.endsWith('Document'));
  assert.ok(documents.length >= 15, `expected the shipped operations, got ${documents.length}`);
  for (const [name, document] of documents) {
    assert.deepEqual(validate(schema, parse(String(document))), [], name);
  }
});

test('request posts the document and variables, with the API key, and returns typed data', async () => {
  const transaction: NonNullable<TransactionQuery['transaction']> = {
    hash: 'abc',
    ledger: 1,
    createdAt: '2026-01-01T00:00:00Z',
    sourceAccount: 'GSOURCE',
    feeCharged: '100',
    operationCount: 0,
    successful: true,
    memoType: null,
    memo: null,
    operations: [],
  };
  const { impl, calls } = fakeFetch(() => ({ body: { data: { transaction } } }));
  const client = createLuminaClient({ url: 'https://lumina.test/graphql', apiKey: 'k_123', fetch: impl });

  const result = await client.request(TransactionDocument, { hash: 'abc', network: 'TESTNET' });

  // The compiler knows the shape; the assertions check the runtime agrees.
  const hash: string = result.transaction!.hash;
  assert.equal(hash, 'abc');
  assert.equal(calls[0]!.url, 'https://lumina.test/graphql');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.headers['x-api-key'], 'k_123');
  const body = JSON.parse(calls[0]!.init.body);
  assert.match(body.query, /query Transaction\(\$network: Network, \$hash: String!\)/);
  assert.match(body.query, /fragment TransactionFields on Transaction/);
  assert.deepEqual(body.variables, { hash: 'abc', network: 'TESTNET' });
});

test('variables may be omitted when none are required; a custom key header is honoured', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { data: { latestLedger: null } } }));
  const client = createLuminaClient({ url: 'u', apiKey: 'k', apiKeyHeader: 'X-Lumina-Key', fetch: impl });
  assert.deepEqual(await client.request(LatestLedgerDocument), { latestLedger: null });
  assert.deepEqual(JSON.parse(calls[0]!.init.body).variables, {});
  assert.equal(calls[0]!.init.headers['x-lumina-key'], 'k');
});

test('GraphQL errors throw with the stable error code', async () => {
  const { impl } = fakeFetch(() => ({
    body: { data: null, errors: [{ message: 'Invalid cursor', extensions: { code: 'INVALID_CURSOR' } }] },
  }));
  const client = createLuminaClient({ url: 'u', fetch: impl });
  await assert.rejects(client.request(OperationsDocument, { cursor: 'bad' }), (err: unknown) => {
    assert.ok(err instanceof LuminaGraphQLError);
    assert.equal(err.code, 'INVALID_CURSOR');
    assert.equal(err.errors.length, 1);
    return true;
  });
});

test('a non-JSON or failed HTTP response throws LuminaHttpError', async () => {
  const notJson = createLuminaClient({ url: 'u', fetch: fakeFetch(() => ({ status: 502, body: '<html>' })).impl });
  await assert.rejects(notJson.request(LatestLedgerDocument), (err: unknown) => err instanceof LuminaHttpError && err.status === 502);

  const noData = createLuminaClient({ url: 'u', fetch: fakeFetch(() => ({ status: 500, body: {} })).impl });
  await assert.rejects(noData.request(LatestLedgerDocument), (err: unknown) => err instanceof LuminaHttpError && err.status === 500);
});

// ─── Compile-time guarantees ─────────────────────────────────────────────────
// `npm test` type-checks this file first (tsconfig.test.json); each
// expect-error directive fails the build if the client stops catching that mistake.
// The function is never called.
async function compileTimeChecks(client: ReturnType<typeof createLuminaClient>) {
  // @ts-expect-error: `hash` is required
  await client.request(TransactionDocument, {});
  // @ts-expect-error: and so the variables cannot be omitted
  await client.request(TransactionDocument);
  // @ts-expect-error: `hash` is a String
  await client.request(TransactionDocument, { hash: 42 });
  // @ts-expect-error: not a Network
  await client.request(TransactionDocument, { hash: 'h', network: 'MOONNET' });
  // @ts-expect-error: not an OperationType
  await client.request(OperationsDocument, { type: 'NOT_AN_OPERATION' });

  const page = await client.request(OperationsDocument, { type: 'PAYMENT', limit: 10 });
  const first = page.operations.items[0];
  if (first) {
    const type: generated.OperationType = first.type;
    const amount: string | null = first.amount;
    // @ts-expect-error: not selected by the document, so not on the result
    void first.transaction;
    void type;
    void amount;
  }
}
void compileTimeChecks;
