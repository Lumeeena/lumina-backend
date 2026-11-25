/**
 * OpenTelemetry tracing integration for the GraphQL server.
 *
 * Configurable via environment variables: OTEL_ENABLED, OTEL_EXPORTER_OTLP_ENDPOINT,
 * OTEL_SERVICE_NAME, OTEL_SERVICE_VERSION. When disabled, functions are no-ops.
 * Instruments pg, Express, and GraphQL via auto-instrumentation.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace, context as otelContext } from '@opentelemetry/api';

/** Enable tracing if OTEL_ENABLED=true; disabled by default for zero overhead. */
const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';
/** Collector endpoint; defaults to localhost:4318 for local development. */
const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
/** Service name reported to the collector; set via OTEL_SERVICE_NAME. */
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'lumina-graphql';
/** Service version reported to the collector; set via OTEL_SERVICE_VERSION. */
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION ?? '0.1.0';

/** Global OpenTelemetry SDK instance; initialized by initTracing(). */
export let sdk: NodeSDK | null = null;

/** Initialize the OpenTelemetry SDK if OTEL_ENABLED=true; otherwise no-op. */
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

/** Obtain the tracer for creating and managing spans. */
export function getTracer() {
  return trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
}

/** Gracefully shutdown the tracing SDK; flushes any pending spans. */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
  }
}

/** Execute a synchronous function with a span; automatically ends the span. */
export function runWithSpan<T>(name: string, fn: (span: any) => T): T {
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

/** Execute an async function with a span; automatically ends the span after completion or error. */
export async function runWithSpanAsync<T>(name: string, fn: (span: any) => Promise<T>): Promise<T> {
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
