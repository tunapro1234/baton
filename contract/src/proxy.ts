// Host <-> assistant proxy contract. The proxy never runs tools: it returns tool_use blocks, the
// browser runs them through its own MCP client and sends the results back in the next turn.
import { z } from 'zod';

export const PROXY_DEFAULT_PORT = 3001;
export const DEFAULT_MODEL = 'claude-haiku-5-5';

export const MOCK_BADGE = 'Recorded response (mock)';
export const MOCK_OFF_SCRIPT = "This line isn't in the recorded script. Live mode needs an Anthropic API key.";
export const BUDGET_NOTICE = 'Live budget reached, recorded responses only';

/** Placeholder a recorded script uses for log_care_event.requestId; the proxy swaps in a fresh id each run. */
export const REQUEST_ID_PLACEHOLDER = '{{requestId}}';
/** Placeholder in a recorded text step: replaced by content[0].text of the last tool result, so mock replies never invent numbers. */
export const LAST_TOOL_TEXT = '{{lastToolText}}';

/** tool_result.content as the host builds it: the spoken line first, structuredContent JSON on the next line. */
export function toolResultContent(text: string, structured: unknown): string {
  return structured === undefined ? text : `${text}\n${JSON.stringify(structured)}`;
}

/** The spoken line (content[0].text) of a tool_result.content string. */
export function toolResultText(content: string): string {
  const nl = content.indexOf('\n');
  return nl < 0 ? content : content.slice(0, nl);
}
/** Placeholder in a recorded tool input: replaced by context.memberId (the confirmed speaker). */
export const MEMBER_ID_PLACEHOLDER = '{{memberId}}';

const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  /** The MCP CallToolResult as the browser got it: content[0].text, then a newline and the structuredContent JSON. */
  content: z.string(),
  is_error: z.boolean().optional(),
});
export const Block = z.discriminatedUnion('type', [TextBlock, ToolUseBlock, ToolResultBlock]);

export const Message = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(Block)]),
});

export const TurnRequest = z.object({
  /** Whole conversation so far, Anthropic Messages shape. The last message is the user's text or tool results. */
  messages: z.array(Message).min(1),
  /** tools/list result from the MCP server, passed through unchanged. */
  tools: z.array(
    z.object({ name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()) }).loose(),
  ),
  /** Who the device thinks is speaking (after who_is_here) and the simulated time, for the system prompt. */
  context: z.object({ memberId: z.string().optional(), now: z.string().optional(), device: z.string().optional() }).optional(),
});

export const TurnResponse = z.object({
  mode: z.enum(['live', 'mock']),
  /** Present in mock mode: exactly MOCK_BADGE. */
  badge: z.string().optional(),
  /** Present when live mode is off because the budget is spent: exactly BUDGET_NOTICE. */
  notice: z.string().optional(),
  /** Assistant content: text blocks (already through the guardrail) and tool_use blocks for the browser to run. */
  content: z.array(z.union([TextBlock, ToolUseBlock])),
  stop_reason: z.enum(['end_turn', 'tool_use']),
  /** True when the guardrail replaced some text. */
  guarded: z.boolean().optional(),
  /** Name of the recorded script that answered (mock only). */
  script: z.string().optional(),
});

export type Block = z.infer<typeof Block>;
export type Message = z.infer<typeof Message>;
export type TurnRequest = z.infer<typeof TurnRequest>;
export type TurnResponse = z.infer<typeof TurnResponse>;

/**
 * Recorded script (recorded_responses/<name>.json). Each turn answers one user line; its steps are
 * replayed one per proxy call: tool_use steps first, then the closing text.
 */
export const RecordedScript = z.object({
  label: z.literal('mock'),
  name: z.string(),
  description: z.string(),
  turns: z.array(
    z.object({
      /** Lowercase phrases; the turn matches when the user line contains every phrase of any one entry. */
      match: z.array(z.array(z.string().min(1)).min(1)).min(1),
      steps: z.array(
        z.union([
          z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) }),
          z.object({ text: z.string() }),
        ]),
      ).min(1),
    }),
  ).min(1),
});
export type RecordedScript = z.infer<typeof RecordedScript>;
