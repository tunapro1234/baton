// npm run demo: the public demo service. One process on one port, bound to 127.0.0.1 behind a
// reverse proxy that also serves the host build (npm run build:demo -w host) as static files.
//   /r/<room>/mcp, /r/<room>/clock   Baton MCP server, one in-memory household per room
//   /assistant/turn, /assistant/healthz   assistant proxy, recorded responses only
//   /healthz
// The assistant never makes a live model call here: the key is refused at start, not read, and
// both budget caps are 0. Every response carries X-Robots-Tag: noindex.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { configFromEnv as proxyConfigFromEnv } from '../proxy/src/config.ts';
import { proxyHandler } from '../proxy/src/server.ts';
import { listen, sendJson } from '../server/src/http.ts';
import { ROOM_DEFAULTS, roomsHandler } from '../server/src/rooms.ts';

if (process.env.ANTHROPIC_API_KEY !== undefined) {
  console.error('The demo runs on recorded responses only. Start it without ANTHROPIC_API_KEY in the environment.');
  process.exit(2);
}

const port = Number(process.env.BATON_PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`BATON_PORT is not a port: ${process.env.BATON_PORT}`);
const allowedOrigins = (process.env.BATON_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const fixture = process.env.BATON_FIXTURE || 'june';

const rooms = roomsHandler({ ...ROOM_DEFAULTS, port, fixture, allowedOrigins });
const assistant = proxyHandler({
  ...proxyConfigFromEnv({}),
  allowedOrigins,
  fixture,
  apiKey: '',
  budget: { file: fileURLToPath(new URL('../.baton/demo-usage.json', import.meta.url)), dayCap: 0, monthCap: 0 },
});
if (assistant.live) throw new Error('The demo assistant must not run live.');

const PREFIX = '/assistant';

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (await rooms.handle(req, res)) return;
  const url = req.url ?? '/';
  if (url === PREFIX || url.startsWith(`${PREFIX}/`)) {
    req.url = url.slice(PREFIX.length) || '/';
    try {
      return await assistant.handle(req, res);
    } catch (e) {
      const status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 500;
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal error' : (e as Error).message });
      else res.end();
      return;
    }
  }
  sendJson(res, 404, { error: 'Not found' });
}

const app = await listen(port, handle);
const timer = setInterval(() => void rooms.rooms.sweep(Date.now()), 60_000);
timer.unref();
console.log(`Baton demo on ${app.url} (rooms up to ${ROOM_DEFAULTS.maxRooms}, recorded responses only)`);

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    void rooms.rooms.closeAll().then(() => {
      app.server.closeAllConnections();
      app.server.close(() => process.exit(0));
    });
  });
}
