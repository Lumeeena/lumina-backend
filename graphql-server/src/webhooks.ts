/**
 * Persisted webhooks as an alternative to subscriptions (#232, #377).
 *
 * Registrations and delivery attempts live in PostgreSQL (`webhook_registrations`
 * and `webhook_deliveries`, migration 022), scoped strictly to the owning
 * `api_keys.id`, so registrations survive server restarts and are shared across
 * replicas. Delivery is triggered from the existing PostgreSQL LISTEN/NOTIFY
 * `LedgerNotifier` path.
 *
 * ## How the signing secret is stored, and why
 *
 * Unlike API keys (which only need one-way verification and are stored as
 * SHA-256 hashes), webhook delivery must compute `HMAC-SHA256(secret, payload)`
 * on every outbound POST, so the server must be able to recover the signing
 * secret at delivery time.
 *
 * - When `WEBHOOK_SECRET_ENCRYPTION_KEY` is set in the environment, secrets are
 *   encrypted at rest using AES-256-GCM with a random 96-bit IV and stored as
 *   `enc:v1:<ivHex>:<authTagHex>:<ciphertextHex>`. The key is derived via
 *   SHA-256 of the configured secret material so both 32-byte hex keys and
 *   arbitrary high-entropy passphrases work cleanly.
 * - When `WEBHOOK_SECRET_ENCRYPTION_KEY` is unset (local development only), the
 *   secret is stored prefixed as `plain:<secret>` so the format clearly
 *   distinguishes unencrypted dev rows from encrypted production rows.
 * - Plaintext secrets are returned **only once** at registration time and are
 *   never included in list or delivery responses.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import type { Router } from 'express';
import express from 'express';
import type { Pool } from 'pg';
import { callerFromLocals } from './auth';
import { subsystem } from './logger';

const log = subsystem('webhooks');

export interface WebhookFilter {
  eventTypes?: string[];
  accounts?: string[];
  assets?: string[];
}

export interface WebhookRegistration {
  id: string;
  apiKeyId: number;
  network: string;
  url: string;
  filter: WebhookFilter;
  active: boolean;
  createdAt: Date;
  lastDeliveryAt: Date | null;
  failureCount: number;
}

export interface CreatedWebhookRegistration extends WebhookRegistration {
  /** Returned only at creation time; never echoed on subsequent reads. */
  secret: string;
}

export interface WebhookDeliveryRecord {
  id: number;
  webhookId: string;
  apiKeyId: number;
  eventType: string;
  payload: unknown;
  attempt: number;
  status: 'delivered' | 'failed' | 'dead_lettered';
  httpStatus: number | null;
  error: string | null;
  deliveredAt: Date;
}

export interface WebhookEvent {
  type: string;
  network?: string;
  data: unknown;
  timestamp: Date;
}

interface WebhookRegistrationRow {
  id: string;
  api_key_id: number;
  network: string;
  url: string;
  secret_ciphertext: string;
  filter: WebhookFilter | null;
  active: boolean;
  failure_count: number;
  last_delivery_at: Date | null;
  created_at: Date;
}

interface WebhookDeliveryRow {
  id: number | string;
  webhook_id: string;
  api_key_id: number;
  event_type: string;
  payload: unknown;
  attempt: number;
  status: 'delivered' | 'failed' | 'dead_lettered';
  http_status: number | null;
  error: string | null;
  delivered_at: Date;
}

export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_RETRY_BASE_MS = 1000;
export const DEAD_LETTER_THRESHOLD = 3;

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export class WebhookValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'WebhookValidationError';
  }
}

// ─── Secret encryption at rest ────────────────────────────────────────────────

function deriveAesKey(rawKey?: string): Buffer | null {
  const material = (rawKey ?? process.env['WEBHOOK_SECRET_ENCRYPTION_KEY'] ?? '').trim();
  if (!material) return null;
  return createHash('sha256').update(material).digest();
}

