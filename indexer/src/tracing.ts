import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace, context as otelContext } from '@opentelemetry/api';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';

const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';
const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'lumina-indexer';
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION ?? '0.1.0';

export let sdk: NodeSDK | null = null;

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

export function getTracer() {
  return trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
  }
}

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
