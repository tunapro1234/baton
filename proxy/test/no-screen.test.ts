// The assistant on a device without a screen. Every recorded turn is played against a real in-process
// Baton server through a client that does not declare the MCP Apps UI extension, and every sentence the
// device would say is checked: no plan medicine name, no pill description, no strength, no note text.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { FIXED, SPOKEN, loadFixture, toolResultContent } from '@baton/contract';
import type { Block, Message, TurnRequest, TurnResponse } from '@baton/contract';
import { startApp, type App } from '../../server/src/http.ts';
import { loadScripts, mockTurn } from '../src/mock.ts';
import { guard, unspeakable } from '../src/guardrail.ts';
import { buildSystemPrompt } from '../src/system-prompt.ts';

const fx = loadFixture('june');
const scripts = loadScripts(new URL('../../recorded_responses/', import.meta.url).pathname);
const FORBIDDEN = [
  ...fx.plan.flatMap((p) => [p.id, p.name, p.generic, p.looks, p.dose]),
  ...fx.observations.map((o) => o.text),
];

function clean(said: string): void {
  const lower = said.toLowerCase();
  for (const f of FORBIDDEN) expect(lower, `"${said}" contains "${f}"`).not.toContain(f.toLowerCase());
  expect(said).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|ml)\b/i);
}

/** Accepts every elicitation with the first choice; keeps what a speaker would read out. */
const asked: string[] = [];
function autoAccept(p: ElicitRequest['params']): ElicitResult {
  asked.push(p.message);
  const props = ((p as { requestedSchema?: { properties?: Record<string, any> } }).requestedSchema?.properties ?? {});
  const content: Record<string, string | string[]> = {};
  for (const [key, s] of Object.entries(props)) {
    if (s.type === 'array') {
      asked.push(...(s.items?.anyOf ?? []).map((o: { title: string }) => o.title));
      content[key] = (s.items?.anyOf ?? []).map((o: { const: string }) => o.const);
    } else if (Array.isArray(s.oneOf)) {
      asked.push(...s.oneOf.map((o: { title: string }) => o.title));
      content[key] = s.oneOf[0]?.const;
    }
  }
  return { action: 'accept', content };
}

let app: App;
let client: Client;

beforeAll(async () => {
  app = await startApp({ port: 0, db: ':memory:', now: '2026-10-20T08:00:00', fixture: 'june', token: '', allowedOrigins: [] });
  client = new Client({ name: 'no-screen', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (r) => autoAccept(r.params));
  await client.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`)));
});
afterAll(async () => {
  await client?.close();
  await app?.close();
});

/** Plays one user line through the mock engine and the server, like the host does. Returns everything said. */
async function play(line: string): Promise<string[]> {
  const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
  const context: TurnRequest['context'] = { memberId: 'sam', now: '2026-10-20T08:00:00', screen: false };
  const messages: Message[] = [{ role: 'user', content: line }];
  const said: string[] = [];
  let res: TurnResponse = mockTurn({ messages, tools, context }, scripts);
  for (let i = 0; res.stop_reason === 'tool_use' && i < 10; i++) {
    messages.push({ role: 'assistant', content: res.content as Block[] });
    const results: Block[] = [];
    for (const b of res.content) {
      if (b.type !== 'tool_use') continue;
      const r = await client.callTool({ name: b.name, arguments: b.input });
      const text = (r.content as { type: string; text?: string }[])[0]?.text ?? '';
      said.push(text);
      results.push({ type: 'tool_result', tool_use_id: b.id, content: toolResultContent(text, r.structuredContent) });
    }
    messages.push({ role: 'user', content: results });
    res = mockTurn({ messages, tools, context }, scripts);
  }
  for (const b of res.content) if (b.type === 'text') said.push(b.text);
  return said;
}

describe('recorded responses on a device without a screen', () => {
  it('every recorded turn says nothing it should not', async () => {
    let turns = 0;
    for (const s of scripts) {
      for (const t of s.turns) {
        const line = t.match[0]!.join(' ');
        const said = await play(line);
        expect(said.length, line).toBeGreaterThan(0);
        for (const x of said) clean(x);
        turns++;
      }
    }
    for (const a of asked) clean(a);
    expect(turns).toBeGreaterThanOrEqual(20);
  });

  it('a text step that names the plan has a spoken variant, and fixed sentences use the SPOKEN wording', () => {
    for (const s of scripts) {
      for (const t of s.turns) {
        for (const st of t.steps) {
          if (!('text' in st)) continue;
          if (unspeakable(st.text, FORBIDDEN)) expect(st.noScreen, `${s.name}: ${st.text}`).toBeDefined();
          if (st.text === FIXED.symptom('Dr. Lee')) expect(st.noScreen).toBe(SPOKEN.symptom('Dr. Lee'));
          if (st.text.startsWith("I can't advise on doses")) expect(st.noScreen).toBe(SPOKEN.dose('Dr. Lee'));
        }
      }
    }
  });

  it('a screen device still gets the regular fixed sentence', () => {
    const r = mockTurn({ messages: [{ role: 'user', content: 'Can I give her half?' }], tools: [], context: { screen: true } }, scripts);
    expect(r.content[0]).toMatchObject({ type: 'text', text: FIXED.dose('Metformin 500 mg, morning and evening', 'Dr. Lee') });
  });
});

describe('live mode rules for a device without a screen', () => {
  it('the guardrail uses the spoken fixed sentences', () => {
    const ctx = { clinician: 'Dr. Lee', planLine: 'Metformin 500 mg, morning and evening', screen: false };
    expect(guard('You can give her half a metformin.', ctx).text).toBe(SPOKEN.dose('Dr. Lee'));
    expect(guard('The dizziness is probably a side effect.', ctx).text).toBe(SPOKEN.symptom('Dr. Lee'));
  });

  it('the system prompt carries the spoken rule only for a device without a screen', () => {
    const quiet = buildSystemPrompt(fx, { screen: false });
    expect(quiet).toContain('This device has no screen');
    expect(quiet).toContain(SPOKEN.dose('Dr. Lee'));
    expect(buildSystemPrompt(fx, { screen: true })).not.toContain('This device has no screen');
    expect(buildSystemPrompt(fx, {})).not.toContain('This device has no screen');
  });
});
