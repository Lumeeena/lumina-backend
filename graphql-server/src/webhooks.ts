/**
 * Webhooks as an alternative to subscriptions (#232).
 *
 * Allows registering callback URLs with filters for real-time event delivery.
 * Signed payloads for origin verification, retry with backoff, and dead-letter
 * path for failed deliveries.
 */

import { createHmac, randomUUID } from "crypto";
import { logger } from "./logger.js";

interface WebhookRegistration {
  id: string;
  url: string;
  secret: string;
  filter: {
    eventTypes?: string[];
    accounts?: string[];
    assets?: string[];
  };
  active: boolean;
  createdAt: Date;
  lastDelivery?: Date;
  failureCount: number;
}

interface WebhookEvent {
  type: string;
  data: unknown;
  timestamp: Date;
}

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 1000;

const registrations = new Map<string, WebhookRegistration>();

/**
 * Register a webhook callback URL with optional filters.
 * Requires authentication (handled by the caller).
 */
export function registerWebhook(
  url: string,
  secret: string,
  filter: WebhookRegistration["filter"],
): WebhookRegistration {
  const registration: WebhookRegistration = {
    id: randomUUID(),
    url,
    secret,
    filter,
    active: true,
    createdAt: new Date(),
    failureCount: 0,
  };

  registrations.set(registration.id, registration);
  logger.info("Webhook registered", { id: registration.id, url });
  return registration;
}

/**
 * Unregister a webhook by ID.
 */
export function unregisterWebhook(id: string): boolean {
  const removed = registrations.delete(id);
  if (removed) logger.info("Webhook unregistered", { id });
  return removed;
}

/**
 * List all registered webhooks.
 */
export function listWebhooks(): WebhookRegistration[] {
  return Array.from(registrations.values());
}

/**
 * Sign a webhook payload for origin verification.
 */
export function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Check if an event matches a webhook's filters.
 */
function matchesFilter(filter: WebhookRegistration["filter"], event: WebhookEvent): boolean {
  if (filter.eventTypes && filter.eventTypes.length > 0) {
    if (!filter.eventTypes.includes(event.type)) return false;
  }
  return true;
}

/**
 * Deliver an event to a single webhook with retry and backoff.
 */
async function deliverToWebhook(
  registration: WebhookRegistration,
  event: WebhookEvent,
): Promise<void> {
  const payload = JSON.stringify(event);
  const signature = signPayload(registration.secret, payload);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(registration.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Event": event.type,
        },
        body: payload,
      });

      if (response.ok) {
        registration.lastDelivery = new Date();
        registration.failureCount = 0;
        return;
      }

      logger.warn("Webhook delivery failed", {
        id: registration.id,
        status: response.status,
        attempt,
      });
    } catch (err) {
      logger.warn("Webhook delivery error", {
        id: registration.id,
        error: (err as Error).message,
        attempt,
      });
    }

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Dead-letter: too many failures, disable the webhook
  registration.failureCount++;
  if (registration.failureCount >= 3) {
    registration.active = false;
    logger.error("Webhook disabled after repeated failures", { id: registration.id });
  }
}

/**
 * Dispatch an event to all matching webhooks.
 */
export async function dispatchWebhookEvent(event: WebhookEvent): Promise<void> {
  const activeWebhooks = Array.from(registrations.values()).filter(
    (r) => r.active && matchesFilter(r.filter, event),
  );

  await Promise.allSettled(
    activeWebhooks.map((registration) => deliverToWebhook(registration, event)),
  );
}
