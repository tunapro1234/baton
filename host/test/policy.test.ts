// The host side of the voice policy: the UI extension a screen device declares, the session a no-screen
// device switches to, the one-time permission prompt, and the notice lines on the plan and timeline views.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { EXTENSION_ID } from '@modelcontextprotocol/ext-apps/server';
import {
  ADVICE_NOTICE, ENTERED_BY_FAMILY, PERMISSION_PROMPT, SPOKEN, UI, UI_EXTENSION, clientHasScreen,
} from '@baton/contract';
import { startApp, type App } from '../../server/src/http.ts';
import { VIEWS } from '../../server/src/views.ts';
import { askConsent, consentGiven, type ConsentStore } from '../src/consent.ts';

let app: App;

beforeAll(async () => {
  app = await startApp({ port: 0, db: ':memory:', now: '2026-10-20T08:00:00', fixture: 'june', token: '', allowedOrigins: [] });
  vi.stubEnv('VITE_BATON_SERVER', app.url);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app?.close();
});

describe('MCP Apps UI extension', () => {
  it('uses the extension id from @modelcontextprotocol/ext-apps', () => {
    expect(UI_EXTENSION).toBe(EXTENSION_ID);
  });

  it('a device declares it with a screen and reconnects without it when the screen is off', async () => {
    const { Device } = await import('../src/device.ts');
    const d = new Device('t', 'Test device');
    await d.connect();
    const caps = () => [...app.ctx.hub.sessions.values()].map((s) => clientHasScreen(s.server.getClientCapabilities()));
    expect(caps()).toEqual([true]);
    const first = d.sessionId;

    await d.call({ name: 'log_care_event', args: { memberId: 'sam', items: ['metformin'], heardText: 'metformin', requestId: 'h1' } });
    expect(d.screen).toBe(true);
    await d.setScreen(false);
    expect(d.sessionId).not.toBe(first);
    // The old session is ended, so the server holds only the new one, which has no screen.
    expect(caps()).toEqual([false]);
    const { result } = await d.call({ name: 'check_med', args: { medId: 'metformin' } });
    expect((result.content[0] as { text: string }).text).toBe(SPOKEN.given('Sam', '8:00', 'morning'));

    await d.setScreen(true);
    expect(caps()).toEqual([true]);
    const again = await d.call({ name: 'check_med', args: { medId: 'metformin' } });
    expect((again.result.content[0] as { text: string }).text).toBe('Sam logged metformin at 8:00, in the morning window.');
    await d.close();
  });
});

describe('permission prompt', () => {
  function page() {
    const dom = new JSDOM('<!doctype html><body></body>');
    const data = new Map<string, string>();
    const store: ConsentStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
    return { doc: dom.window.document, store, data };
  }
  const button = (doc: Document, id: string) => doc.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

  it('shows the exact text, and "Not now" stores nothing and reports no consent', async () => {
    const { doc, store, data } = page();
    const answer = askConsent(doc, store, 'room-a');
    expect(doc.body.dataset.consent).toBe('asking');
    expect(doc.querySelector('[data-testid="consent"]')!.textContent).toContain(PERMISSION_PROMPT);
    button(doc, 'consent-not-now').click();
    expect(await answer).toBe(false);
    expect(doc.body.dataset.consent).toBe('declined');
    expect(doc.querySelector('[data-testid="consent"]')).toBeNull();
    expect(data.size).toBe(0);
  });

  it('asks once per room: Continue is remembered for that room only', async () => {
    const { doc, store } = page();
    const answer = askConsent(doc, store, 'room-a');
    button(doc, 'consent-continue').click();
    expect(await answer).toBe(true);
    expect(consentGiven(store, 'room-a')).toBe(true);
    expect(await askConsent(doc, store, 'room-a')).toBe(true);
    expect(doc.querySelector('[data-testid="consent"]')).toBeNull();
    void askConsent(doc, store, 'room-b');
    expect(doc.querySelector('[data-testid="consent"]')).not.toBeNull();
  });

  it('still works when storage is blocked', async () => {
    const { doc } = page();
    const blocked: ConsentStore = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const answer = askConsent(doc, blocked, 'room-a');
    button(doc, 'consent-continue').click();
    expect(await answer).toBe(true);
  });
});

describe('notice lines on the views', () => {
  const html = (uri: string) => VIEWS.find((v) => v.uri === uri)!.html;

  it('the plan and the timeline carry both sentences word for word; the brief does not', () => {
    for (const uri of [UI.today, UI.visit]) for (const s of ADVICE_NOTICE) expect(html(uri)).toContain(s);
    expect(html(UI.brief)).not.toContain(ADVICE_NOTICE[0]);
  });

  it('each plan line says it was entered by the family, and the consent line shows', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'views', version: '0' }, { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: ['text/html;profile=mcp-app'] } } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`)));
    const result = await client.callTool({ name: 'today_view', arguments: {} });
    await client.close();

    const dom = new JSDOM(html(UI.today), {
      runScripts: 'dangerously',
      beforeParse(win: Window) {
        Object.defineProperty(win, 'parent', { value: { postMessage: () => undefined }, configurable: true });
      },
    });
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));
    const doc = dom.window.document;
    const rows = doc.querySelectorAll('.row');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.querySelector('.entered')!.textContent).toBe(ENTERED_BY_FAMILY);
    expect(doc.querySelector('.consent')!.textContent).toBe('June agreed to this shared log and its purpose on 2026-10-13 (fictional).');
    expect(doc.querySelector('[data-testid="advice"]')!.textContent).toBe(ADVICE_NOTICE.join(' '));
  });
});
