// HTTP for the assistant: /healthz and POST /turn on 127.0.0.1. Same Origin, CORS and bearer rules as the Baton server.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  BUDGET_NOTICE, FIXED, MOCK_BADGE, TurnRequest, TurnResponse, loadFixture,
} from '@baton/contract';
import type { Fixture } from '@baton/contract';
import { Budget } from './budget.ts';
import type { ProxyConfig } from './config.ts';
import { emergency } from './guardrail.ts';
import { type ClientFactory, type LiveClient, makeLiveClient, runLive } from './live.ts';
import { latestUserText, loadScripts, mockTurn, type LoadedScript } from './mock.ts';

// Strings the host shows. Their values live in contract/src/proxy.ts; this is where the proxy uses them:
// badge "Recorded response (mock)", off-script "This line isn't in the recorded script. Live mode needs an Anthropic API key.",
// notice "Live budget reached, recorded responses only".
const MAX_BODY = 1_000_000;
export const LIVE_FAILED_NOTICE = 'Live call failed, recorded responses only';

export type ProxyOptions = {
  /** Test hook: builds the live client from the key. Production uses the Anthropic SDK. */
  clientFactory?: ClientFactory;
  /** Test hook for the budget's day and month. Production uses the real clock. */
  clock?: () => Date;
};

export type ProxyApp = { http: http.Server; url: string; budget: Budget; close(): Promise<void> };

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

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

export type ProxyHandler = {
  budget: Budget;
  live: boolean;
  /** Answers /healthz and /turn; any other path gets 404. */
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
};

/** The proxy's request handler without a listening socket, for a process that serves more than the proxy. */
export function proxyHandler(cfg: ProxyConfig, opts: ProxyOptions = {}): ProxyHandler {
  const fx: Fixture = loadFixture(cfg.fixture);
  const scripts: LoadedScript[] = loadScripts(cfg.scriptsDir);
  const client: LiveClient | undefined = makeLiveClient(cfg.apiKey, opts.clientFactory);
  const budget = new Budget({ file: cfg.budget.file, dayCap: cfg.budget.dayCap, monthCap: cfg.budget.monthCap, clock: opts.clock });
  const allowed = new Set(cfg.allowedOrigins);

  async function answer(req: TurnRequest): Promise<TurnResponse> {
    if (emergency(latestUserText(req.messages))) {
      // A fixed sentence, no model. Shown with the mock badge because no live reply was produced.
      return { mode: 'mock', badge: MOCK_BADGE, content: [{ type: 'text', text: FIXED.emergency }], stop_reason: 'end_turn' };
    }
    const mock = (notice?: string): TurnResponse => ({ ...mockTurn(req, scripts), ...(notice ? { notice } : {}) });
    if (!client) return mock();
    if (!budget.canSpend()) return mock(BUDGET_NOTICE);
    try {
      return await runLive(req, { client, model: cfg.model, fx, budget });
    } catch (e) {
      // Log the error class only: SDK messages can echo request details.
      console.error(`live call failed: ${(e as Error).name}`);
      return mock(LIVE_FAILED_NOTICE);
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!allowed.has(origin)) return sendJson(res, 403, { error: 'Origin not allowed' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    if (url.pathname === '/healthz' && req.method === 'GET') {
      const s = budget.snapshot();
      return sendJson(res, 200, {
        ok: true,
        mode: client ? 'live' : 'mock',
        budget: { dayUsd: s.dayUsd, monthUsd: s.monthUsd, ...budget.caps() },
      });
    }
    if (url.pathname !== '/turn') return sendJson(res, 404, { error: 'Not found' });
    if (!tokenOk(req.headers.authorization, cfg.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendJson(res, 401, { error: 'Missing or wrong bearer token' });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
    const parsed = TurnRequest.safeParse(await readJson(req));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return sendJson(res, 400, { error: `Bad turn request at ${first?.path.join('.') || 'body'}: ${first?.message ?? 'invalid'}` });
    }
    return sendJson(res, 200, await answer(parsed.data));
  }

  return { budget, live: Boolean(client), handle };
}

/** Starts the assistant proxy on 127.0.0.1. Live mode needs a key; otherwise every turn is mock. */
export async function startProxy(cfg: ProxyConfig, opts: ProxyOptions = {}): Promise<ProxyApp> {
  const { budget, handle } = proxyHandler(cfg, opts);
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Internal error' });
      else res.end();
      if (!(e instanceof HttpError)) console.error('proxy error');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    http: server,
    url: `http://127.0.0.1:${port}`,
    budget,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
