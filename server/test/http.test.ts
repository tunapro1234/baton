// Origin, token and protocol-version checks, /healthz and the simulated clock endpoint.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/http.ts';
import { TOKEN, connect, start } from './helpers.ts';

let app: App;
beforeAll(async () => {
  app = await start('2026-10-20T07:00:00');
});
afterAll(async () => {
  await app?.close();
});

const auth = { Authorization: `Bearer ${TOKEN}` };
const init = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};
const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

describe('http', () => {
  it('answers /healthz without a token', async () => {
    const r = await fetch(`${app.url}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('needs the bearer token for /mcp and /clock', async () => {
    expect((await fetch(`${app.url}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(init) })).status).toBe(401);
    expect((await fetch(`${app.url}/clock`)).status).toBe(401);
    expect((await fetch(`${app.url}/clock`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('refuses a foreign Origin and allows a listed one with CORS headers', async () => {
    const bad = await fetch(`${app.url}/mcp`, { method: 'POST', headers: { ...mcpHeaders, ...auth, Origin: 'http://evil.example' }, body: JSON.stringify(init) });
    expect(bad.status).toBe(403);
    const pre = await fetch(`${app.url}/mcp`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    const ok = await fetch(`${app.url}/mcp`, { method: 'POST', headers: { ...mcpHeaders, ...auth, Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify(init) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('mcp-session-id')).toBeTruthy();
    expect(ok.headers.get('access-control-expose-headers')).toMatch(/Mcp-Session-Id/);
    await ok.body?.cancel();
  });

  it('rejects an unsupported MCP-Protocol-Version with 400', async () => {
    const c = await connect(app, 'v');
    const r = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, ...auth, 'Mcp-Session-Id': c.sessionId!, 'MCP-Protocol-Version': '1999-01-01' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    expect(r.status).toBe(400);
    await c.close();
  });

  it('returns 404 for an unknown session', async () => {
    const r = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, ...auth, 'Mcp-Session-Id': 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    expect(r.status).toBe(404);
  });

  it('reads, sets and advances the simulated clock', async () => {
    const get = await fetch(`${app.url}/clock`, { headers: auth });
    expect(await get.json()).toEqual({ now: '2026-10-20T07:00:00' });
    const post = (body: unknown) =>
      fetch(`${app.url}/clock`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(await (await post({ advanceMinutes: 65 })).json()).toEqual({ now: '2026-10-20T08:05:00' });
    expect(await (await post({ set: '2026-10-20T19:00' })).json()).toEqual({ now: '2026-10-20T19:00:00' });
    expect((await post({ set: '2026-10-20T19:00:00Z' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });
});
