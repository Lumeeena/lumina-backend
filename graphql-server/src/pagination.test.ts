import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphQLError } from 'graphql';
import { getPageSize, MAX_PAGE_SIZE } from './pagination';

test('page size defaults preserve root and nested-list defaults', () => {
  assert.equal(getPageSize(undefined), 20);
  assert.equal(getPageSize(undefined, 10), 10);
});

test('page size accepts the maximum and rejects larger requests', () => {
  assert.equal(getPageSize(MAX_PAGE_SIZE), MAX_PAGE_SIZE);

  assert.throws(
    () => getPageSize(MAX_PAGE_SIZE + 1),
    (error: unknown) => {
      assert.ok(error instanceof GraphQLError);
      assert.match(error.message, /exceeds the maximum of 100/);
      assert.equal(error.extensions['code'], 'BAD_USER_INPUT');
      return true;
    }
  );
});

test('page size rejects zero and negative values', () => {
  for (const limit of [0, -1]) {
    assert.throws(
      () => getPageSize(limit),
      (error: unknown) => error instanceof GraphQLError && error.extensions['code'] === 'BAD_USER_INPUT'
    );
  }
});