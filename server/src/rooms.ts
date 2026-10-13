// Public demo mode: every visitor gets a room, a fictional household of their own held in memory.
// Rooms live at /r/<id>/mcp and /r/<id>/clock. Two browser windows with the same room id share a
// household, which is how the sync demo works. Nothing is written to disk, and a room that nobody
// has used for a while is dropped with everything typed into it.
import type http from 'node:http';
import { answerCors, listen, openRoom, sendJson, serveRoom, type Room } from './http.ts';

export type RoomsConfig = {
  port: number;
  fixture: string;
  now?: string;
  allowedOrigins: string[];
  /** Rooms open at the same time. A new visitor past this gets 503. */
  maxRooms: number;
  /** A room with no request for this long is closed. */
  idleMs: number;
  /** MCP sessions in one room. A reloaded tab leaves its old session behind; the oldest goes first. */
  maxSessions: number;
  /** Request body limit in bytes. */
  maxBody: number;
  /** Requests per client address per minute, across all rooms. */
  perMinute: number;
  /** New rooms per client address per hour. */
  newRoomsPerHour: number;
};

export const ROOM_DEFAULTS = {
  maxRooms: 20,
  idleMs: 30 * 60_000,
  maxSessions: 8,
  maxBody: 64 * 1024,
  perMinute: 240,
  newRoomsPerHour: 10,
} satisfies Partial<RoomsConfig>;

const ROOM_ID = /^[a-z0-9]{12,32}$/;
const ROUTE = /^\/r\/([^/]+)\/(mcp|clock)$/;

type Entry = { room: Room; lastUsed: number };
type Counter = { start: number; count: number };

/** Fixed-window counter per key. */
class Limiter {
  private readonly counts = new Map<string, Counter>();
  private readonly windowMs: number;
  private readonly max: number;

  constructor(windowMs: number, max: number) {
    this.windowMs = windowMs;
    this.max = max;
  }

  /** Counts one hit; false when the key is over its limit for this window. */
  hit(key: string, now: number): boolean {
    let c = this.counts.get(key);
    if (!c || now - c.start >= this.windowMs) {
      c = { start: now, count: 0 };
      this.counts.set(key, c);
    }
    c.count++;
    return c.count <= this.max;
  }

  sweep(now: number): void {
    for (const [k, c] of this.counts) if (now - c.start >= this.windowMs) this.counts.delete(k);
  }
}

export class RoomSet {
  private readonly rooms = new Map<string, Entry>();
  private readonly perMinute: Limiter;
  private readonly newRooms: Limiter;
  private readonly cfg: RoomsConfig;

  constructor(cfg: RoomsConfig) {
    this.cfg = cfg;
    this.perMinute = new Limiter(60_000, cfg.perMinute);
    this.newRooms = new Limiter(3_600_000, cfg.newRoomsPerHour);
  }

  get size(): number {
    return this.rooms.size;
  }

  has(id: string): boolean {
    return this.rooms.has(id);
  }

  /** Request limit for one client address. */
  allow(client: string, now: number): boolean {
    return this.perMinute.hit(client, now);
  }

  /** The room with this id, opened on first use. A string says why there is none. */
  get(id: string, client: string, now: number): Room | 'full' | 'too-many-new' {
    const e = this.rooms.get(id);
    if (e) {
      e.lastUsed = now;
      return e.room;
    }
    if (this.rooms.size >= this.cfg.maxRooms) return 'full';
    if (!this.newRooms.hit(client, now)) return 'too-many-new';
    const room = openRoom(this.cfg, ':memory:');
    this.rooms.set(id, { room, lastUsed: now });
    return room;
  }

  /** Closes rooms idle for longer than idleMs. Returns how many were closed. */
  async sweep(now: number): Promise<number> {
    const old = [...this.rooms].filter(([, e]) => now - e.lastUsed > this.cfg.idleMs);
    for (const [id] of old) this.rooms.delete(id);
    await Promise.all(old.map(([, e]) => e.room.close().catch(() => undefined)));
    this.perMinute.sweep(now);
    this.newRooms.sweep(now);
    return old.length;
  }

  async closeAll(): Promise<void> {
    const all = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(all.map((e) => e.room.close().catch(() => undefined)));
  }
}

/** The client address. The demo listens on 127.0.0.1 behind a reverse proxy, which sets X-Real-IP. */
export function clientOf(req: http.IncomingMessage): string {
  const h = req.headers['x-real-ip'];
  return (typeof h === 'string' && h) || req.socket.remoteAddress || 'unknown';
}

export type RoomsHandler = {
  rooms: RoomSet;
  /** Answers /healthz and /r/<id>/(mcp|clock); returns false for any other path. */
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
};

export function roomsHandler(cfg: RoomsConfig, clock: () => number = Date.now): RoomsHandler {
  const rooms = new RoomSet(cfg);
  const allowed = new Set(cfg.allowedOrigins);
  const limits = { maxBody: cfg.maxBody, maxSessions: cfg.maxSessions };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true, rooms: rooms.size, maxRooms: cfg.maxRooms });
      return true;
    }
    const m = ROUTE.exec(path);
    if (!m) return false;
    if (answerCors(req, res, allowed)) return true;
    const now = clock();
    const client = clientOf(req);
    if (!rooms.allow(client, now)) {
      res.setHeader('Retry-After', '60');
      sendJson(res, 429, { error: 'Too many requests. Wait a minute and try again.' });
      return true;
    }
    const id = m[1]!;
    if (!ROOM_ID.test(id)) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    const room = rooms.get(id, client, now);
    if (room === 'full') {
      res.setHeader('Retry-After', '300');
      sendJson(res, 503, { error: 'The demo is full right now. Try again in a few minutes.' });
      return true;
    }
    if (room === 'too-many-new') {
      res.setHeader('Retry-After', '3600');
      sendJson(res, 429, { error: 'Too many new demo rooms from this address. Reuse the one you have.' });
      return true;
    }
    await serveRoom(room, m[2] as 'mcp' | 'clock', req, res, limits);
    return true;
  }

  return { rooms, handle };
}

export type RoomsApp = { http: http.Server; url: string; rooms: RoomSet; close(): Promise<void> };

/** Starts the rooms server alone on 127.0.0.1, with an idle sweep once a minute. */
export async function startRooms(cfg: RoomsConfig): Promise<RoomsApp> {
  const h = roomsHandler(cfg);
  const { server, url } = await listen(cfg.port, async (req, res) => {
    if (!(await h.handle(req, res))) sendJson(res, 404, { error: 'Not found' });
  });
  const timer = setInterval(() => void h.rooms.sweep(Date.now()), 60_000);
  timer.unref();
  return {
    http: server,
    url,
    rooms: h.rooms,
    async close() {
      clearInterval(timer);
      await h.rooms.closeAll();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
