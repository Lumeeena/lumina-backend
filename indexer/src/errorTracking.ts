import * as Sentry from '@sentry/node';
import { subsystem } from './logger';

const log = subsystem('error-tracking');

const SENTRY_DSN = process.env.SENTRY_DSN;
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT ?? 'development';
const SENTRY_RELEASE = process.env.SENTRY_RELEASE ?? '0.1.0';
const SERVICE_NAME = 'lumina-indexer';

export function initErrorTracking(): void {
  if (!SENTRY_DSN) {
    log.info('Sentry DSN not configured, error tracking disabled');
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE,
    tracesSampleRate: 1.0,
    beforeSend(event, hint) {
      return scrubSensitiveData(event);
    },
  });

  log.info({ environment: SENTRY_ENVIRONMENT, release: SENTRY_RELEASE }, 'Sentry initialized');
}

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

function scrubSensitiveData(event: Sentry.Event): Sentry.Event {
  if (event.request) {
    const headers = event.request.headers || {};
    const scrubbed = { ...headers };
    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'x-token'];
    for (const header of sensitiveHeaders) {
      if (header in scrubbed) {
        scrubbed[header] = '[REDACTED]';
      }
    }
    event.request.headers = scrubbed;
  }

  if (event.contexts?.db?.statement) {
    event.contexts.db.statement = scrubPII(event.contexts.db.statement);
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

function scrubPII(text: string): string {
  text = text.replace(/password["\s:=]+["']?[^"'\s,}]+["']?/gi, 'password=***');
  text = text.replace(/api[_-]?key["\s:=]+["']?[^"'\s,}]+["']?/gi, 'api_key=***');
  text = text.replace(/token["\s:=]+["']?[^"'\s,}]+["']?/gi, 'token=***');
  text = text.replace(/secret["\s:=]+["']?[^"'\s,}]+["']?/gi, 'secret=***');
  return text;
}

export async function shutdownErrorTracking(): Promise<void> {
  if (!SENTRY_DSN) return;
  await Sentry.close(2000);
}
