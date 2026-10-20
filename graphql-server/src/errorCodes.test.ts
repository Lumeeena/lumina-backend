import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { GraphQLError } from 'graphql';
import {
  ERROR_CATEGORIES,
  ERROR_CODES,
  ERROR_CODE_TAXONOMY,
  InvalidInputError,
  LuminaError,
  RateLimitedError,
  errorCodeFor,
  errorWithStableCode,
  withStableErrorCode,
} from './errorCodes';
import { CustomQueryError } from './customEvents';
import { SearchError } from './search';
import { AssetError } from './assets';
import { ApiKeyError } from './auth';
import { SubscriberLimitError } from './pubsub';
import { InvalidCursorError } from './pagination';
import { computeBalanceHistory } from './balanceHistory';

test('every stable code has a taxonomy entry', () => {
  assert.deepEqual(
    Object.keys(ERROR_CODE_TAXONOMY).sort(),
    Object.values(ERROR_CODES).sort(),
    'a code without a category and description is an undocumented code'
  );
});

test('the taxonomy covers invalid input, not found, rate limited and internal', () => {
  const categories = new Set(Object.values(ERROR_CODE_TAXONOMY).map(entry => entry.category));
  for (const required of [
    ERROR_CATEGORIES.INVALID_INPUT,
    ERROR_CATEGORIES.NOT_FOUND,
    ERROR_CATEGORIES.RATE_LIMITED,
    ERROR_CATEGORIES.INTERNAL,
  ]) {
    assert.ok(categories.has(required), `taxonomy is missing ${required}`);
  }
});

test('every deliberate error maps onto a stable code', () => {
  assert.equal(errorCodeFor(new SearchError('empty query')), ERROR_CODES.BAD_USER_INPUT);
  assert.equal(errorCodeFor(new AssetError('bad range')), ERROR_CODES.BAD_USER_INPUT);
  assert.equal(errorCodeFor(new CustomQueryError('unknown field')), ERROR_CODES.BAD_USER_INPUT);
  assert.equal(
    errorCodeFor(new CustomQueryError('no schema', ERROR_CODES.NOT_FOUND)),
    ERROR_CODES.NOT_FOUND
  );
  assert.equal(errorCodeFor(new ApiKeyError('revoked', 'revoked')), ERROR_CODES.UNAUTHENTICATED);
  assert.equal(errorCodeFor(new SubscriberLimitError(500)), ERROR_CODES.RATE_LIMITED);
  assert.equal(errorCodeFor(new InvalidCursorError('bad')), ERROR_CODES.INVALID_CURSOR);
  assert.equal(errorCodeFor(new InvalidInputError('bad range')), ERROR_CODES.BAD_USER_INPUT);
  assert.equal(errorCodeFor(new RateLimitedError('slow down')), ERROR_CODES.RATE_LIMITED);
});

test('a deliberate error is recognised through Apollo resolver wrapping', () => {
  const original = new SearchError('empty query');
  const wrapped = new GraphQLError(original.message, { originalError: original, path: ['search'] });
  assert.equal(errorCodeFor(wrapped), ERROR_CODES.BAD_USER_INPUT);
  assert.equal(original instanceof LuminaError, true);
});

test('an error with no domain meaning has no code', () => {
  assert.equal(errorCodeFor(new Error('relation "events" does not exist')), undefined);
  assert.equal(errorCodeFor({ code: '57014', message: 'statement timeout' }), undefined);
});

test('a formatted error keeps the code it already carries', () => {
  const formatted = { message: 'too deep', extensions: { code: ERROR_CODES.QUERY_TOO_DEEP } };
  assert.deepEqual(withStableErrorCode(formatted, new GraphQLError('too deep')), formatted);
});

test('a deliberate error replaces Apollo\'s generic internal code', () => {
  const original = new SearchError('Search query cannot be empty.');
  const formatted = {
    message: original.message,
    path: ['search'],
    extensions: { code: ERROR_CODES.INTERNAL_SERVER_ERROR },
  };
  const out = withStableErrorCode(formatted, new GraphQLError(original.message, { originalError: original }));
  assert.equal(out.extensions?.['code'], ERROR_CODES.BAD_USER_INPUT);
  assert.equal(out.message, original.message, 'the caller-facing message passes through');
});

test('an unmapped error keeps INTERNAL_SERVER_ERROR for the masker to catch', () => {
  const formatted = {
    message: 'relation "events" does not exist',
    extensions: { code: ERROR_CODES.INTERNAL_SERVER_ERROR },
  };
  const out = withStableErrorCode(formatted, new Error('relation "events" does not exist'));
  assert.deepEqual(out, formatted);
});

test('a subscription error never reaches Apollo, so it is coded in place', () => {
  const wrapped = new GraphQLError('limit reached', { originalError: new SubscriberLimitError(500) });
  const coded = errorWithStableCode(wrapped);
  assert.equal(coded.extensions?.['code'], ERROR_CODES.RATE_LIMITED);
  assert.equal(coded.message, wrapped.message);
});

test('a subscription error with an existing code is untouched', () => {
  const error = new GraphQLError('too deep', { extensions: { code: ERROR_CODES.QUERY_TOO_DEEP } });
  assert.equal(errorWithStableCode(error), error);
});

test('a codeless subscription failure is labelled internal rather than left codeless', () => {
  const error = new GraphQLError('something broke');
  assert.equal(errorWithStableCode(error).extensions?.['code'], ERROR_CODES.INTERNAL_SERVER_ERROR);
});

test('a subscription error stamped with the generic internal code is corrected', () => {
  const wrapped = new GraphQLError('limit reached', {
    originalError: new SubscriberLimitError(500),
    extensions: { code: ERROR_CODES.INTERNAL_SERVER_ERROR },
  });
  assert.equal(errorWithStableCode(wrapped).extensions?.['code'], ERROR_CODES.RATE_LIMITED);
});

test('balance-history input failures are invalid input, not internal errors', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;

  await assert.rejects(
    () =>
      computeBalanceHistory(
        pool,
        'mainnet',
        'GABC',
        'XLM',
        '2024-01-01T00:00:00.000Z',
        '2025-01-01T00:00:00.000Z'
      ),
    (err: unknown) => errorCodeFor(err) === ERROR_CODES.BAD_USER_INPUT
  );

  await assert.rejects(
    () => computeBalanceHistory(pool, 'mainnet', 'GABC', 'USDC'),
    (err: unknown) => errorCodeFor(err) === ERROR_CODES.BAD_USER_INPUT
  );
});