export function encryptWebhookSecret(plaintext: string, rawKey?: string): string {
  const key = deriveAesKey(rawKey);
  if (!key) {
    return `plain:${plaintext}`;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptWebhookSecret(stored: string, rawKey?: string): string {
  if (stored.startsWith('plain:')) {
    return stored.slice('plain:'.length);
  }
  if (!stored.startsWith('enc:v1:')) {
    throw new Error('Unsupported webhook secret storage format');
  }
  const key = deriveAesKey(rawKey);
  if (!key) {
    throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEY is required to decrypt stored webhook secrets');
  }
  const parts = stored.split(':');
  if (parts.length !== 5) {
    throw new Error('Malformed encrypted webhook secret');
  }
  const iv = Buffer.from(parts[2]!, 'hex');
  const tag = Buffer.from(parts[3]!, 'hex');
  const ciphertext = Buffer.from(parts[4]!, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ─── Callback URL SSRF / private-network validation ───────────────────────────

export function isPrivateOrLoopbackIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase();

  // Strip IPv6 zone identifier if present.
  const withoutZone = ip.includes('%') ? ip.slice(0, ip.indexOf('%')) : ip;

  // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  if (withoutZone.startsWith('::ffff:')) {
    const mapped = withoutZone.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) return isPrivateOrLoopbackIp(mapped);
  }

  if (net.isIPv4(withoutZone)) {
    const parts = withoutZone.split('.').map((p) => parseInt(p, 10));
    const [a, b] = parts;
    if (a === undefined || b === undefined) return true;
    if (a === 0) return true; // 0.0.0.0/8 (unspecified)
    if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (a >= 224) return true; // multicast & reserved
    return false;
  }

  if (net.isIPv6(withoutZone)) {
    if (withoutZone === '::' || withoutZone === '::1') return true;
    // fc00::/7 (unique local) and fe80::/10 (link-local) and ff00::/8 (multicast)
    const firstHextet = parseInt(withoutZone.split(':')[0] || '0', 16);
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
    if ((firstHextet & 0xff00) === 0xff00) return true;
    return false;
  }

  // Unparseable IP: fail closed.
  return true;
}

/**
 * Validate a webhook callback URL against SSRF and private/loopback targets.
 *
 * Rejects non-HTTP(S) schemes, embedded credentials, localhost/internal
 * hostnames, literal private/loopback IPs, and any hostname whose DNS lookup
 * resolves to a private or loopback IP.
 */
export async function validateWebhookUrl(
  rawUrl: string,
  lookup: DnsLookupFn = (hostname) => dns.lookup(hostname, { all: true })
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WebhookValidationError('Invalid webhook callback URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new WebhookValidationError('Webhook callback URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new WebhookValidationError('Webhook callback URL must not include credentials');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) {
    throw new WebhookValidationError('Webhook callback URL must include a hostname');
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new WebhookValidationError('Webhook callback URL cannot target localhost or internal hosts');
  }

  if (net.isIP(host)) {
    if (isPrivateOrLoopbackIp(host)) {
      throw new WebhookValidationError('Webhook callback URL cannot target private or loopback IP addresses');
    }
    return parsed.toString();
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host);
  } catch {
    throw new WebhookValidationError(`Webhook callback hostname could not be resolved: ${host}`);
  }
  if (!addresses.length) {
    throw new WebhookValidationError(`Webhook callback hostname resolved to no addresses: ${host}`);
  }
  for (const entry of addresses) {
    if (isPrivateOrLoopbackIp(entry.address)) {
      throw new WebhookValidationError(
        'Webhook callback URL resolves to a private or loopback IP address'
      );
    }
  }

  return parsed.toString();
}

// ─── Payload signing & filter matching ────────────────────────────────────────

export function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function matchesFilter(filter: WebhookFilter, event: WebhookEvent): boolean {
  if (filter.eventTypes && filter.eventTypes.length > 0) {
    if (!filter.eventTypes.includes(event.type)) return false;
  }
  return true;
}

