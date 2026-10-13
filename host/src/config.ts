/// <reference types="vite/client" />
// Where the host finds the Baton MCP server and the assistant proxy. Locally both bind to 127.0.0.1.
// A demo build (VITE_BATON_ROOMS=1) talks to one room of the public demo service instead: the room id
// rides in the page URL (?room=), so a reload or a second window with the same link sees the same household.
const env = import.meta.env;

/** A path such as "/assistant" is taken relative to the page's own origin. */
function base(value: string | undefined, fallback: string): string {
  const v = value || fallback;
  return v.startsWith('/') ? `${location.origin}${v === '/' ? '' : v}` : v;
}

const ROOM_ID = /^[a-z0-9]{12,32}$/;

/** The room in the page URL, or a new one written into it. */
export function roomFromLocation(): string {
  const url = new URL(location.href);
  const given = url.searchParams.get('room') ?? '';
  if (ROOM_ID.test(given)) return given;
  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  url.searchParams.set('room', fresh);
  history.replaceState(null, '', url);
  return fresh;
}

export const ROOMS: boolean = env.VITE_BATON_ROOMS === '1';
const server = base(env.VITE_BATON_SERVER, 'http://127.0.0.1:3000');
export const SERVER_URL: string = ROOMS ? `${server}/r/${roomFromLocation()}` : server;
export const PROXY_URL: string = base(env.VITE_BATON_PROXY, 'http://127.0.0.1:3001');
/** Optional bearer token for a local server started with BATON_TOKEN. Never a real secret. */
export const TOKEN: string = env.VITE_BATON_TOKEN || '';

export function authHeaders(): Record<string, string> {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}
