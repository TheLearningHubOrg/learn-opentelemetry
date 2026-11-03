// Minimal HTTP layer. The http auto-instrumentation creates the SERVER span;
// handlers only enrich it with the route template.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { trace } from '@opentelemetry/api';
import { ATTR_HTTP_ROUTE } from '@opentelemetry/semantic-conventions';
import { checkout, ValidationError, type OrderRequest } from './orders.js';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function createApp(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        trace.getActiveSpan()?.setAttribute(ATTR_HTTP_ROUTE, '/health');
        return send(res, 200, { status: 'ok' });
      }
      if (req.method === 'POST' && url.pathname === '/checkout') {
        trace.getActiveSpan()?.setAttribute(ATTR_HTTP_ROUTE, '/checkout');
        const receipt = await checkout((await readJson(req)) as OrderRequest);
        return send(res, 201, receipt);
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: err.message });
      if (err instanceof SyntaxError) return send(res, 400, { error: 'invalid JSON body' });
      return send(res, 500, { error: 'internal error' });
    }
  });
}
