// The proxy over HTTP, on 127.0.0.1 with port 0. No network beyond loopback and no real Anthropic call:
// the live path uses a fake client. ANTHROPIC_API_KEY is unset for the whole file.
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUDGET_NOTICE, DEFAULT_MODEL, FIXED, MOCK_BADGE, MOCK_OFF_SCRIPT, TOOL } from '@baton/contract';
import type { TurnResponse } from '@baton/contract';
import type { ProxyConfig } from '../src/config.ts';
import type { LiveClient, LiveMessage } from '../src/live.ts';
import { LIVE_FAILED_NOTICE, startProxy, type ProxyApp } from '../src/server.ts';

delete process.env.ANTHROPIC_API_KEY;

const TOKEN = 'test-token-not-a-secret';
const ORIGIN = 'http://127.0.0.1:5173';
const SCRIPTS = new URL('../../recorded_responses/', import.meta.url).pathname;
const FAKE_KEY = 'test-key-not-real';

let dir: string;
let apps: ProxyApp[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'baton-proxy-test-'));
});
afterAll(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

function cfg(over: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 0,
    token: TOKEN,
    allowedOrigins: [ORIGIN],
    apiKey: '',
    model: DEFAULT_MODEL,
    fixture: 'june',
    scriptsDir: SCRIPTS,
    budget: { file: join(dir, `usage-${Math.random().toString(36).slice(2)}.json`), dayCap: 1, monthCap: 8 },
    ...over,
  };
}

async function boot(over: Partial<ProxyConfig> = {}, opts: Parameters<typeof startProxy>[1] = {}): Promise<ProxyApp> {
  const app = await startProxy(cfg(over), opts);
  apps.push(app);
  return app;
}

