// Business logic with manual instrumentation layered on top of auto-instrumentation.
import {
  context,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const SCOPE = 'learn-opentelemetry.orders';
const SCOPE_VERSION = '1.0.0';

const tracer = trace.getTracer(SCOPE, SCOPE_VERSION);
const meter = metrics.getMeter(SCOPE, SCOPE_VERSION);
const logger = logs.getLogger(SCOPE, SCOPE_VERSION);

const ordersPlaced = meter.createCounter('orders.placed', {
  description: 'Checkout attempts, split by result',
  unit: '{order}',
});
const orderValue = meter.createHistogram('orders.value', {
  description: 'Order total per successful checkout',
  unit: 'USD',
});

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderRequest {
  customerId: string;
  lines: OrderLine[];
}

export interface OrderReceipt {
  orderId: string;
  total: number;
  traceId: string;
}

export class ValidationError extends Error {
  override name = 'ValidationError';
}

function validate(order: OrderRequest): void {
  if (!order || !order.customerId) throw new ValidationError('customerId is required');
  if (!Array.isArray(order.lines) || order.lines.length === 0) {
    throw new ValidationError('order must contain at least one line');
  }
  for (const line of order.lines) {
    if (!(line.quantity > 0) || !(line.unitPrice >= 0)) {
      throw new ValidationError(`invalid line for sku ${line.sku}`);
    }
  }
}

async function priceOrder(order: OrderRequest): Promise<number> {
  return tracer.startActiveSpan('price_order', async (span: Span) => {
    try {
      const total = order.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
      const rounded = Math.round(total * 100) / 100;
      span.setAttribute('order.total', rounded);
      return rounded;
    } finally {
      span.end();
    }
  });
}

async function reserveInventory(order: OrderRequest): Promise<void> {
  return tracer.startActiveSpan('reserve_inventory', async (span: Span) => {
    try {
      for (const line of order.lines) {
        // Span events mark a point in time inside a span without creating a child span.
        span.addEvent('inventory.reserved', { 'product.sku': line.sku, quantity: line.quantity });
      }
    } finally {
      span.end();
    }
  });
}

export async function checkout(order: OrderRequest): Promise<OrderReceipt> {
  return tracer.startActiveSpan(
    'checkout',
    { kind: SpanKind.INTERNAL, attributes: { 'customer.id': order?.customerId ?? 'unknown' } },
    async (span: Span) => {
      // Baggage travels with the request; copy only the entries you want to query on.
      const tenant = propagation.getActiveBaggage()?.getEntry('tenant.id')?.value;
      if (tenant) span.setAttribute('tenant.id', tenant);

      try {
        validate(order);
        span.setAttribute('order.line_count', order.lines.length);
        const total = await priceOrder(order);
        await reserveInventory(order);

        ordersPlaced.add(1, { 'checkout.result': 'success' });
        orderValue.record(total);

        const orderId = `ord_${span.spanContext().spanId}`;
        span.setAttribute('order.id', orderId);
        return { orderId, total, traceId: span.spanContext().traceId };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        ordersPlaced.add(1, { 'checkout.result': 'failure', 'error.type': error.name });
        // Emitted while the span is active, so the record carries its trace_id and span_id.
        logger.emit({
          severityNumber: SeverityNumber.ERROR,
          severityText: 'ERROR',
          body: `checkout failed: ${error.message}`,
          attributes: { 'error.type': error.name },
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Writes W3C `traceparent`, `tracestate` and `baggage` headers for the active context. */
export function injectTraceHeaders(carrier: Record<string, string> = {}): Record<string, string> {
  propagation.inject(context.active(), carrier);
  return carrier;
}
