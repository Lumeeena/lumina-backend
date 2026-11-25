import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphQLError } from 'graphql';
import { createErrorMasker, shouldMaskErrors } from './errorMasking';

test('a disabled masker returns the formatted error untouched, even for an internal failure', () => {
  const mask = createErrorMasker({ enabled: false, log: () => assert.fail('must not log when disabled') });
  const formatted = { message: 'relation "events" does not exist', path: ['events'], extensions: { code: 'INTERNAL_SERVER_ERROR' } };
  const out = mask(formatted, new Error('relation "events" does not exist'));
  assert.equal(out, formatted);
});

test('errors with a caller-facing code are not masked and are not logged', () => {
  const mask = createErrorMasker({ enabled: true, log: () => assert.fail('must not log a caller-facing error') });
  const formatted = { message: 'first must be a positive integer', path: ['events'], extensions: { code: 'BAD_USER_INPUT' } };
  const out = mask(formatted, new GraphQLError('first must be a positive integer'));
  assert.equal(out, formatted);
});

test('shouldMaskErrors honours MASK_INTERNAL_ERRORS over NODE_ENV', () => {
  assert.equal(shouldMaskErrors({ MASK_INTERNAL_ERRORS: 'true', NODE_ENV: 'development' }), true);
  assert.equal(shouldMaskErrors({ MASK_INTERNAL_ERRORS: 'false', NODE_ENV: 'production' }), false);
});

test('shouldMaskErrors defaults to masking only in production', () => {
  assert.equal(shouldMaskErrors({ NODE_ENV: 'production' }), true);
  assert.equal(shouldMaskErrors({ NODE_ENV: 'development' }), false);
  assert.equal(shouldMaskErrors({}), false);
});
