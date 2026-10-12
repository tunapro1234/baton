import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ElicitRequestSchema, ResourceUpdatedNotificationSchema, type ElicitRequest, type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { startApp, type App } from '../src/http.ts';

export const TOKEN = 'test-token-not-a-secret';

export function start(now = '2026-10-20T08:00:00', token = TOKEN): Promise<App> {
  return startApp({ port: 0, db: ':memory:', now, fixture: 'june', token, allowedOrigins: ['http://127.0.0.1:5173'] });
}

export type Policy = (p: ElicitRequest['params']) => ElicitResult;
export const accept: Policy = () => ({ action: 'accept', content: {} });
export const decline: Policy = () => ({ action: 'decline' });
export const pick = (field: string, value: string | string[]): Policy => () => ({ action: 'accept', content: { [field]: value } });

export type TestClient = Client & {
  elicits: ElicitRequest['params'][];
  updates: { uri: string; t: number }[];
  policy: Policy;
  sessionId: string | undefined;
};

export async function connect(app: App, name: string, policy: Policy = decline, token = TOKEN): Promise<TestClient> {
  const c = new Client({ name, version: '0.0.1' }, { capabilities: { elicitation: { form: {} } } }) as TestClient;
  c.elicits = [];
  c.updates = [];
  c.policy = policy;
  c.setRequestHandler(ElicitRequestSchema, async (r) => {
    c.elicits.push(r.params);
    return c.policy(r.params);
  });
  c.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
    c.updates.push({ uri: n.params.uri, t: Date.now() });
  });
  const t = new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await c.connect(t);
  c.sessionId = t.sessionId;
  return c;
}

export async function waitFor(fn: () => boolean, ms = 1000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

export type Structured = Record<string, any>;
export async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; sc: Structured; isError: boolean }> {
  const r = await c.callTool({ name, arguments: args });
  const first = (r.content as { type: string; text?: string }[])[0];
  return { text: first?.text ?? '', sc: (r.structuredContent ?? {}) as Structured, isError: Boolean(r.isError) };
}
