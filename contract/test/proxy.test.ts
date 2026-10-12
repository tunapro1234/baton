import { describe, expect, it } from 'vitest';
import { BUDGET_NOTICE, MOCK_BADGE, MOCK_OFF_SCRIPT, RecordedScript, TurnRequest, TurnResponse } from '../src/index.ts';

describe('proxy contract', () => {
  it('pins the fixed strings', () => {
    expect(MOCK_BADGE).toBe('Recorded response (mock)');
    expect(MOCK_OFF_SCRIPT).toBe("This line isn't in the recorded script. Live mode needs an Anthropic API key.");
    expect(BUDGET_NOTICE).toBe('Live budget reached, recorded responses only');
  });

  it('accepts a tool round trip', () => {
    const req = TurnRequest.parse({
      messages: [
        { role: 'user', content: 'Did Mom get her metformin?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'check_med', input: { medId: 'metformin' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Sam logged metformin at 8:05.' }] },
      ],
      tools: [{ name: 'check_med', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
    });
    expect(req.tools[0]).toHaveProperty('outputSchema');
    expect(TurnResponse.parse({ mode: 'mock', badge: MOCK_BADGE, content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }).mode).toBe('mock');
  });

  it('requires recorded scripts to be labelled mock', () => {
    const s = { label: 'mock', name: 'n', description: 'd', turns: [{ match: [['metformin']], steps: [{ text: 'x' }] }] };
    expect(RecordedScript.safeParse(s).success).toBe(true);
    expect(RecordedScript.safeParse({ ...s, label: 'live' }).success).toBe(false);
  });
});
