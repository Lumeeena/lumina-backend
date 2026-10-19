/**
 * Sentry error tracking.
 *
 * Opt-in by design: with `SENTRY_DSN` unset the SDK is never initialized and
 * every export degrades to a no-op, so local runs and tests stay inert. Once a
 * DSN is present, `beforeSend` scrubs each event before it leaves the process:
 * credential-bearing request headers become `[REDACTED]`, and
 * `password`/`api_key`/`token`/`secret` values inside SQL statements and stack
 * context lines are masked, so database credentials and user data never reach
 * Sentry. Captured exceptions are tagged with the service name and release so
 * issues can be routed per deployment.
 */
import * as Sentry from '@sentry/node';
import { subsystem } from './logger';

const log = subsystem('error-tracking');

const SENTRY_DSN = process.env.SENTRY_DSN;
// Sensible local defaults; deployments should set both so events land in the
// right environment and release.
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT ?? 'development';
const SENTRY_RELEASE = process.env.SENTRY_RELEASE ?? '0.1.0';
const SERVICE_NAME = 'lumina-indexer';

/**
 * Request headers that carry credentials. Their values are replaced with
 * `[REDACTED]` before an event is transmitted.
 */
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-api-key', 'x-token'];

/**
 * Initialize Sentry when `SENTRY_DSN` is set; otherwise log and return.
 * Call once at startup — this is a no-op when telemetry is disabled.
 */
export function initErrorTracking(): void {
  if (!SENTRY_DSN) {
    log.info('Sentry DSN not configured, error tracking disabled');
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE,
    // Every transaction is sampled: the indexer's steady request volume is low
    // enough that full traces cost little, and completeness is what makes
    // Sentry useful for diagnosing Horizon/Soroban stalls. Lower this if
    // transaction volume or cost grows.
    tracesSampleRate: 1.0,
    beforeSend,
  });

  log.info({ environment: SENTRY_ENVIRONMENT, release: SENTRY_RELEASE }, 'Sentry initialized');
}

/**
 * Sentry `beforeSend` hook: scrub credential headers, SQL statements, and
 * stack context lines from error events before they are transmitted.
 */
export function beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  return scrubSensitiveData(event);
}

/**
 * Capture an exception, attaching `context` as the `error-details` context
 * alongside the service and version tags. No-op when telemetry is disabled.
 */
export function captureException(error: Error, context?: Record<string, any>): void {
  if (!SENTRY_DSN) return;

  Sentry.captureException(error, scope => {
    if (context) {
      scope.setContext('error-details', context);
    }
    scope.setTag('service', SERVICE_NAME);
    scope.setTag('version', SENTRY_RELEASE);
    return scope;
  });
}

function scrubSensitiveData(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    const headers = event.request.headers || {};
    const scrubbed = { ...headers };
    for (const header of SENSITIVE_HEADERS) {
      if (header in scrubbed) {
        scrubbed[header] = '[REDACTED]';
      }
    }
    event.request.headers = scrubbed;
  }

  const statement = event.contexts?.db?.statement;
  if (typeof statement === 'string') {
    event.contexts!.db!.statement = scrubPII(statement);
  }

  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.stacktrace?.frames) {
        for (const frame of exception.stacktrace.frames) {
          if (frame.context_line) {
            frame.context_line = scrubPII(frame.context_line);
          }
        }
      }
    }
  }

  return event;
}

/**
 * Mask credential values in free-form text (SQL statements, stack context
 * lines). Deliberately broad: a false positive only costs diagnostic detail,
 * while a miss leaks a secret.
 */
function scrubPII(text: string): string {
  text = text.replace(/password["\s:=]+["']?[^"'\s,}]+["']?/gi, 'password=***');
  text = text.replace(/api[_-]?key["\s:=]+["']?[^"'\s,}]+["']?/gi, 'api_key=***');
  text = text.replace(/token["\s:=]+["']?[^"'\s,}]+["']?/gi, 'token=***');
  text = text.replace(/secret["\s:=]+["']?[^"'\s,}]+["']?/gi, 'secret=***');
  return text;
}

/**
 * Flush buffered events and close the SDK. The 2s bound means shutdown cannot
 * hang on a stuck Sentry connection — anything still queued afterwards is
 * dropped. No-op when telemetry is disabled.
 */
export async function shutdownErrorTracking(): Promise<void> {
  if (!SENTRY_DSN) return;
  await Sentry.close(2000);
}
