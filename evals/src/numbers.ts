// Numbers eval: runs 20 scripted user lines through the mock engine and the real in-process Baton server
// (MCP SDK client, Streamable HTTP). Every number in the final assistant text must appear in that turn's
// tool results, in structuredContent, or in the user's line. No key, no live model.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { toolResultContent } from '@baton/contract';
import type { Block, Message, TurnResponse } from '@baton/contract';
import { startApp } from '../../server/src/http.ts';
import { loadScripts, mockTurn } from '../../proxy/src/mock.ts';

const NOW = '2026-10-20T08:00:00';
const MEMBER = 'sam';
const lines = JSON.parse(readFileSync(new URL('../numbers-lines.json', import.meta.url), 'utf8')) as string[];
const scripts = loadScripts(new URL('../../recorded_responses/', import.meta.url).pathname);

/** Elicitation: first option for single-select, every option for multi-select, empty form for confirmations. */
function autoAccept(p: ElicitRequest['params']): ElicitResult {
  const props = ((p as { requestedSchema?: { properties?: Record<string, any> } }).requestedSchema?.properties ?? {});
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, s] of Object.entries(props)) {
    if (s.type === 'array') content[key] = (s.items?.anyOf ?? []).map((o: { const: string }) => o.const);
    else if (Array.isArray(s.oneOf)) content[key] = s.oneOf[0]?.const;
    else if (Array.isArray(s.enum)) content[key] = s.enum[0];
  }
  return { action: 'accept', content };
}

type Outcome = { line: string; ok: boolean; final: string; bad: string[]; tools: number };

async function runLine(line: string): Promise<Outcome> {
  // A fresh server per line, so earlier writes cannot change what a later line sees.
  const app = await startApp({ port: 0, db: ':memory:', now: NOW, fixture: 'june', token: '', allowedOrigins: [] });
  const client = new Client({ name: 'numbers-eval', version: '0.0.1' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (r) => autoAccept(r.params));
  await client.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`)));
  try {
    const listed = await client.listTools();
    const tools = listed.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
    const context = { memberId: MEMBER, now: NOW };
    const messages: Message[] = [{ role: 'user', content: line }];
    const seen: string[] = [];
    let res: TurnResponse = mockTurn({ messages, tools, context }, scripts);
    let toolCount = 0;
    for (let guardRounds = 0; res.stop_reason === 'tool_use' && guardRounds < 10; guardRounds++) {
      messages.push({ role: 'assistant', content: res.content as Block[] });
      const results: Block[] = [];
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        toolCount++;
        const r = await client.callTool({ name: block.name, arguments: block.input });
        const text = (r.content as { type: string; text?: string }[])[0]?.text ?? '';
        seen.push(text, JSON.stringify(r.structuredContent ?? {}));
        results.push({ type: 'tool_result', tool_use_id: block.id, content: toolResultContent(text, r.structuredContent), ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      res = mockTurn({ messages, tools, context }, scripts);
    }
    const final = res.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ').trim();
    const allowed = [line, ...seen].join('\n');
    const numbers = final.match(/\d+(?::\d\d)?/g) ?? [];
    const bad = numbers.filter((n) => !allowed.includes(n));
    return { line, ok: final.length > 0 && bad.length === 0, final, bad, tools: toolCount };
  } finally {
    await client.close();
    await app.close();
  }
}

let pass = 0;
for (const [i, line] of lines.entries()) {
  const o = await runLine(line);
  if (o.ok) pass++;
  const detail = o.ok ? '' : ` numbers not in tool output: ${o.bad.join(', ') || '(empty reply)'}`;
  console.log(`line ${i + 1}: ${o.ok ? 'ok' : 'FAIL'} (${o.tools} tool calls)${detail}`);
}
console.log(`numbers: ${pass}/${lines.length}`);
process.exit(pass === lines.length ? 0 : 1);
