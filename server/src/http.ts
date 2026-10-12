// HTTP layer: /healthz, /clock and the Streamable HTTP MCP endpoint, with origin, token and
// protocol-version checks in front. Binds to 127.0.0.1 only.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SUPPORTED_PROTOCOL_VERSIONS, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  RESOURCE, SimClock, dateOf, defaultStart, loadFixture, shiftsStartedBetween, windowsClosedBetween,
} from '@baton/contract';
import type { Config } from './config.ts';
import { Hub } from './hub.ts';
import { makeServer, type Ctx } from './mcp.ts';
import { Store } from './store.ts';

const MAX_BODY = 1_000_000;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function rpcError(res: http.ServerResponse, status: number, message: string, code = -32000): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!token) return true;
  const want = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? '');
  return got.length === want.length && timingSafeEqual(got, want);
}

export type App = { http: http.Server; ctx: Ctx; url: string; close(): Promise<void> };

/** Builds the store, clock and HTTP server and starts listening on 127.0.0.1. */
export async function startApp(cfg: Config): Promise<App> {
  const fx = loadFixture(cfg.fixture);
  const store = new Store(cfg.db);
  store.seed(fx);
  const clock = new SimClock(cfg.now ?? defaultStart(fx.today));
  const hub = new Hub();
  const ctx: Ctx = { fx, store, clock, hub };

  clock.onChange((now, previous) => {
    const uris = new Set<string>();
    if (windowsClosedBetween(fx.windows, previous, now).length) uris.add(RESOURCE.windowsToday);
    if (shiftsStartedBetween(fx.members, previous, now).length) uris.add(RESOURCE.shifts);
    // A new day or a jump back in time changes what "today" holds.
    if (dateOf(now) !== dateOf(previous) || now < previous) {
      uris.add(RESOURCE.ledgerToday).add(RESOURCE.windowsToday).add(RESOURCE.shifts);
    }
    if (uris.size) void hub.notify(...uris);
  });

  const allowed = new Set(cfg.allowedOrigins);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!allowed.has(origin)) return sendJson(res, 403, { error: 'Origin not allowed' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname !== '/clock' && url.pathname !== '/mcp') return sendJson(res, 404, { error: 'Not found' });
    if (!tokenOk(req.headers.authorization, cfg.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendJson(res, 401, { error: 'Missing or wrong bearer token' });
    }

    if (url.pathname === '/clock') {
      if (req.method === 'GET') return sendJson(res, 200, { now: clock.now() });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use GET or POST' });
      const body = (await readJson(req)) as { set?: unknown; advanceMinutes?: unknown } | undefined;
      try {
        if (typeof body?.set === 'string') clock.set(body.set);
        else if (typeof body?.advanceMinutes === 'number') clock.advance(body.advanceMinutes);
        else return sendJson(res, 400, { error: 'Send {"set":"<iso>"} or {"advanceMinutes":n}' });
      } catch (e) {
        return sendJson(res, 400, { error: (e as Error).message });
      }
      return sendJson(res, 200, { now: clock.now() });
    }

    // /mcp
    const version = req.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      return rpcError(res, 400, `Unsupported MCP-Protocol-Version: ${version}`);
    }
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') {
      const s = hub.sessions.get(sid);
      if (!s) return rpcError(res, 404, 'Session not found', -32001);
      return s.transport.handleRequest(req, res, body);
    }
    if (req.method === 'POST' && isInitializeRequest(body)) {
      const subs = new Set<string>();
      const server = makeServer(ctx, subs);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => hub.add({ id, server, transport, subs }),
      });
      transport.onclose = () => {
        if (transport.sessionId) hub.remove(transport.sessionId);
      };
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }
    return rpcError(res, 400, 'No valid session. Send initialize first.');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Internal error' });
      else res.end();
      if (!(e instanceof HttpError)) console.error(e);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    http: server,
    ctx,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}
