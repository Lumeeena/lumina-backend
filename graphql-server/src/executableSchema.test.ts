import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { resolvers } from './resolvers';

// index.ts builds exactly this at startup, and makeExecutableSchema throws on a
// resolver for a field the schema does not declare. Twice that was a server
// that could not boot while every test passed: `Query.accountBalanceHistory`
// after its field was dropped from schema.graphql, and `Account.signers`, whose
// field was never added. Nothing else in the unit suite builds the schema.
test('the resolvers and schema.graphql build the executable schema the server starts with', () => {
  const typeDefs = readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8');
  assert.doesNotThrow(() => makeExecutableSchema({ typeDefs, resolvers }));
});
