import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphQLError } from 'graphql';
import {
  getPageSize,
  MAX_PAGE_SIZE,
  encodeCursor,
  decodeCursor,
  KEYSETS,
  InvalidCursorError,
  cursorCondition,
  pageInfo,
} from './pagination';

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

test('encodeCursor and decodeCursor round-trip valid sort keys', () => {
  const cursor = encodeCursor('transactions', [12345, 'hash_abc']);
  const decoded = decodeCursor(cursor, 'transactions', 2);
  assert.deepEqual(decoded, [12345, 'hash_abc']);
});

test('decodeCursor rejects wrong query, wrong arity, or corrupted cursors', () => {
  const txCursor = encodeCursor('transactions', [12345, 'hash_abc']);

  // Wrong query
  assert.throws(
    () => decodeCursor(txCursor, 'ledgers', 1),
    (err: unknown) => err instanceof InvalidCursorError
  );

  // Wrong arity
  assert.throws(
    () => decodeCursor(txCursor, 'transactions', 3),
    (err: unknown) => err instanceof InvalidCursorError
  );

  // Corrupted base64
  assert.throws(
    () => decodeCursor('not-valid-base64-json', 'transactions', 2),
    (err: unknown) => err instanceof InvalidCursorError
  );
});

test('cursorCondition generates correct operators for FORWARD and BACKWARD in both DESC and ASC order', () => {
  const cursor = encodeCursor('ledgers', [1000]);

  // DESC FORWARD -> <
  const params1: unknown[] = ['mainnet'];
  const cond1 = cursorCondition(params1, KEYSETS.ledgers, cursor, 'FORWARD', 'DESC');
  assert.equal(cond1, '(sequence) < ($2::bigint)');
  assert.deepEqual(params1, ['mainnet', 1000]);

  // DESC BACKWARD -> >
  const params2: unknown[] = ['mainnet'];
  const cond2 = cursorCondition(params2, KEYSETS.ledgers, cursor, 'BACKWARD', 'DESC');
  assert.equal(cond2, '(sequence) > ($2::bigint)');
  assert.deepEqual(params2, ['mainnet', 1000]);

  // ASC FORWARD -> >
  const params3: unknown[] = ['mainnet'];
  const cond3 = cursorCondition(params3, KEYSETS.ledgers, cursor, 'FORWARD', 'ASC');
  assert.equal(cond3, '(sequence) > ($2::bigint)');
  assert.deepEqual(params3, ['mainnet', 1000]);

  // ASC BACKWARD -> <
  const params4: unknown[] = ['mainnet'];
  const cond4 = cursorCondition(params4, KEYSETS.ledgers, cursor, 'BACKWARD', 'ASC');
  assert.equal(cond4, '(sequence) < ($2::bigint)');
  assert.deepEqual(params4, ['mainnet', 1000]);
});

test('pageInfo calculates bidirectional cursors and page flags', () => {
  const items = [
    { seq: 300 },
    { seq: 299 },
    { seq: 298 },
  ];

  // First page forward (no cursor)
  const firstPage = pageInfo(KEYSETS.ledgers, items, 3, (item: { seq: number }) => item.seq, 'FORWARD', false);
  assert.equal(firstPage.hasNextPage, true);
  assert.equal(firstPage.hasPreviousPage, false);
  assert.ok(firstPage.startCursor);
  assert.ok(firstPage.endCursor);
  assert.equal(firstPage.cursor, firstPage.endCursor);
  assert.deepEqual(decodeCursor(firstPage.startCursor, 'ledgers', 1), [300]);
  assert.deepEqual(decodeCursor(firstPage.endCursor, 'ledgers', 1), [298]);

  // Middle page forward (with cursor)
  const middlePage = pageInfo(KEYSETS.ledgers, items, 3, (item: { seq: number }) => item.seq, 'FORWARD', true);
  assert.equal(middlePage.hasNextPage, true);
  assert.equal(middlePage.hasPreviousPage, true);

  // Partial page going backward
  const partialItems = [{ seq: 302 }, { seq: 301 }];
  const backwardPage = pageInfo(KEYSETS.ledgers, partialItems, 3, (item: { seq: number }) => item.seq, 'BACKWARD', true);
  assert.equal(backwardPage.hasNextPage, true);
  assert.equal(backwardPage.hasPreviousPage, false); // reached the beginning
  assert.deepEqual(decodeCursor(backwardPage.startCursor!, 'ledgers', 1), [302]);
  assert.deepEqual(decodeCursor(backwardPage.endCursor!, 'ledgers', 1), [301]);

  // Empty page
  const emptyPage = pageInfo(KEYSETS.ledgers, [], 3, (item: { seq: number }) => item.seq, 'FORWARD', true);
  assert.equal(emptyPage.hasNextPage, false);
  assert.equal(emptyPage.hasPreviousPage, true);
  assert.equal(emptyPage.startCursor, null);
  assert.equal(emptyPage.endCursor, null);
  assert.equal(emptyPage.cursor, null);
});
