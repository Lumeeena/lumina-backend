import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApolloServer } from '@apollo/server';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLError, parse } from 'graphql';
import type { OperationDefinitionNode } from 'graphql';
import {
  analyzeOperation,
  assertWithinLimits,
  corsOptions,
  formatTimeoutError,
  isDatabaseTimeout,
  loadSecurityConfig,
  poolTimeoutOptions,
  queryLimitsPlugin,
  requestTimeoutMiddleware,
} from './security';

const typeDefs = `
  type Query { transactions(limit: Int = 20): [Transaction!]!, account(address: String!): Account }
  type Transaction { hash: String!, account: Account }
  type Account { address: String!, transactions(limit: Int = 10): [Transaction!]! }
`;
const schema = makeExecutableSchema({
  typeDefs,
  resolvers: { Query: { transactions: () => [], account: () => null } },
});

function analyze(query: string, variables?: Record<string, unknown>) {
  const doc = parse(query);
  const op = doc.definitions.find(d => d.kind === 'OperationDefinition') as OperationDefinitionNode;
  const fragments: Record<string, any> = {};
  for (const d of doc.definitions) if (d.kind === 'FragmentDefinition') fragments[d.name.value] = d;
  return analyzeOperation(schema, op, fragments, variables);
}

const deep = (n: number): string => {
  let q = '{ hash }';
  for (let i = 0; i < n; i++) q = `{ account { transactions(limit: 1) ${q} } }`;
  return `{ transactions(limit: 1) ${q} }`;
};

test('ordinary queries are within the default budget', () => {
  const { depth, complexity } = analyze('{ transactions(limit: 20) { hash account { address } } }');
  assert.equal(depth, 3);
  assert.ok(complexity < 1000);
});

test('nested lists multiply cost by limit', () => {
  const small = analyze('{ transactions(limit: 2) { account { transactions(limit: 2) { hash } } } }');
  const big = analyze('{ transactions(limit: 20) { account { transactions(limit: 20) { hash } } } }');
  assert.ok(big.complexity > small.complexity * 10);
});

test('limit variables and schema defaults are honoured', () => {
  const viaVar = analyze('query($n: Int) { transactions(limit: $n) { hash } }', { n: 50 });
  assert.equal(viaVar.complexity, 1 + 50 * 1);
  const dflt = analyze('{ transactions { hash } }');
  assert.equal(dflt.complexity, 1 + 20 * 1);
});

test('fragments count toward depth and cost', () => {
  const q = 'query { transactions(limit: 5) { ...T } } fragment T on Transaction { account { address } }';
  const { depth, complexity } = analyze(q);
  assert.equal(depth, 3);
  assert.equal(complexity, 1 + 5 * (1 + 1 * 1));
});

test('introspection is free', () => {
  assert.deepEqual(analyze('{ __schema { types { name } } }'), { depth: 0, complexity: 0 });
});

test('deep cyclic query is rejected with a message naming the budget', () => {
  const doc = parse(deep(8));
  const op = doc.definitions[0] as OperationDefinitionNode;
  assert.throws(
    () => assertWithinLimits(schema, doc, op, undefined, { maxDepth: 10, maxComplexity: 0 }),
    (e: any) => e instanceof GraphQLError && /maximum allowed depth of 10/.test(e.message) && e.extensions['code'] === 'QUERY_TOO_DEEP'
  );
});

test('over-complex query is rejected; 0 disables a limit', () => {
  const doc = parse('{ transactions(limit: 100) { account { transactions(limit: 100) { hash } } } }');
  const op = doc.definitions[0] as OperationDefinitionNode;
  assert.throws(
    () => assertWithinLimits(schema, doc, op, undefined, { maxDepth: 10, maxComplexity: 1000 }),
    /maximum allowed complexity of 1000/
  );
  assert.doesNotThrow(() => assertWithinLimits(schema, doc, op, undefined, { maxDepth: 0, maxComplexity: 0 }));
});

