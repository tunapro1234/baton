// The three MCP Apps views in jsdom, fed with real tool results from an in-process Baton server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UI, VISIT_NOTE } from '@baton/contract';
import { startApp, type App } from '../../server/src/http.ts';
import { VIEWS } from '../../server/src/views.ts';

type Msg = { jsonrpc: '2.0'; id?: number; method?: string; params?: any; result?: any };

let app: App;
let client: Client;

beforeAll(async () => {
  app = await startApp({ port: 0, db: ':memory:', now: '2026-10-20T08:00:00', fixture: 'june', token: '', allowedOrigins: [] });
  client = new Client({ name: 'views-test', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (r) => {
    const props = (r.params as any).requestedSchema?.properties ?? {};
    if (props.observationIds) return { action: 'accept', content: { observationIds: props.observationIds.items.anyOf.map((o: any) => o.const) } };
    return { action: 'accept', content: {} };
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`)));
});
afterAll(async () => {
  await client?.close();
  await app?.close();
});

/** Loads a view with a fake parent window that records what the view posts. */
function mount(uri: string) {
  const html = VIEWS.find((v) => v.uri === uri)!.html;
  const sent: Msg[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(win: Window) {
      Object.defineProperty(win, 'parent', { value: { postMessage: (m: Msg) => sent.push(m) }, configurable: true });
    },
  });
  const win = dom.window;
  const deliver = (data: Msg) => win.dispatchEvent(new win.MessageEvent('message', { data }));
  const doc = win.document;
  return { win, doc, sent, deliver };
}

function initialize(v: ReturnType<typeof mount>, hostContext: Record<string, unknown>) {
  const init = v.sent.find((m) => m.method === 'ui/initialize')!;
  v.deliver({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'test', version: '0' }, hostCapabilities: {}, hostContext } });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('views', () => {
  it('each view is self-contained HTML with no external loads', () => {
    for (const v of VIEWS) {
      expect(v.mimeType).toBe('text/html;profile=mcp-app');
      expect(v.html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\//);
    }
  });

  it('declares inline and fullscreen in ui/initialize and says initialized', async () => {
    const v = mount(UI.today);
    const init = v.sent.find((m) => m.method === 'ui/initialize')!;
    expect(init.params.appCapabilities.availableDisplayModes).toEqual(['inline', 'fullscreen']);
    expect(init.params.protocolVersion).toBe('2026-01-26');
    initialize(v, { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] });
    await tick();
    expect(v.sent.some((m) => m.method === 'ui/notifications/initialized')).toBe(true);
    expect(v.doc.documentElement.dataset.theme).toBe('dark');
    expect((v.doc.getElementById('expand') as HTMLButtonElement).hidden).toBe(false);
  });

  it('asks for fullscreen only when the user clicks Expand', async () => {
    const v = mount(UI.today);
    initialize(v, { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] });
    await tick();
    expect(v.sent.some((m) => m.method === 'ui/request-display-mode')).toBe(false);
    (v.doc.getElementById('expand') as HTMLButtonElement).click();
    const req = v.sent.find((m) => m.method === 'ui/request-display-mode')!;
    expect(req.params).toEqual({ mode: 'fullscreen' });
    v.deliver({ jsonrpc: '2.0', id: req.id, result: { mode: 'fullscreen' } });
    await tick();
    expect(v.doc.documentElement.dataset.mode).toBe('fullscreen');
    expect(v.doc.getElementById('expand')!.textContent).toBe('Back');
  });

  it('hides Expand when the host has no fullscreen', async () => {
    const v = mount(UI.brief);
    initialize(v, { displayMode: 'inline', availableDisplayModes: ['inline'] });
    await tick();
    expect((v.doc.getElementById('expand') as HTMLButtonElement).hidden).toBe(true);
  });

  it('draws the today grid from a real today_view result', async () => {
    await client.callTool({ name: 'log_care_event', arguments: { memberId: 'sam', items: ['metformin'], heardText: 'metformin', requestId: 'v1' } });
    const result = await client.callTool({ name: 'today_view', arguments: {} });
    const v = mount(UI.today);
    initialize(v, { availableDisplayModes: ['inline'] });
    v.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result });
    const text = v.doc.getElementById('view')!.textContent!;
    expect(text).toContain('Metformin 500 mg');
    expect(text).toContain('Logged by Sam at 8:00');
    expect(text).toContain('No entry');
    expect(text).toContain('Upcoming');
    expect(v.doc.body.textContent).toContain('Not a medical device.');
  });

  it('draws the brief and the visit timeline, and shows the fixed note', async () => {
    const brief = await client.callTool({ name: 'handoff_brief', arguments: { memberId: 'aylin' } });
    const b = mount(UI.brief);
    b.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: brief });
    expect(b.doc.getElementById('view')!.textContent).toContain('Sam logged metformin');

    const visit = await client.callTool({ name: 'visit_brief', arguments: { from: '2026-10-14', to: '2026-10-20' } });
    const v = mount(UI.visit);
    v.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: visit });
    const text = v.doc.getElementById('view')!.textContent!;
    expect(text).toContain(VISIT_NOTE);
    expect(text).toContain('She seemed dizzy after lunch.');
    expect(text).toContain('Plan change');
  });

  it('renders user text as text, never as markup', async () => {
    const r = await client.callTool({ name: 'log_observation', arguments: { memberId: 'nora', text: '<img src=x onerror="window.pwned=1">' } });
    const visit = await client.callTool({ name: 'visit_brief', arguments: { from: '2026-10-20', to: '2026-10-20', observationIds: [(r.structuredContent as any).observationId] } });
    const v = mount(UI.visit);
    v.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: visit });
    expect(v.doc.querySelector('#view img')).toBeNull();
    expect(v.doc.getElementById('view')!.textContent).toContain('<img src=x');
    expect((v.win as any).pwned).toBeUndefined();
  });
});
