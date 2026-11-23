/**
 * OpenTelemetry Distributed Tracing Setup & Span Helpers.
 *
 * This module configures OpenTelemetry tracing across the GraphQL server,
 * providing automated instrumentation for PostgreSQL queries (`pg`),
 * HTTP requests (`express`), and GraphQL execution steps (`graphql`).
 *
 * Distributed tracing is critical for distributed indexer / GraphQL setups,
 * allowing engineers to track request latency breakdowns across database roundtrips,
 * schema resolver invocations, and external Horizon calls without manual timer probes.
 *
 * Tracing is opt-in (`OTEL_ENABLED=true`) so that local unit test suites and
 * lightweight CLI executions do not incur trace collection overhead or attempt
 * connections to non-existent collector endpoints.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace, context as otelContext, type Tracer, type Span } from '@opentelemetry/api';

/**
 * Opt-in flag for OpenTelemetry initialization.
 * Defaults to false (`process.env.OTEL_ENABLED === 'true'`) to ensure that
 * testing, offline tools, and local developers do not generate network errors
 * attempting to reach a local collector daemon.
 */
const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';

/**
 * OTLP HTTP receiver endpoint for spans.
 * Defaults to standard OTLP port 4318 (`http://localhost:4318`).
 * Tunable via `OTEL_EXPORTER_OTLP_ENDPOINT` for containerized environments
 * such as AWS ECS or Kubernetes sidecars.
 */
const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

/**
 * Service name tag emitted in trace resource attributes.
 * Defaults to 'lumina-graphql' for canonical service identification in Jaeger / Datadog.
 */
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'lumina-graphql';

/**
 * Version attribute attached to exported spans, matching server deployment tag.
 * Defaults to '0.1.0'.
 */
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION ?? '0.1.0';

/**
 * Active NodeSDK instance if initialized, or null when disabled or stopped.
 */
export let sdk: NodeSDK | null = null;

/**
 * Initializes and starts the OpenTelemetry NodeSDK if `OTEL_ENABLED` is true.
 *
 * Registers automated instrumentation for PostgreSQL, Express, and GraphQL,
 * configuring an OTLP HTTP trace exporter pointing to `OTEL_EXPORTER_OTLP_ENDPOINT`.
 * If `OTEL_ENABLED` is false, this is a no-op to eliminate overhead in dev/tests.
 */
export function initTracing(): void {
  if (!OTEL_ENABLED) return;

  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
      [SemanticResourceAttributes.SERVICE_VERSION]: SERVICE_VERSION,
    }),
    traceExporter: new OTLPTraceExporter({
      url: OTEL_EXPORTER_OTLP_ENDPOINT,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-pg': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-express': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-graphql': {
          enabled: true,
        },
      }),
    ],
  });

  sdk.start();
}

/**
 * Retrieves the application's Tracer instance scoped to the service name and version.
 *
 * @returns A tracer from the OpenTelemetry API registry.
 */
export function getTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
}

/**
 * Shuts down the OpenTelemetry SDK cleanly, flushing any in-memory queued spans.
 * Safe to invoke even if tracing was not initialized (no-op when `sdk` is null).
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}

/**
 * Wraps a synchronous callback function within a named trace span.
 *
 * Sets the active trace context for any nested operations and guarantees that
 * `span.end()` is invoked via `finally`, even if the callback throws an error.
 *
 * @param name Name of the span describing the operation (e.g. 'db.query')
 * @param fn Callback receiving the span instance and returning a synchronous result
 * @returns The return value of `fn`
 */
export function runWithSpan<T>(name: string, fn: (span: Span) => T): T {
  const tracer = getTracer();
  const span = tracer.startSpan(name);
  return otelContext.with(trace.setSpan(otelContext.active(), span), () => {
    try {
      return fn(span);
    } finally {
      span.end();
    }
  });
}

/**
 * Wraps an asynchronous callback function within a named trace span.
 *
 * Sets the active trace context across async promise boundaries and guarantees
 * that `span.end()` is invoked via `finally`, even if the promise rejects.
 *
 * @param name Name of the span describing the async operation (e.g. 'horizon.fetch')
 * @param fn Async callback receiving the span instance and returning a promise
 * @returns A promise resolving to the return value of `fn`
 */
export async function runWithSpanAsync<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = getTracer();
  const span = tracer.startSpan(name);
  return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
    try {
      return await fn(span);
    } finally {
      span.end();
    }
  });
}