type Res = { status: number; body: any };
function request(app: ProxyApp, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}): Promise<Res> {
  const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  return new Promise((resolve, reject) => {
    const u = new URL(app.url);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        agent: false,
        headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const turn = (line: string, extra: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', content: line }],
  tools: [{ name: TOOL.todayView, description: 'Today', inputSchema: { type: 'object', properties: {} } }],
  context: { memberId: 'sam', now: '2026-10-20T08:00:00' },
  ...extra,
});

function fakeClient(message: LiveMessage | Error, calls: unknown[]): LiveClient {
  return {
    messages: {
      stream(params: unknown) {
        calls.push(params);
        return {
          finalMessage: async () => {
            if (message instanceof Error) throw message;
            return message;
          },
        };
      },
    },
  };
}

describe('access rules', () => {
  let app: ProxyApp;
  beforeAll(async () => {
    app = await boot();
  });

  it('answers 403 to a foreign Origin', async () => {
    const r = await request(app, 'POST', '/turn', { headers: { ...auth, Origin: 'https://evil.example' }, body: turn('Show me today') });
    expect(r.status).toBe(403);
  });

  it('answers 403 to a foreign Origin on healthz too', async () => {
    const r = await request(app, 'GET', '/healthz', { headers: { Origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
  });

  it('answers 401 without the bearer token', async () => {
    const r = await request(app, 'POST', '/turn', { body: turn('Show me today') });
    expect(r.status).toBe(401);
  });

  it('answers 401 with the wrong token', async () => {
    const r = await request(app, 'POST', '/turn', { headers: { Authorization: 'Bearer nope' }, body: turn('Show me today') });
    expect(r.status).toBe(401);
  });

  it('echoes an allowed Origin in CORS', async () => {
    const r = await request(app, 'POST', '/turn', { headers: { ...auth, Origin: ORIGIN }, body: turn('Show me today') });
    expect(r.status).toBe(200);
  });
});

describe('healthz', () => {
  it('reports mode and budget without anything about the key', async () => {
    const app = await boot({ apiKey: FAKE_KEY }, { clientFactory: () => fakeClient(new Error('unused'), []) });
    const r = await request(app, 'GET', '/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: 'live', budget: { dayUsd: 0, monthUsd: 0, dayCap: 1, monthCap: 8 } });
    expect(JSON.stringify(r.body)).not.toContain(FAKE_KEY);
  });

  it('reports mock without a key', async () => {
    const app = await boot();
    const r = await request(app, 'GET', '/healthz');
    expect(r.body.mode).toBe('mock');
  });
});

describe('POST /turn input', () => {
  it('answers 400 for a body that is not JSON', async () => {
    const app = await boot();
    const r = await request(app, 'POST', '/turn', { headers: auth, raw: '{nope' });
    expect(r.status).toBe(400);
  });

  it('answers 400 for a body that is not a turn', async () => {
    const app = await boot();
    const r = await request(app, 'POST', '/turn', { headers: auth, body: { messages: [] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Bad turn request/);
  });
});

describe('mock mode without a key', () => {
  it('answers a scripted line with a tool step and the mock badge', async () => {
    const app = await boot();
    const r = await request(app, 'POST', '/turn', { headers: auth, body: turn('Show me today') });
    const body = r.body as TurnResponse;
    expect(body).toMatchObject({ mode: 'mock', badge: MOCK_BADGE, script: 'demo', stop_reason: 'tool_use' });
    expect(body.notice).toBeUndefined();
    expect(body.content[0]).toMatchObject({ type: 'tool_use', name: TOOL.todayView });
  });

  it('answers an unknown line with the off-script text', async () => {
    const app = await boot();
    const r = await request(app, 'POST', '/turn', { headers: auth, body: turn('What is the weather?') });
    expect(r.body.content).toEqual([{ type: 'text', text: MOCK_OFF_SCRIPT }]);
  });

  it('answers an emergency line with the fixed sentence and no model call', async () => {
    const calls: unknown[] = [];
    const app = await boot({ apiKey: FAKE_KEY }, { clientFactory: () => fakeClient(new Error('must not run'), calls) });
    const r = await request(app, 'POST', '/turn', { headers: auth, body: turn('She fell and hit her head') });
    expect(r.body.content).toEqual([{ type: 'text', text: FIXED.emergency }]);
    expect(r.body.stop_reason).toBe('end_turn');
    expect(calls).toHaveLength(0);
  });
});

describe('live mode', () => {
  it('answers with a budget notice when the caps are zero, and does not call the model', async () => {
    const calls: unknown[] = [];
    const app = await boot(
      { apiKey: FAKE_KEY, budget: { file: join(dir, 'caps-zero.json'), dayCap: 0, monthCap: 0 } },
      { clientFactory: () => fakeClient(new Error('must not run'), calls) },
    );
    const r = await request(app, 'POST', '/turn', { headers: auth, body: turn('Show me today') });
    expect(r.body).toMatchObject({ mode: 'mock', badge: MOCK_BADGE, notice: BUDGET_NOTICE, script: 'demo' });
    expect(calls).toHaveLength(0);
  });

  it('runs the guardrail on text and records usage on a live turn', async () => {
    const file = join(dir, 'live-usage.json');
    const calls: { model: string; max_tokens: number; tool_choice: unknown }[] = [];
    const message: LiveMessage = {
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 100 },
      content: [{ type: 'text', text: "It's probably the new pill." }],
    };
    const client: LiveClient = {
      messages: {
        stream(params: unknown) {
          calls.push(params as (typeof calls)[number]);
          return { finalMessage: async () => message };
        },
      },
    };
    const app = await boot(
      { apiKey: FAKE_KEY, budget: { file, dayCap: 1, monthCap: 8 } },
      { clientFactory: () => client },
    );
    const r = await request(app, 'POST', '/turn', { headers: auth, body: turn('Is the dizziness from the new pill?') });
    expect(r.body).toEqual({
      mode: 'live',
      content: [{ type: 'text', text: FIXED.symptomQuestion('Dr. Lee') }],
      stop_reason: 'end_turn',
      guarded: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe(DEFAULT_MODEL);
    expect(calls[0]!.max_tokens).toBe(400);
    expect(calls[0]!.tool_choice).toEqual({ type: 'auto' });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.dayUsd).toBeCloseTo(0.00015, 10);
    expect(saved.monthUsd).toBeCloseTo(0.00015, 10);
    const h = await request(app, 'GET', '/healthz');
    expect(h.body.budget.dayUsd).toBeCloseTo(0.00015, 10);
  });

  it('passes tool_use blocks through for the browser to run', async () => {
    const message: LiveMessage = {
      stop_reason: 'tool_use',
      usage: { input_tokens: 500, output_tokens: 50 },
      content: [{ type: 'tool_use', id: 'toolu_1', name: TOOL.todayView, input: { date: '2026-10-20' } }],
    };
    const app = await boot({ apiKey: FAKE_KEY }, { clientFactory: () => fakeClient(message, []) });
    const r = await request(app, 'POST', '/turn', { headers: auth, body: turn('What is on today?') });
    expect(r.body.stop_reason).toBe('tool_use');
    expect(r.body.content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: TOOL.todayView, input: { date: '2026-10-20' } }]);
  });

  it('falls back to recorded responses with a notice when the live call throws', async () => {
    const app = await boot({ apiKey: FAKE_KEY }, { clientFactory: () => fakeClient(new Error('network down'), []) });
    const r = await request(app, 'POST', '/turn', { headers: auth, body: turn('Show me today') });
    expect(r.body).toMatchObject({ mode: 'mock', notice: LIVE_FAILED_NOTICE, script: 'demo' });
  });
});
