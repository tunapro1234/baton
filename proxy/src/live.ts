// Live mode: one streamed Messages call per proxy request. The client is created only when a key is set,
// and a factory can be injected so tests pass a fake. Never log the key, headers or full requests.
import Anthropic from '@anthropic-ai/sdk';

import type { Fixture, TurnRequest, TurnResponse } from '@baton/contract';
import type { Budget, Usage } from './budget.ts';
import { SPOKEN } from '@baton/contract';
import { guard, unspeakable } from './guardrail.ts';
import { buildSystemPrompt, planLineFor, type PromptContext } from './system-prompt.ts';

export const MAX_TOKENS = 400;

/** The part of the Anthropic SDK client this module uses. The real client and test fakes both fit. */
export type LiveClient = {
  messages: {
    stream(params: unknown): { finalMessage(): Promise<LiveMessage> };
  };
};

export type LiveMessage = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: string }
  >;
  stop_reason: string | null;
  usage: Usage;
};

export type ClientFactory = (apiKey: string) => LiveClient;

export const defaultClientFactory: ClientFactory = (apiKey) =>
  new Anthropic({ apiKey }) as unknown as LiveClient;

/** Live mode is available only with a non-empty key. */
export function makeLiveClient(apiKey: string, factory: ClientFactory = defaultClientFactory): LiveClient | undefined {
  return apiKey ? factory(apiKey) : undefined;
}

export type LiveDeps = {
  client: LiveClient;
  model: string;
  fx: Fixture;
  budget: Budget;
};

function toAnthropicMessages(req: TurnRequest): unknown[] {
  return req.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((b) => {
      if (b.type === 'tool_result') {
        return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) };
      }
      return b;
    }),
  }));
}

export function toolsFor(req: TurnRequest): unknown[] {
  return req.tools.map((t, i) => {
    const tool: Record<string, unknown> = {
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema,
    };
    if (i === req.tools.length - 1) tool.cache_control = { type: 'ephemeral' };
    return tool;
  });
}

/**
 * Runs one turn through the model. Text blocks pass the guardrail; tool_use blocks go to the browser unchanged.
 * Usage is recorded whether or not the guardrail changed anything.
 */
export async function runLive(req: TurnRequest, deps: LiveDeps): Promise<TurnResponse> {
  const context: PromptContext = req.context ?? {};
  const line = req.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').at(-1);
  const userText = typeof line?.content === 'string' ? line.content : '';
  const planLine = planLineFor(deps.fx, userText);
  const system = buildSystemPrompt(deps.fx, context);
  const screen = context.screen !== false;
  // Plan words a device without a screen must not say. Notes logged today are not in the fixture; the
  // prompt rule covers those, and the server never puts note text in a spoken tool result.
  const hidden = screen ? [] : [
    ...deps.fx.plan.flatMap((p) => [p.id, p.name, p.generic, p.looks]),
    ...deps.fx.observations.map((o) => o.text),
  ];

  const message = await deps.client.messages.stream({
    model: deps.model,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: toolsFor(req),
    tool_choice: { type: 'auto' },
    messages: toAnthropicMessages(req),
  }).finalMessage();

  deps.budget.record(message.usage);

  let guarded = false;
  const content: TurnResponse['content'] = [];
  for (const b of message.content) {
    if (b.type === 'text' && 'text' in b) {
      const g = guard(b.text, { clinician: deps.fx.clinician.name, planLine, screen });
      const hide = !screen && !g.replaced && unspeakable(g.text, hidden);
      guarded ||= g.replaced || hide;
      content.push({ type: 'text', text: hide ? SPOKEN.details : g.text });
    } else if (b.type === 'tool_use' && 'id' in b && 'name' in b) {
      content.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
  }
  const hasTool = content.some((b) => b.type === 'tool_use');
  return {
    mode: 'live',
    content,
    stop_reason: hasTool ? 'tool_use' : 'end_turn',
    guarded,
  };
}

