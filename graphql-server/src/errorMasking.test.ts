import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphQLError } from 'graphql';
import { createErrorMasker, MASKED_ERROR_MESSAGE, shouldMaskErrors } from './errorMasking';
import { CustomQueryError } from './customEvents';
import { SearchError } from './search';

function internal(original: Error) {
  const error = new GraphQLError(original.message, { originalError: original, path: ['events'] });
  const formatted = { message: original.message, path: ['events'], extensions: { code: 'INTERNAL_SERVER_ERROR' } };
  return { error, formatted };
}

test('an unexpected database error is masked with a correlation id that is logged with the real error', () => {
  const logs: Array<{ fields: Record<string, any>; message: string }> = [];
  const mask = createErrorMasker({ enabled: true, newId: () => 'id-1', log: (fields, message) => logs.push({ fields, message }) });
  const { error, formatted } = internal(new Error('relation "events" column "secret_col" does not exist'));

  const out = mask(formatted, error);
  assert.equal(out.message, MASKED_ERROR_MESSAGE);
  assert.equal(out.extensions?.['correlationId'], 'id-1');
  assert.doesNotMatch(JSON.stringify(out), /does not exist|secret_col/);
  assert.equal(logs[0].fields.correlationId, 'id-1');
  assert.match(logs[0].fields.err.message, /secret_col/);
});

test('deliberate errors pass through unchanged', () => {
  const mask = createErrorMasker({ enabled: true, log: () => assert.fail('must not log') });
  for (const original of [new CustomQueryError('bad filter'), new SearchError('too short')]) {
    const { error, formatted } = internal(original);
    assert.deepEqual(mask(formatted, error), formatted);
  }
});

test('errors with a caller-facing code are untouched', () => {
  const mask = createErrorMasker({ enabled: true });
  const formatted = { message: 'Cannot query field', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } };
  assert.deepEqual(mask(formatted, new GraphQLError('x')), formatted);
});

test('nothing is masked when disabled', () => {
  const mask = createErrorMasker({ enabled: false });
  const { error, formatted } = internal(new Error('raw'));
  assert.deepEqual(mask(formatted, error), formatted);
});

test('masking defaults to production and can be overridden', () => {
  assert.equal(shouldMaskErrors({ NODE_ENV: 'production' }), true);
  assert.equal(shouldMaskErrors({ NODE_ENV: 'development' }), false);
  assert.equal(shouldMaskErrors({ NODE_ENV: 'production', MASK_INTERNAL_ERRORS: 'false' }), false);
  assert.equal(shouldMaskErrors({ MASK_INTERNAL_ERRORS: 'true' }), true);
});