function mapRegistration(row: WebhookRegistrationRow): WebhookRegistration {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    network: row.network,
    url: row.url,
    filter: row.filter ?? {},
    active: row.active,
    createdAt: new Date(row.created_at),
    lastDeliveryAt: row.last_delivery_at ? new Date(row.last_delivery_at) : null,
    failureCount: row.failure_count,
  };
}

function mapDelivery(row: WebhookDeliveryRow): WebhookDeliveryRecord {
  return {
    id: Number(row.id),
    webhookId: row.webhook_id,
    apiKeyId: row.api_key_id,
    eventType: row.event_type,
    payload: row.payload,
    attempt: row.attempt,
    status: row.status,
    httpStatus: row.http_status,
    error: row.error,
    deliveredAt: new Date(row.delivered_at),
  };
}

// ─── Persisted CRUD (scoped to owning API key) ────────────────────────────────

export async function registerWebhook(
  pool: Pick<Pool, 'query'>,
  input: {
    apiKeyId: number;
    url: string;
    secret?: string;
    network?: string;
    filter?: WebhookFilter;
  },
  deps: { lookup?: DnsLookupFn; encryptionKey?: string } = {}
): Promise<CreatedWebhookRegistration> {
  const validatedUrl = await validateWebhookUrl(input.url, deps.lookup);
  const plaintextSecret = input.secret?.trim() || randomBytes(32).toString('hex');
  const secretCiphertext = encryptWebhookSecret(plaintextSecret, deps.encryptionKey);
  const id = randomUUID();
  const network = (input.network ?? 'mainnet').toLowerCase();
  const filter = input.filter ?? {};

  const { rows } = await pool.query<WebhookRegistrationRow>(
    `INSERT INTO webhook_registrations (id, api_key_id, network, url, secret_ciphertext, filter)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, api_key_id, network, url, secret_ciphertext, filter, active, failure_count, last_delivery_at, created_at`,
    [id, input.apiKeyId, network, validatedUrl, secretCiphertext, JSON.stringify(filter)]
  );

  const created = mapRegistration(rows[0]!);
  log.info({ id: created.id, apiKeyId: created.apiKeyId, network: created.network }, 'webhook registered');
  return { ...created, secret: plaintextSecret };
}

export async function listWebhooks(
  pool: Pick<Pool, 'query'>,
  apiKeyId: number
): Promise<WebhookRegistration[]> {
  const { rows } = await pool.query<WebhookRegistrationRow>(
    `SELECT id, api_key_id, network, url, secret_ciphertext, filter, active, failure_count, last_delivery_at, created_at
     FROM webhook_registrations
     WHERE api_key_id = $1
     ORDER BY created_at DESC`,
    [apiKeyId]
  );
  return rows.map(mapRegistration);
}

