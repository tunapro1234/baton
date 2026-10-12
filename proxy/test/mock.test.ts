import { describe, expect, it } from 'vitest';
import { FIXED, MOCK_BADGE, MOCK_OFF_SCRIPT, TOOL } from '@baton/contract';
import type { Message, TurnRequest } from '@baton/contract';
import { loadScripts, mockTurn } from '../src/mock.ts';

const scripts = loadScripts(new URL('../../recorded_responses/', import.meta.url).pathname);
const CLINICIAN = 'Dr. Lee';
const PLAN = 'Metformin 500 mg, morning and evening';

function req(messages: Message[], context?: TurnRequest['context']): TurnRequest {
  return { messages, tools: [], ...(context ? { context } : {}) };
}
const toolResult = (id: string, content: string): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content }],
});

describe('mock matching', () => {
  it('answers the first tool step of a matching turn', () => {
    const r = mockTurn(req([{ role: 'user', content: 'Show me today' }]), scripts);
    expect(r.mode).toBe('mock');
    expect(r.badge).toBe(MOCK_BADGE);
    expect(r.script).toBe('demo');
    expect(r.stop_reason).toBe('tool_use');
    expect(r.content).toEqual([expect.objectContaining({ type: 'tool_use', name: TOOL.todayView, input: {} })]);
  });

  it('matches case-insensitively on the latest plain user message', () => {
    const r = mockTurn(req([{ role: 'user', content: 'SHOW ME TODAY, please' }]), scripts);
    expect(r.content[0]).toMatchObject({ type: 'tool_use', name: TOOL.todayView });
  });

  it('answers with the off-script line when nothing matches', () => {
    const r = mockTurn(req([{ role: 'user', content: 'Tell me a joke about cats' }]), scripts);
    expect(r).toMatchObject({ mode: 'mock', badge: MOCK_BADGE, stop_reason: 'end_turn' });
    expect(r.content).toEqual([{ type: 'text', text: MOCK_OFF_SCRIPT }]);
  });
});

describe('mock step order', () => {
  it('moves from the tool step to the closing text, quoting the last tool result', () => {
    const first = [{ role: 'user', content: 'Show me today' }] as Message[];
    const toolId = 'mock-x';
    const second: Message[] = [
      ...first,
      { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: TOOL.todayView, input: {} }] },
      toolResult(toolId, 'Today: metformin given at 08:05.'),
    ];
    const r = mockTurn(req(second), scripts);
    expect(r.stop_reason).toBe('end_turn');
    expect(r.content).toEqual([{ type: 'text', text: 'Today: metformin given at 08:05.' }]);
  });

  it('runs off-script once the steps are used up', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Show me today' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: TOOL.todayView, input: {} }] },
      toolResult('a', 'ok'),
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      toolResult('b', 'extra'),
    ];
    expect(mockTurn(req(msgs), scripts).content).toEqual([{ type: 'text', text: MOCK_OFF_SCRIPT }]);
  });
});

describe('mock placeholders', () => {
  it('fills requestId with a fresh UUID each time and memberId from the context', () => {
    const line = [{ role: 'user', content: "I just gave her the big white pill" }] as Message[];
    const a = mockTurn(req(line, { memberId: 'aylin' }), scripts);
    const b = mockTurn(req(line, { memberId: 'aylin' }), scripts);
    const ia = a.content[0] as { input: Record<string, unknown> };
    const ib = b.content[0] as { input: Record<string, unknown> };
    expect(ia.input.memberId).toBe('aylin');
    expect(ia.input.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ia.input.requestId).not.toBe(ib.input.requestId);
  });

  it('falls back to sam when there is no member in the context', () => {
    const r = mockTurn(req([{ role: 'user', content: 'What did I miss?' }]), scripts);
    expect((r.content[0] as { input: Record<string, unknown> }).input.memberId).toBe('sam');
  });

  it('answers a dose question with the fixed sentence and no tool call', () => {
    const r = mockTurn(req([{ role: 'user', content: 'How much metformin should I give her?' }]), scripts);
    expect(r.stop_reason).toBe('end_turn');
    expect(r.content).toEqual([{ type: 'text', text: FIXED.dose(PLAN, CLINICIAN) }]);
  });
});
