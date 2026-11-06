// Streamable HTTP mode, for hosting the server (stateless: one MCP server per request). Each
// caller authenticates with their own AIVeed API key; the host never holds one, so a hosted
// instance cannot spend anyone else's credits. upload_media is not offered here: it would read
// the host's own disk.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AiveedClient, isApiKey } from './client.js';
import { createServer, VERSION } from './server.js';

const MAX_BODY_BYTES = 1024 * 1024;
// Requests in flight at once; more get 503. A syntactically valid key is all a caller needs to
// reach this point, so this (plus a rate limit at the proxy) bounds what one host spends.
const MAX_IN_FLIGHT = 64;
const CORS_HEADERS = 'Authorization, X-API-Key, Content-Type, Accept, Mcp-Protocol-Version';

export interface HttpOptions {
  host: string;
  port: number;
  baseUrl?: string;
  /** Host header values (hostname only) accepted; guards against DNS rebinding. */
  allowedHosts: string[];
  /** Browser origins allowed to call; requests without Origin (non-browser clients) are allowed. */
  allowedOrigins: string[];
  /** Override for tests. */
  maxInFlight?: number;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (message: string) => ({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

function bearerKey(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-api-key'];
  return typeof header === 'string' ? header.trim() : undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

export function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase();
  return hostHeader.split(':')[0].toLowerCase();
}

export function startHttp(opts: HttpOptions) {
  const maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
  let inFlight = 0;
  const httpServer = createHttpServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    // The Host check stops DNS rebinding (a web page reaching a local server through its own
    // domain). It is not access control: anyone who can reach the port can send any Host.
    if (!opts.allowedHosts.includes(hostnameOf(req.headers.host))) return send(res, 403, rpcError('Host not allowed'));
    const origin = req.headers.origin;
    if (origin && !opts.allowedOrigins.includes(origin)) return send(res, 403, rpcError('Origin not allowed'));
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    if (path === '/health' && req.method === 'GET') return send(res, 200, { ok: true, version: VERSION });
    if (path !== '/mcp') return send(res, 404, rpcError('Not found'));
    if (req.method === 'OPTIONS' && origin) {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': CORS_HEADERS, 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    // Stateless: no sessions, so no GET stream and no DELETE.
    if (req.method !== 'POST') return send(res, 405, rpcError('Method not allowed'), { Allow: 'POST' });

    const apiKey = bearerKey(req);
    if (!isApiKey(apiKey)) {
      return send(res, 401, rpcError('Send your AIVeed API key as Authorization: Bearer aiv_sk_...'), {
        'WWW-Authenticate': 'Bearer realm="aiveed"',
      });
    }

    if (inFlight >= maxInFlight) return send(res, 503, rpcError('Server busy, retry shortly'), { 'Retry-After': '5' });
    // The slot is held until this request's work has finished, not just until the caller hangs up;
    // hanging up aborts the work's upstream requests, so the slot frees promptly either way.
    inFlight++;
    const abort = new AbortController();
    const closed = new Promise<void>((resolve) => res.on('close', () => {
      abort.abort();
      resolve();
    }));
    try {
      // Both: the handler may return before the response is written, and the caller may hang up
      // before the handler has finished.
      await Promise.all([handle(req, res, apiKey, abort.signal).catch(() => {}), closed]);
    } finally {
      inFlight--;
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse, apiKey: string, signal: AbortSignal) {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return send(res, err.status || 400, rpcError(err.message));
    }
    // One JSON-RPC message per request: a batch would run many tool calls under one slot.
    if (Array.isArray(body)) return send(res, 400, rpcError('Batch requests are not supported; send one message per request'));

    const client = new AiveedClient({ apiKey, baseUrl: opts.baseUrl, userAgent: `aiveed-mcp/${VERSION} (http)`, signal });
    const server = createServer(client, { localFiles: false });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) send(res, 500, rpcError('Internal error'));
    }
  }
  // A slow client cannot hold a connection open indefinitely; tool calls finish well inside this.
  httpServer.headersTimeout = 15_000;
  httpServer.requestTimeout = 90_000;
  httpServer.listen(opts.port, opts.host);
  return httpServer;
}
