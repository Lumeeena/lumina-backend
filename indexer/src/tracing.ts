/**
 * Optional OpenTelemetry setup for the indexer.
 *
 * The indexer can run without a collector; tracing is enabled only when
 * `OTEL_ENABLED=true`. When enabled, this module exports spans over OTLP/HTTP
 * and installs PostgreSQL instrumentation so database calls inherit the
 * active operation span.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace, context as otelContext } from '@opentelemetry/api';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

/** Tracing configuration is read once when this module is loaded. */
const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';
/** The local collector default keeps a standard OpenTelemetry development setup zero-config. */
const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
/** Stable service identity and version defaults for deployments that omit resource metadata. */
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'lumina-indexer';
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION ?? '0.1.0';

/** The SDK instance, or `null` when tracing has not been initialized. */
export let sdk: NodeSDK | null = null;

/**
 * Starts OpenTelemetry only when `OTEL_ENABLED` was set to `"true"` at module
 * load time. The SDK instruments PostgreSQL and exports spans to the configured
 * OTLP/HTTP endpoint.
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
      new PgInstrumentation(),
    ],
  });

  sdk.start();
}

/** Returns the indexer's versioned OpenTelemetry tracer. */
export function getTracer() {
  return trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
}

/** Flushes and stops the SDK if tracing was initialized. */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
  }
}

/** Runs a synchronous callback with a named span active for its duration. */
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

/** Runs an async callback with a named span active until it settles. */
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
