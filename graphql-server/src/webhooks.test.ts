import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  decryptWebhookSecret,
  deleteWebhook,
  dispatchWebhookEvent,
  encryptWebhookSecret,
  isPrivateOrLoopbackIp,
  listWebhookDeliveries,
  listWebhooks,
  registerWebhook,
  signPayload,
  validateWebhookUrl,
  WebhookValidationError,
} from './webhooks';

const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];

test('signPayload produces deterministic HMAC-SHA256 hex digest', () => {
  const sig1 = signPayload('super-secret', '{"type":"ledger"}');
  const sig2 = signPayload('super-secret', '{"type":"ledger"}');
  const sig3 = signPayload('other-secret', '{"type":"ledger"}');
  assert.equal(sig1, sig2);
  assert.notEqual(sig1, sig3);
  assert.match(sig1, /^[0-9a-f]{64}$/);
});

test('encryptWebhookSecret and decryptWebhookSecret round-trip with AES-256-GCM', () => {
  const enc = encryptWebhookSecret('my-signing-secret', 'prod-master-key-material');
  assert.ok(enc.startsWith('enc:v1:'));
  assert.ok(!enc.includes('my-signing-secret'));
  assert.equal(decryptWebhookSecret(enc, 'prod-master-key-material'), 'my-signing-secret');
});

test('validateWebhookUrl rejects loopback, private RFC1918, metadata, and internal hosts', async () => {
  assert.equal(isPrivateOrLoopbackIp('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('10.0.0.5'), true);
  assert.equal(isPrivateOrLoopbackIp('172.16.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('192.168.1.10'), true);
  assert.equal(isPrivateOrLoopbackIp('169.254.169.254'), true);
  assert.equal(isPrivateOrLoopbackIp('::1'), true);
  assert.equal(isPrivateOrLoopbackIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('93.184.216.34'), false);

  for (const bad of [
    'http://127.0.0.1:8080/hook',
    'http://localhost/hook',
    'http://metadata.internal/latest',
    'https://10.20.30.40/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/hook',
    'file:///etc/passwd',
    'https://user:pass@example.com/hook',
  ]) {
    await assert.rejects(() => validateWebhookUrl(bad, PUBLIC_DNS), WebhookValidationError);
  }

  // Rejects domain resolving to a private IP (DNS SSRF protection).
  await assert.rejects(
    () =>
      validateWebhookUrl('https://evil.example/hook', async () => [
        { address: '192.168.0.1', family: 4 },
      ]),
    WebhookValidationError
  );

  // Accepts a public HTTPS URL.
  const ok = await validateWebhookUrl('https://hooks.example.com/stellar', PUBLIC_DNS);
  assert.equal(ok, 'https://hooks.example.com/stellar');
});

test('registerWebhook persists to DB, scopes by api_key_id, and survives restart', async () => {
  const stored: Array<Record<string, unknown>> = [];
  const fakePool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO webhook_registrations')) {
        const row = {
          id: params[0],
          api_key_id: params[1],
          network: params[2],
          url: params[3],
          secret_ciphertext: params[4],
          filter: JSON.parse(String(params[5])),
          active: true,
          failure_count: 0,
          last_delivery_at: null,
          created_at: new Date(),
        };
        stored.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('FROM webhook_registrations')) {
        return { rows: stored.filter((r) => r['api_key_id'] === params[0]), rowCount: 1 };
      }
      if (sql.includes('DELETE FROM webhook_registrations')) {
        const before = stored.length;
        const idx = stored.findIndex((r) => r['id'] === params[0] && r['api_key_id'] === params[1]);
        if (idx >= 0) stored.splice(idx, 1);
        return { rows: [], rowCount: before - stored.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  const created = await registerWebhook(
    fakePool,
    { apiKeyId: 7, url: 'https://hooks.example.com/events', filter: { eventTypes: ['ledger'] } },
    { lookup: PUBLIC_DNS, encryptionKey: 'test-key' }
  );
  assert.equal(created.apiKeyId, 7);
  assert.ok(created.secret.length >= 32);

  // Key 7 sees it; key 8 does not.
  assert.equal((await listWebhooks(fakePool, 7)).length, 1);
  assert.equal((await listWebhooks(fakePool, 8)).length, 0);

  // Key 8 cannot delete key 7's webhook; key 7 can.
  assert.equal(await deleteWebhook(fakePool, 8, created.id), false);
  assert.equal(await deleteWebhook(fakePool, 7, created.id), true);
  assert.equal((await listWebhooks(fakePool, 7)).length, 0);
});

test('dispatchWebhookEvent signs payload, retries with backoff, records attempts, and dead-letters', async () => {
  const deliveries: Array<Record<string, unknown>> = [];
  const registration = {
    id: '00000000-0000-0000-0000-000000000001',
    api_key_id: 42,
    network: 'mainnet',
    url: 'https://hooks.example.com/retry',
    secret_ciphertext: encryptWebhookSecret('whsec_test', 'enc-key'),
    filter: { eventTypes: ['ledger'] },
    active: true,
    failure_count: 2, // one more failure triggers dead-letter disable
    last_delivery_at: null,
    created_at: new Date(),
  };

  const fakePool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM webhook_registrations')) {
        return { rows: [registration], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO webhook_deliveries')) {
        deliveries.push({
          id: deliveries.length + 1,
          webhook_id: params[0],
          api_key_id: params[1],
          event_type: params[2],
          payload: JSON.parse(String(params[3])),
          attempt: params[4],
          status: params[5],
          http_status: params[6],
          error: params[7],
          delivered_at: new Date(),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE webhook_registrations')) {
        registration.failure_count = Number(params[1]);
        if (params[2] === true) registration.active = false;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM webhook_deliveries')) {
        return { rows: deliveries.filter((d) => d['api_key_id'] === params[0]), rowCount: deliveries.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  const sleepDelays: number[] = [];
  const seenSignatures: string[] = [];

  await dispatchWebhookEvent(
    fakePool,
    { type: 'ledger', network: 'mainnet', data: { ledger: 500 }, timestamp: new Date('2026-05-01T00:00:00Z') },
    {
      lookup: PUBLIC_DNS,
      encryptionKey: 'enc-key',
      maxRetries: 2,
      retryBaseMs: 10,
      sleep: async (ms) => {
        sleepDelays.push(ms);
      },
      fetchFn: (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        const sig = init?.headers?.['X-Webhook-Signature'] ?? '';
        seenSignatures.push(sig);
        assert.equal(sig, signPayload('whsec_test', String(init?.body ?? '')));
        return { ok: false, status: 503 } as Response;
      }) as typeof fetch,
    }
  );

  // 3 attempts (0, 1, 2) + 1 dead-letter record; exponential backoff delays [10, 20].
  assert.equal(seenSignatures.length, 3);
  assert.deepEqual(sleepDelays, [10, 20]);
  assert.equal(registration.active, false);

  const key42Deliveries = await listWebhookDeliveries(fakePool, 42);
  assert.equal(key42Deliveries.length, 4);
  assert.equal(key42Deliveries[3]?.status, 'dead_lettered');
  assert.equal((await listWebhookDeliveries(fakePool, 999)).length, 0);
});
