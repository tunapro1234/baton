// Mock engine: replays recorded_responses/*.json. No model, no key. Turns are matched on the user's line,
// steps are replayed one per proxy call (tool_use first, then the closing text).
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LAST_TOOL_TEXT, MEMBER_ID_PLACEHOLDER, MOCK_BADGE, MOCK_OFF_SCRIPT, REQUEST_ID_PLACEHOLDER, RecordedScript, USER_LINE_PLACEHOLDER, toolResultText,
} from '@baton/contract';
import type { Block, Message, TurnRequest, TurnResponse } from '@baton/contract';

export type LoadedScript = RecordedScript & { file: string };

export function loadScripts(dir: string): LoadedScript[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, ...RecordedScript.parse(JSON.parse(readFileSync(join(dir, file), 'utf8'))) }));
}

/** The latest user message that is plain text: the line the turn answers. */
export function userLine(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/** Text of the user's latest plain message, as the model sees it. Empty when there is none. */
export function latestUserText(messages: Message[]): string {
  return userLine(messages);
}

/** Index of the latest plain-text user message; -1 if none. */
function lineIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && typeof m.content === 'string') return i;
  }
  return -1;
}

function isToolResultMessage(m: Message): boolean {
  return m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
}

function lastToolResult(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!Array.isArray(m.content)) continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b: Block = m.content[j]!;
      if (b.type === 'tool_result') return toolResultText(b.content);
    }
  }
  return '';
}

function fill(value: unknown, ctx: { requestId: string; memberId: string; userLine: string }): unknown {
  if (typeof value === 'string') {
    return value
      .split(REQUEST_ID_PLACEHOLDER).join(ctx.requestId)
      .split(MEMBER_ID_PLACEHOLDER).join(ctx.memberId)
      .split(USER_LINE_PLACEHOLDER).join(ctx.userLine);
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, ctx)]));
  }
  return value;
}

function matches(line: string, match: string[][]): boolean {
  return match.some((phrases) => phrases.every((p) => line.includes(p)));
}

export function mockTurn(req: TurnRequest, scripts: LoadedScript[]): TurnResponse {
  const line = userLine(req.messages).toLowerCase();
  const at = lineIndex(req.messages);
  const after = at < 0 ? [] : req.messages.slice(at + 1);
  const step = after.filter(isToolResultMessage).length;
  const memberId = req.context?.memberId || 'sam';

  for (const script of scripts) {
    const turn = script.turns.find((t) => matches(line, t.match));
    if (!turn) continue;
    const s = turn.steps[step];
    if (!s) break;
    const base = { mode: 'mock' as const, badge: MOCK_BADGE, script: script.name, guarded: false };
    if ('tool' in s) {
      const input = fill(s.input, { requestId: randomUUID(), memberId, userLine: userLine(req.messages) }) as Record<string, unknown>;
      return {
        ...base,
        content: [{ type: 'tool_use', id: `mock-${randomBytes(6).toString('hex')}`, name: s.tool, input }],
        stop_reason: 'tool_use',
      };
    }
    const text = s.text.split(LAST_TOOL_TEXT).join(lastToolResult(req.messages));
    return { ...base, content: [{ type: 'text', text }], stop_reason: 'end_turn' };
  }

  return {
    mode: 'mock',
    badge: MOCK_BADGE,
    script: 'off-script',
    content: [{ type: 'text', text: MOCK_OFF_SCRIPT }],
    stop_reason: 'end_turn',
  };
}