export async function deleteWebhook(
  pool: Pick<Pool, 'query'>,
  apiKeyId: number,
  id: string
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM webhook_registrations WHERE id = $1 AND api_key_id = $2`,
    [id, apiKeyId]
  );
  const removed = (result.rowCount ?? 0) > 0;
  if (removed) log.info({ id, apiKeyId }, 'webhook unregistered');
  return removed;
}

export async function listWebhookDeliveries(
  pool: Pick<Pool, 'query'>,
  apiKeyId: number,
  options: { webhookId?: string; limit?: number } = {}
): Promise<WebhookDeliveryRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const params: unknown[] = [apiKeyId];
  const conditions = ['api_key_id = $1'];
  if (options.webhookId) {
    params.push(options.webhookId);
    conditions.push(`webhook_id = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `SELECT id, webhook_id, api_key_id, event_type, payload, attempt, status, http_status, error, delivered_at
     FROM webhook_deliveries
     WHERE ${conditions.join(' AND ')}
     ORDER BY delivered_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  return rows.map(mapDelivery);
}

// ─── Delivery, retries, and dead-lettering ────────────────────────────────────

export interface WebhookDispatchDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  retryBaseMs?: number;
  lookup?: DnsLookupFn;
  encryptionKey?: string;
}

async function recordDeliveryAttempt(
  pool: Pick<Pool, 'query'>,
  row: {
    webhookId: string;
    apiKeyId: number;
    eventType: string;
    payload: string;
    attempt: number;
    status: 'delivered' | 'failed' | 'dead_lettered';
    httpStatus: number | null;
    error: string | null;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO webhook_deliveries (webhook_id, api_key_id, event_type, payload, attempt, status, http_status, error)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      row.webhookId,
      row.apiKeyId,
      row.eventType,
      row.payload,
      row.attempt,
      row.status,
      row.httpStatus,
      row.error,
    ]
  );
}

export async function deliverToWebhook(
  pool: Pick<Pool, 'query'>,
  row: WebhookRegistrationRow,
  event: WebhookEvent,
  deps: WebhookDispatchDeps = {}
): Promise<'delivered' | 'failed' | 'dead_lettered'> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  const payload = JSON.stringify(event);

  // Re-validate DNS before delivery to guard against DNS rebinding to private IPs.
  try {
    await validateWebhookUrl(row.url, deps.lookup);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordDeliveryAttempt(pool, {
      webhookId: row.id,
      apiKeyId: row.api_key_id,
      eventType: event.type,
      payload,
      attempt: 0,
      status: 'dead_lettered',
      httpStatus: null,
      error: message,
    });
    await pool.query(
      `UPDATE webhook_registrations SET active = FALSE, failure_count = failure_count + 1 WHERE id = $1`,
      [row.id]
    );
    return 'dead_lettered';
  }

  const secret = decryptWebhookSecret(row.secret_ciphertext, deps.encryptionKey);
  const signature = signPayload(secret, payload);

  let lastStatus: number | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchFn(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': event.type,
        },
        body: payload,
      });

      if (response.ok) {
        await recordDeliveryAttempt(pool, {
          webhookId: row.id,
          apiKeyId: row.api_key_id,
          eventType: event.type,
          payload,
          attempt,
          status: 'delivered',
          httpStatus: response.status,
          error: null,
        });
        await pool.query(
          `UPDATE webhook_registrations
           SET last_delivery_at = NOW(), failure_count = 0
           WHERE id = $1`,
          [row.id]
        );
        return 'delivered';
      }

      lastStatus = response.status;
      lastError = `HTTP ${response.status}`;
      await recordDeliveryAttempt(pool, {
        webhookId: row.id,
        apiKeyId: row.api_key_id,
        eventType: event.type,
        payload,
        attempt,
        status: 'failed',
        httpStatus: response.status,
        error: lastError,
      });
    } catch (err) {
      lastStatus = null;
      lastError = err instanceof Error ? err.message : String(err);
      await recordDeliveryAttempt(pool, {
        webhookId: row.id,
        apiKeyId: row.api_key_id,
        eventType: event.type,
        payload,
        attempt,
        status: 'failed',
        httpStatus: null,
        error: lastError,
      });
    }

    if (attempt < maxRetries) {
      await sleep(retryBaseMs * Math.pow(2, attempt));
    }
  }

  const nextFailures = row.failure_count + 1;
  const disable = nextFailures >= DEAD_LETTER_THRESHOLD;
  await recordDeliveryAttempt(pool, {
    webhookId: row.id,
    apiKeyId: row.api_key_id,
    eventType: event.type,
    payload,
    attempt: maxRetries + 1,
    status: 'dead_lettered',
    httpStatus: lastStatus,
    error: lastError,
  });
  await pool.query(
    `UPDATE webhook_registrations
     SET failure_count = $2, active = CASE WHEN $3 THEN FALSE ELSE active END
     WHERE id = $1`,
    [row.id, nextFailures, disable]
  );
  if (disable) {
    log.error({ id: row.id, failureCount: nextFailures }, 'webhook disabled after repeated failures');
  }
  return 'dead_lettered';
}

export async function dispatchWebhookEvent(
  pool: Pick<Pool, 'query'>,
  event: WebhookEvent,
  deps: WebhookDispatchDeps = {}
): Promise<void> {
  const params: unknown[] = [];
  const conditions = ['active = TRUE'];
  if (event.network) {
    params.push(event.network.toLowerCase());
    conditions.push(`network = $${params.length}`);
  }
  const { rows } = await pool.query<WebhookRegistrationRow>(
    `SELECT id, api_key_id, network, url, secret_ciphertext, filter, active, failure_count, last_delivery_at, created_at
     FROM webhook_registrations
     WHERE ${conditions.join(' AND ')}`,
    params
  );

  const matching = rows.filter((r) => matchesFilter(r.filter ?? {}, event));
  await Promise.allSettled(matching.map((r) => deliverToWebhook(pool, r, event, deps)));
}

// ─── Authenticated Express router (/webhooks) ─────────────────────────────────

/**
 * Mount behind `apiKeyAuthMiddleware` + `express.json()`. Every endpoint
 * requires a real API key (`caller.kind === 'api-key'`); anonymous callers are
 * refused with 401 so webhooks are always scoped to an owning key.
 */
export function createWebhooksRouter(pool: Pool): Router {
  const router = express.Router();

  function requireApiKeyId(res: express.Response): number | null {
    const caller = callerFromLocals(res.locals);
    if (!caller || caller.kind !== 'api-key' || caller.keyId === null) {
      res.status(401).json({ error: 'An authenticated API key is required to manage webhooks.' });
      return null;
    }
    return caller.keyId;
  }

  router.get('/', async (_req, res) => {
    const apiKeyId = requireApiKeyId(res);
    if (apiKeyId === null) return;
    try {
      const webhooks = await listWebhooks(pool, apiKeyId);
      res.json({ webhooks });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'failed to list webhooks');
      res.status(500).json({ error: 'Failed to list webhooks' });
    }
  });

  router.post('/', async (req, res) => {
    const apiKeyId = requireApiKeyId(res);
    if (apiKeyId === null) return;
    const body = (req.body ?? {}) as {
      url?: string;
      secret?: string;
      network?: string;
      filter?: WebhookFilter;
    };
    if (typeof body.url !== 'string' || !body.url.trim()) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    try {
      const webhook = await registerWebhook(pool, {
        apiKeyId,
        url: body.url,
        secret: body.secret,
        network: body.network,
        filter: body.filter,
      });
      res.status(201).json({ webhook });
    } catch (err) {
      if (err instanceof WebhookValidationError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      log.error({ err: err instanceof Error ? err.message : err }, 'failed to register webhook');
      res.status(500).json({ error: 'Failed to register webhook' });
    }
  });

  router.delete('/:id', async (req, res) => {
    const apiKeyId = requireApiKeyId(res);
    if (apiKeyId === null) return;
    try {
      const removed = await deleteWebhook(pool, apiKeyId, req.params.id);
      if (!removed) {
        res.status(404).json({ error: 'Webhook not found' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'failed to delete webhook');
      res.status(500).json({ error: 'Failed to delete webhook' });
    }
  });

  router.get('/deliveries', async (req, res) => {
    const apiKeyId = requireApiKeyId(res);
    if (apiKeyId === null) return;
    const limit = req.query['limit'] ? parseInt(String(req.query['limit']), 10) : 50;
    try {
      const deliveries = await listWebhookDeliveries(pool, apiKeyId, { limit });
      res.json({ deliveries });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'failed to list webhook deliveries');
      res.status(500).json({ error: 'Failed to list webhook deliveries' });
    }
  });

  router.get('/:id/deliveries', async (req, res) => {
    const apiKeyId = requireApiKeyId(res);
    if (apiKeyId === null) return;
    const limit = req.query['limit'] ? parseInt(String(req.query['limit']), 10) : 50;
    try {
      const deliveries = await listWebhookDeliveries(pool, apiKeyId, {
        webhookId: req.params.id,
        limit,
      });
      res.json({ deliveries });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'failed to list webhook deliveries');
      res.status(500).json({ error: 'Failed to list webhook deliveries' });
    }
  });

  return router;
}
