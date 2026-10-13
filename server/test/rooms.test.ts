import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE } from '@baton/contract';
import { listen, sendJson } from '../src/http.ts';
import { ROOM_DEFAULTS, roomsHandler, type RoomsConfig } from '../src/rooms.ts';
import { call, waitFor } from './helpers.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const A = 'aaaaaaaaaaaa1111';
const B = 'bbbbbbbbbbbb2222';

type Started = { url: string; rooms: ReturnType<typeof roomsHandler>['rooms']; tick(ms: number): void; close(): Promise<void> };
const open: Started[] = [];
const clients: Client[] = [];

async function start(over: Partial<RoomsConfig> = {}): Promise<Started> {
  let now = 1_000_000;
  const h = roomsHandler({ ...ROOM_DEFAULTS, port: 0, fixture: 'june', now: '2026-10-20T08:00:00', allowedOrigins: [ORIGIN], ...over }, () => now);
  const { server, url } = await listen(0, async (req, res) => {
    if (!(await h.handle(req, res))) sendJson(res, 404, { error: 'Not found' });
  });
  const s: Started = {
    url,
    rooms: h.rooms,
    tick: (ms) => {
      now += ms;
    },
    async close() {
      await h.rooms.closeAll();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  open.push(s);
  return s;
}

async function connect(s: Started, room: string, ip = '10.0.0.1'): Promise<Client & { updates: string[] }> {
  const c = new Client({ name: 'room-test', version: '0.0.1' }, { capabilities: {} }) as Client & { updates: string[] };
  c.updates = [];
  c.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
    c.updates.push(n.params.uri);
  });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/r/${room}/mcp`), { requestInit: { headers: { 'X-Real-IP': ip } } }));
  clients.push(c);
  return c;
}

const logMetformin = (c: Client, requestId: string) =>
  call(c, 'log_care_event', { memberId: 'sam', items: ['metformin'], heardText: 'gave her the metformin', requestId });

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe('demo rooms', () => {
  it('keeps each room a household of its own', async () => {
    const s = await start();
    const a = await connect(s, A);
    const b = await connect(s, B);
    expect((await logMetformin(a, 'r1')).sc.written).toBe(true);
    expect((await call(a, 'check_med', { medId: 'metformin' })).sc.status).toBe('given');
    expect((await call(b, 'check_med', { medId: 'metformin' })).sc.status).toBe('not_logged');
    expect(s.rooms.size).toBe(2);
  });

  it('shares one household between two sessions in the same room, with notifications', async () => {
    const s = await start();
    const kitchen = await connect(s, A);
    const phone = await connect(s, A);
    await phone.subscribeResource({ uri: RESOURCE.ledgerToday });
    await logMetformin(kitchen, 'r1');
    expect(await waitFor(() => phone.updates.includes(RESOURCE.ledgerToday))).toBe(true);
    expect((await call(phone, 'check_med', { medId: 'metformin' })).sc.status).toBe('given');
    expect(s.rooms.size).toBe(1);
  });

  it('moves the clock of one room only', async () => {
    const s = await start();
    await connect(s, A);
    await connect(s, B);
    const post = await fetch(`${s.url}/r/${A}/clock`, { method: 'POST', body: JSON.stringify({ advanceMinutes: 60 }) });
    expect(((await post.json()) as { now: string }).now).toBe('2026-10-20T09:00:00');
    const other = await fetch(`${s.url}/r/${B}/clock`);
    expect(((await other.json()) as { now: string }).now).toBe('2026-10-20T08:00:00');
  });

  it('closes a room nobody has used for idleMs, and starts it fresh on the next visit', async () => {
    const s = await start({ idleMs: 60_000 });
    const a = await connect(s, A);
    await logMetformin(a, 'r1');
    s.tick(30_000);
    expect(await s.rooms.sweep(1_000_000 + 30_000)).toBe(0);
    expect(await s.rooms.sweep(1_000_000 + 120_000)).toBe(1);
    expect(s.rooms.size).toBe(0);
    s.tick(120_000);
    const again = await connect(s, A);
    expect((await call(again, 'check_med', { medId: 'metformin' })).sc.status).toBe('not_logged');
  });

  it('turns new visitors away when every room is taken', async () => {
    const s = await start({ maxRooms: 1 });
    await connect(s, A);
    const r = await fetch(`${s.url}/r/${B}/clock`);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('300');
    expect((await fetch(`${s.url}/r/${A}/clock`)).status).toBe(200);
  });

  it('limits new rooms and requests per client address', async () => {
    const s = await start({ newRoomsPerHour: 1, perMinute: 3 });
    const hdr = (ip: string) => ({ headers: { 'X-Real-IP': ip } });
    expect((await fetch(`${s.url}/r/${A}/clock`, hdr('10.0.0.1'))).status).toBe(200);
    expect((await fetch(`${s.url}/r/${B}/clock`, hdr('10.0.0.1'))).status).toBe(429);
    expect((await fetch(`${s.url}/r/${B}/clock`, hdr('10.0.0.2'))).status).toBe(200);
    expect((await fetch(`${s.url}/r/${A}/clock`, hdr('10.0.0.1'))).status).toBe(200);
    expect((await fetch(`${s.url}/r/${A}/clock`, hdr('10.0.0.1'))).status).toBe(429);
    s.tick(60_000);
    expect((await fetch(`${s.url}/r/${A}/clock`, hdr('10.0.0.1'))).status).toBe(200);
  });

  it('keeps at most maxSessions in a room, dropping the oldest', async () => {
    const s = await start({ maxSessions: 2 });
    const first = await connect(s, A);
    await connect(s, A);
    const third = await connect(s, A);
    expect((await call(third, 'check_med', { medId: 'metformin' })).sc.status).toBe('not_logged');
    await expect(first.listTools()).rejects.toThrow();
  });

  it('rejects bad room ids, other paths, foreign origins and large bodies', async () => {
    const s = await start({ maxBody: 1024 });
    expect((await fetch(`${s.url}/r/NOT-A-ROOM/clock`)).status).toBe(404);
    expect((await fetch(`${s.url}/r/short/clock`)).status).toBe(404);
    expect((await fetch(`${s.url}/mcp`)).status).toBe(404);
    expect((await fetch(`${s.url}/r/${A}/clock`, { headers: { Origin: 'https://example.com' } })).status).toBe(403);
    const big = await fetch(`${s.url}/r/${A}/clock`, { method: 'POST', body: JSON.stringify({ set: 'x'.repeat(4096) }) });
    expect(big.status).toBe(413);
    const health = (await (await fetch(`${s.url}/healthz`)).json()) as { ok: boolean; rooms: number };
    expect(health.ok).toBe(true);
  });
});
