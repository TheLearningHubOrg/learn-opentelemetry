// SDK bootstrap: one place that wires traces, metrics and logs to OTLP.
// Every value comes from the environment so the same build runs locally,
// in docker compose and in Kubernetes without code changes.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  /** Base OTLP/HTTP endpoint, e.g. http://localhost:4318 (no signal path). */
  endpoint: string;
  /** Fraction of new root traces to keep, between 0 and 1. */
  sampleRatio: number;
  metricIntervalMs: number;
}

/** Pure function so it can be unit tested without touching globals. */
export function resolveOptions(env: NodeJS.ProcessEnv = process.env): TelemetryOptions {
  const ratio = Number.parseFloat(env.OTEL_SAMPLE_RATIO ?? '1');
  const interval = Number.parseInt(env.OTEL_METRIC_EXPORT_INTERVAL ?? '10000', 10);
  return {
    serviceName: env.OTEL_SERVICE_NAME ?? 'checkout-service',
    serviceVersion: env.SERVICE_VERSION ?? '1.0.0',
    environment: env.DEPLOYMENT_ENVIRONMENT ?? 'local',
    endpoint: (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(/\/+$/, ''),
    sampleRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1,
    metricIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 10000,
  };
}

export function createSdk(options: TelemetryOptions): NodeSDK {
  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
      'deployment.environment.name': options.environment,
    }),
  );

  return new NodeSDK({
    resource,
    // Head sampling: follow the upstream decision, otherwise keep a ratio of new traces.
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(options.sampleRatio),
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` })),
    ],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${options.endpoint}/v1/metrics` }),
        exportIntervalMillis: options.metricIntervalMs,
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${options.endpoint}/v1/logs` }),
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        // File system spans are noisy and rarely useful in a web service.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
}

export function startTelemetry(options: TelemetryOptions = resolveOptions()): NodeSDK {
  const sdk = createSdk(options);
  sdk.start();

  // Flush buffered spans, metrics and logs before the process exits.
  const shutdown = (): void => {
    sdk
      .shutdown()
      .catch((err: unknown) => console.error('telemetry shutdown failed', err))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return sdk;
}
