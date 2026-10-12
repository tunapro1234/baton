// Talks to the assistant proxy. The proxy only plans: every tool_use it returns runs here, in the
// browser's own MCP client, and the result goes back in the next turn.
import type { Message, TurnResponse } from '@baton/contract/browser';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PROXY_URL, authHeaders } from './config.ts';
import { spoken, type Device, type ToolCall } from './device.ts';

const MAX_STEPS = 6;

export type AssistantEvents = {
  say: (text: string, meta: { mode: 'live' | 'mock'; badge?: string; notice?: string; guarded?: boolean }) => void;
  tool: (call: ToolCall, result: CallToolResult, ms: number) => void;
};

export async function proxyStatus(): Promise<{ ok: boolean; mode?: string }> {
  try {
    const r = await fetch(`${PROXY_URL}/healthz`, { headers: authHeaders() });
    return r.ok ? ((await r.json()) as { ok: boolean; mode?: string }) : { ok: false };
  } catch {
    return { ok: false };
  }
}

export class Assistant {
  readonly history: Message[] = [];
  private readonly device: Device;

  constructor(device: Device) {
    this.device = device;
  }

  async send(text: string, now: string | undefined, on: AssistantEvents): Promise<void> {
    this.history.push({ role: 'user', content: text });
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await fetch(`${PROXY_URL}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          messages: this.history,
          tools: this.device.tools,
          context: { memberId: this.device.memberId, now, device: this.device.label },
        }),
      });
      if (!res.ok) throw new Error(`proxy answered ${res.status}`);
      const turn = (await res.json()) as TurnResponse;
      this.history.push({ role: 'assistant', content: turn.content });
      for (const b of turn.content) {
        if (b.type === 'text' && b.text.trim()) {
          on.say(b.text, { mode: turn.mode, badge: turn.badge, notice: turn.notice, guarded: turn.guarded });
        }
      }
      const uses = turn.content.filter((b) => b.type === 'tool_use');
      if (turn.stop_reason !== 'tool_use' || uses.length === 0) return;
      const results: Message['content'] = [];
      for (const u of uses) {
        if (u.type !== 'tool_use') continue;
        const call = { name: u.name, args: u.input };
        const { result, ms } = await this.device.call(call);
        on.tool(call, result, ms);
        results.push({
          type: 'tool_result',
          tool_use_id: u.id,
          content: `${spoken(result)}\n${JSON.stringify(result.structuredContent ?? {})}`,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      this.history.push({ role: 'user', content: results });
    }
  }
}
