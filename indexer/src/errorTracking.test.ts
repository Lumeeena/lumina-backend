import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ErrorEvent } from '@sentry/node';
import { beforeSend, beforeSendTransaction } from './errorTracking';

// TransactionEvent is not re-exported by @sentry/node; derive it from the hook.
type TransactionEvent = Parameters<typeof beforeSendTransaction>[0];

function errorEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return { ...overrides } as ErrorEvent;
}

function transactionEvent(overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return { type: 'transaction', ...overrides } as TransactionEvent;
}

test('beforeSend redacts credential-bearing request headers', () => {
  const event = errorEvent({
    request: {
      headers: {
        authorization: 'Bearer top-secret',
        cookie: 'session=abc',
        'x-api-key': 'key-123',
        'x-token': 'token-456',
        'content-type': 'application/json',
      },
    },
  });

  const scrubbed = beforeSend(event);

  for (const header of ['authorization', 'cookie', 'x-api-key', 'x-token']) {
    assert.equal(scrubbed.request?.headers?.[header], '[REDACTED]', header);
  }
  assert.equal(scrubbed.request?.headers?.['content-type'], 'application/json');
});

test('beforeSend masks credential values in a database statement', () => {
  const event = errorEvent({
    contexts: {
      db: { statement: "SELECT * FROM users WHERE password = 'hunter2' AND api_key = 'key-123'" },
    },
  });

  const statement = beforeSend(event).contexts?.db?.statement as string;

  assert.match(statement, /password=\*\*\*/);
  assert.match(statement, /api_key=\*\*\*/);
  assert.ok(!statement.includes('hunter2'));
  assert.ok(!statement.includes('key-123'));
});

test('beforeSend masks credential values in stack context lines', () => {
  const event = errorEvent({
    exception: {
      values: [
        {
          stacktrace: {
            frames: [{ filename: 'db.ts', context_line: "const secret = 'shhh';" }],
          },
        },
      ],
    },
  });

  const line = beforeSend(event).exception?.values?.[0]?.stacktrace?.frames?.[0]?.context_line ?? '';

  assert.match(line, /secret=\*\*\*/);
  assert.ok(!line.includes('shhh'));
});

test('beforeSend leaves events without request, contexts, or exception untouched', () => {
  const event = errorEvent();
  assert.equal(beforeSend(event), event);
});

test('beforeSend leaves ordinary SQL untouched', () => {
  const sql = 'SELECT id, ledger FROM events WHERE ledger = 42';
  const event = errorEvent({ contexts: { db: { statement: sql } } });

  assert.equal(beforeSend(event).contexts?.db?.statement, sql);
});

test('beforeSend redacts sensitive headers regardless of casing', () => {
  const event = errorEvent({
    request: {
      headers: {
        Authorization: 'Bearer top-secret',
        cookie: 'session=abc',
        'X-Api-Key': 'key-123',
        'X-Token': 'token-456',
      },
    },
  });

  const headers = beforeSend(event).request?.headers;

  assert.equal(headers?.['Authorization'], '[REDACTED]');
  assert.equal(headers?.['cookie'], '[REDACTED]');
  assert.equal(headers?.['X-Api-Key'], '[REDACTED]');
  assert.equal(headers?.['X-Token'], '[REDACTED]');
});

test('beforeSendTransaction applies the same scrubbing to transaction events', () => {
  const event = transactionEvent({
    request: { headers: { cookie: 'session=abc' } },
    contexts: { db: { statement: "SELECT * FROM api_keys WHERE token = 'abc123'" } },
  });

  const scrubbed = beforeSendTransaction(event);

  assert.equal(scrubbed.request?.headers?.['cookie'], '[REDACTED]');
  assert.match(String(scrubbed.contexts?.db?.statement), /token=\*\*\*/);
});
