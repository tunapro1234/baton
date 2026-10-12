/// <reference types="vite/client" />
// Where the host finds the Baton MCP server and the assistant proxy. Local only: both bind to 127.0.0.1.
const env = import.meta.env;

export const SERVER_URL: string = env.VITE_BATON_SERVER || 'http://127.0.0.1:3000';
export const PROXY_URL: string = env.VITE_BATON_PROXY || 'http://127.0.0.1:3001';
/** Optional bearer token for a local server started with BATON_TOKEN. Never a real secret. */
export const TOKEN: string = env.VITE_BATON_TOKEN || '';

export function authHeaders(): Record<string, string> {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}
