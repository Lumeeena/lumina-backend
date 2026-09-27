import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEXED_CHANNEL, notifyIndexed, parseNotification, serializeNotification } from './notify';

function recordingDb() {
  const calls: { sql: string; params?: unknown[] | undefined }[] = [];
  return {
    calls,
    db: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    },
  };
}

test('notifyIndexed sends the payload as a bind parameter, never inlined', async () => {
  const { db, calls } = recordingDb();

  await notifyIndexed(db, {
    kind: 'ledger',
    network: 'testnet',
    ledger: 100,
    transactions: 2,
    operations: 5,
  });

  assert.equal(calls.length, 1);
  // `NOTIFY` takes a literal, not a parameter — building the payload by string
  // concatenation would be an injection hole, so pg_notify is used instead.
  assert.match(calls[0]!.sql, /pg_notify\(\$1, \$2\)/);
  assert.equal(calls[0]!.params?.[0], INDEXED_CHANNEL);
  assert.deepEqual(JSON.parse(calls[0]!.params?.[1] as string), {
    kind: 'ledger',
    network: 'testnet',
    ledger: 100,
    transactions: 2,
    operations: 5,
  });
});

test('serializeNotification keeps a normal payload intact', () => {
  const payload = serializeNotification({
    kind: 'ledger',
    network: 'mainnet',
    ledger: 42,
    transactions: 1,
    operations: 3,
  });

  assert.deepEqual(JSON.parse(payload), {
    kind: 'ledger',
    network: 'mainnet',
    ledger: 42,
    transactions: 1,
    operations: 3,
  });
});

test('serializeNotification degrades rather than exceeding the NOTIFY limit', () => {
  // Postgres rejects a payload over 8000 bytes outright, so an oversized
  // notification has to shed its optional fields rather than be lost.
  const huge = {
    kind: 'ledger' as const,
    network: 'mainnet',
    ledger: 99,
    transactions: Number.MAX_SAFE_INTEGER,
    operations: Number.MAX_SAFE_INTEGER,
    // A field a future indexer might add, large enough to blow the budget.
    filler: 'x'.repeat(9000),
  };

  const payload = serializeNotification({ ...huge, network: 'mainnet' } as never);

  assert.ok(Buffer.byteLength(payload, 'utf8') < 8000);
  // Counts and anything unknown are shed; the network is one of the two fields
  // a subscriber needs to decide whether the rows are its rows, so it stays.
  assert.deepEqual(JSON.parse(payload), { kind: 'ledger', network: 'mainnet', ledger: 99 });
});

test('parseNotification round-trips what notifyIndexed writes', () => {
  const original = { kind: 'events' as const, network: 'futurenet', ledger: 7, events: 3 };

  const parsed = parseNotification(serializeNotification(original));

  assert.equal(parsed?.kind, 'events');
  assert.equal(parsed?.network, 'futurenet');
  assert.equal(parsed?.ledger, 7);
  assert.equal(parsed?.events, 3);
});

test('a payload from before per-network notifications still parses', () => {
  // An indexer that has not been redeployed must not break the server's
  // LISTEN: absence of a network means "the one network this deployment has",
  // not a malformed payload.
  const parsed = parseNotification('{"kind":"ledger","ledger":5}');

  assert.equal(parsed?.ledger, 5);
  assert.equal(parsed?.network, undefined);
});

test('parseNotification rejects malformed payloads instead of throwing', () => {
  // Any of these reaching a `throw` would take down the LISTEN connection that
  // every subscriber shares.
  assert.equal(parseNotification(undefined), null);
  assert.equal(parseNotification(''), null);
  assert.equal(parseNotification('not json'), null);
  assert.equal(parseNotification('{"kind":"ledger"}'), null, 'missing ledger');
  assert.equal(parseNotification('{"ledger":5}'), null, 'missing kind');
  assert.equal(parseNotification('{"kind":"wat","ledger":5}'), null, 'unknown kind');
  assert.equal(parseNotification('{"kind":"ledger","ledger":"five"}'), null, 'non-numeric ledger');
});

test('parseNotification drops non-numeric counts but keeps the notification', () => {
  const parsed = parseNotification('{"kind":"ledger","ledger":5,"transactions":"many"}');

  assert.equal(parsed?.ledger, 5);
  assert.equal(parsed?.transactions, undefined);
});

test('parseNotification drops a non-string network but keeps the notification', () => {
  const parsed = parseNotification('{"kind":"ledger","network":123,"ledger":5}');

  assert.equal(parsed?.ledger, 5);
  assert.equal(parsed?.network, undefined);
});
