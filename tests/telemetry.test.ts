// Runs with the built-in node:test runner via `tsx --test`.
// In-memory exporters replace OTLP so every span, metric and log can be asserted on.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, beforeEach, describe, it } from 'node:test';
import { context, metrics, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { resolveOptions } from '../src/telemetry.js';

// 1. Install global providers BEFORE the code under test asks for a tracer or meter.
const spanExporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
tracerProvider.register(); // also installs AsyncLocalStorage context + W3C propagators

const metricReader = new PeriodicExportingMetricReader({
  exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
  exportIntervalMillis: 60_000,
});
const meterProvider = new MeterProvider({ readers: [metricReader] });
metrics.setGlobalMeterProvider(meterProvider);

const logExporter = new InMemoryLogRecordExporter();
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
});
logs.setGlobalLoggerProvider(loggerProvider);

// 2. Import the instrumented modules only after the globals exist.
const { checkout, injectTraceHeaders } = await import('../src/orders.js');
const { createApp } = await import('../src/app.js');

const validOrder = {
  customerId: 'cust-42',
  lines: [
    { sku: 'book', quantity: 2, unitPrice: 12.5 },
    { sku: 'pen', quantity: 3, unitPrice: 1.2 },
  ],
};

async function counterValue(result: string): Promise<number> {
  const { resourceMetrics } = await metricReader.collect();
  const metric = resourceMetrics.scopeMetrics
    .flatMap((s) => s.metrics)
    .find((m) => m.descriptor.name === 'orders.placed');
  const point = metric?.dataPoints.find((p) => p.attributes['checkout.result'] === result);
  return (point?.value as number | undefined) ?? 0;
}

describe('checkout instrumentation', () => {
  beforeEach(() => {
    spanExporter.reset();
    logExporter.reset();
  });

  after(async () => {
    await Promise.all([
      tracerProvider.shutdown(),
      meterProvider.shutdown(),
      loggerProvider.shutdown(),
    ]);
  });

  it('builds a parent span with two children in the same trace', async () => {
    const receipt = await checkout(validOrder);
    assert.equal(receipt.total, 28.6);

    const spans = spanExporter.getFinishedSpans();
    const root = spans.find((s) => s.name === 'checkout');
    assert.ok(root, 'checkout span exported');
    assert.equal(root.attributes['customer.id'], 'cust-42');
    assert.equal(root.attributes['order.line_count'], 2);
    assert.equal(receipt.traceId, root.spanContext().traceId);

    for (const name of ['price_order', 'reserve_inventory']) {
      const child = spans.find((s) => s.name === name);
      assert.ok(child, `${name} span exported`);
      assert.equal(child.spanContext().traceId, root.spanContext().traceId);
      assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId);
    }

    const inventory = spans.find((s) => s.name === 'reserve_inventory');
    assert.equal(inventory?.events.filter((e) => e.name === 'inventory.reserved').length, 2);
  });

  it('marks the span as an error, records the exception and emits a correlated log', async () => {
    await assert.rejects(checkout({ customerId: 'cust-1', lines: [] }), /at least one line/);

    const root = spanExporter.getFinishedSpans().find((s) => s.name === 'checkout');
    assert.equal(root?.status.code, SpanStatusCode.ERROR);
    assert.ok(root?.events.some((e) => e.name === 'exception'));

    const [record] = logExporter.getFinishedLogRecords();
    assert.ok(record, 'error log exported');
    assert.equal(record.severityText, 'ERROR');
    assert.equal(record.spanContext?.traceId, root?.spanContext().traceId);
  });

  it('copies tenant.id from baggage onto the span', async () => {
    const bag = propagation.createBaggage({ 'tenant.id': { value: 'acme' } });
    await context.with(propagation.setBaggage(context.active(), bag), () => checkout(validOrder));

    const root = spanExporter.getFinishedSpans().find((s) => s.name === 'checkout');
    assert.equal(root?.attributes['tenant.id'], 'acme');
  });

  it('injects a W3C traceparent header for the active span', () => {
    trace.getTracer('test').startActiveSpan('outbound', (span) => {
      const headers = injectTraceHeaders();
      const { traceId, spanId } = span.spanContext();
      assert.equal(headers.traceparent, `00-${traceId}-${spanId}-01`);
      span.end();
    });
  });

  it('counts successful and failed checkouts', async () => {
    const okBefore = await counterValue('success');
    const failBefore = await counterValue('failure');
    await checkout(validOrder);
    await checkout({ customerId: '', lines: [] }).catch(() => undefined);
    assert.equal(await counterValue('success'), okBefore + 1);
    assert.equal(await counterValue('failure'), failBefore + 1);
  });
});

describe('http layer', () => {
  it('serves /health and /checkout', async () => {
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);

      const created = await fetch(`${base}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validOrder),
      });
      assert.equal(created.status, 201);

      const bad = await fetch(`${base}/checkout`, { method: 'POST', body: '{}' });
      assert.equal(bad.status, 400);
    } finally {
      server.close();
    }
  });
});

describe('resolveOptions', () => {
  it('uses sensible defaults', () => {
    const opts = resolveOptions({});
    assert.equal(opts.serviceName, 'checkout-service');
    assert.equal(opts.endpoint, 'http://localhost:4318');
    assert.equal(opts.sampleRatio, 1);
  });

  it('reads the environment and clamps bad values', () => {
    const opts = resolveOptions({
      OTEL_SERVICE_NAME: 'payments',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/',
      OTEL_SAMPLE_RATIO: '7',
      OTEL_METRIC_EXPORT_INTERVAL: 'abc',
    });
    assert.equal(opts.serviceName, 'payments');
    assert.equal(opts.endpoint, 'http://collector:4318');
    assert.equal(opts.sampleRatio, 1);
    assert.equal(opts.metricIntervalMs, 10000);
  });
});