test('plugin rejects before any resolver runs', async () => {
  let resolverCalls = 0;
  const s = makeExecutableSchema({
    typeDefs,
    resolvers: {
      Query: { transactions: () => { resolverCalls++; return []; }, account: () => { resolverCalls++; return null; } },
    },
  });
  const server = new ApolloServer({ schema: s, plugins: [queryLimitsPlugin({ maxDepth: 4, maxComplexity: 1000 })] });
  await server.start();
  const bad = await server.executeOperation({ query: deep(6) });
  assert.equal(bad.body.kind, 'single');
  if (bad.body.kind === 'single') {
    assert.match(bad.body.singleResult.errors?.[0]?.message ?? '', /depth/);
  }
  assert.equal(resolverCalls, 0);
  const ok = await server.executeOperation({ query: '{ transactions(limit: 1) { hash } }' });
  if (ok.body.kind === 'single') assert.equal(ok.body.singleResult.errors, undefined);
  await server.stop();
});

test('introspection defaults: on in development, off in production, overridable', () => {
  assert.equal(loadSecurityConfig({}).introspection, true);
  assert.equal(loadSecurityConfig({ NODE_ENV: 'development' }).introspection, true);
  assert.equal(loadSecurityConfig({ NODE_ENV: 'production' }).introspection, false);
  assert.equal(loadSecurityConfig({ NODE_ENV: 'production', GRAPHQL_INTROSPECTION: 'true' }).introspection, true);
  assert.equal(loadSecurityConfig({ GRAPHQL_INTROSPECTION: 'false' }).introspection, false);
});

test('introspection is refused by Apollo when disabled', async () => {
  const server = new ApolloServer({ schema, introspection: false });
  await server.start();
  const res = await server.executeOperation({ query: '{ __schema { types { name } } }' });
  if (res.body.kind === 'single') assert.ok(res.body.singleResult.errors?.length);
  await server.stop();
});

test('CORS: permissive by default, restricted by ALLOWED_ORIGINS', () => {
  assert.deepEqual(corsOptions(loadSecurityConfig({})), { origin: true });
  const cfg = loadSecurityConfig({ ALLOWED_ORIGINS: ' https://a.example , https://b.example ' });
  assert.deepEqual(cfg.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.deepEqual(corsOptions(cfg), { origin: ['https://a.example', 'https://b.example'] });
  assert.equal(loadSecurityConfig({ ALLOWED_ORIGINS: '*' }).allowedOrigins, '*');
});

test('limits and timeouts are configurable and fall back on bad input', () => {
  const cfg = loadSecurityConfig({
    GRAPHQL_MAX_DEPTH: '5',
    GRAPHQL_MAX_COMPLEXITY: 'nope',
    DB_STATEMENT_TIMEOUT_MS: '2000',
    REQUEST_TIMEOUT_MS: '0',
  });
  assert.equal(cfg.maxDepth, 5);
  assert.equal(cfg.maxComplexity, 1000);
  assert.equal(cfg.statementTimeoutMs, 2000);
  assert.equal(cfg.requestTimeoutMs, 0);
  assert.deepEqual(poolTimeoutOptions(cfg), { statement_timeout: 2000, query_timeout: 3000 });
  assert.deepEqual(poolTimeoutOptions({ statementTimeoutMs: 0 }), {});
});

test('database timeouts are reported with a clear coded error', () => {
  assert.ok(isDatabaseTimeout(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })));
  assert.ok(isDatabaseTimeout(new Error('Query read timeout')));
  assert.ok(!isDatabaseTimeout(new Error('boom')));
  const out = formatTimeoutError(
    { message: 'Unexpected error.', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
  );
  assert.equal(out.extensions?.['code'], 'QUERY_TIMEOUT');
  assert.match(out.message, /took too long/);
  const untouched = { message: 'x' };
  assert.equal(formatTimeoutError(untouched, new Error('boom')), untouched);
});

test('request timeout middleware answers 504 for a slow request and is silent for a fast one', async () => {
  const mk = () => {
    const handlers: Record<string, () => void> = {};
    const res: any = {
      headersSent: false,
      statusCode: 0,
      body: undefined,
      on: (ev: string, fn: () => void) => { handlers[ev] = fn; },
      status(c: number) { this.statusCode = c; return this; },
      json(b: unknown) { this.body = b; this.headersSent = true; },
    };
    return { res, handlers };
  };
  const slow = mk();
  let nexted = false;
  requestTimeoutMiddleware(20)({} as any, slow.res, () => { nexted = true; });
  assert.ok(nexted);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(slow.res.statusCode, 504);
  assert.equal(slow.res.body.errors[0].extensions.code, 'REQUEST_TIMEOUT');

  const fast = mk();
  requestTimeoutMiddleware(20)({} as any, fast.res, () => {});
  fast.handlers['finish']?.();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(fast.res.statusCode, 0);
});
