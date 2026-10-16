// runLive with a fake client: no network, no key. Checks that a "note added" sentence is said only after
// log_observation wrote the note.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, FIXED, SPOKEN, TOOL, loadFixture } from '@baton/contract';
import type { Message, TurnRequest } from '@baton/contract';
import { Budget } from '../src/budget.ts';
import { claimsNoteWritten, runLive, type LiveClient, type LiveMessage } from '../src/live.ts';

delete process.env.ANTHROPIC_API_KEY;

const fx = loadFixture('june');
const CLINICIAN = fx.clinician.name;
const LINE = 'Mom seemed dizzy after lunch';
const USAGE = { input_tokens: 10, output_tokens: 10 };

function deps(content: LiveMessage['content']) {
  const client: LiveClient = {
    messages: { stream: () => ({ finalMessage: async () => ({ content, stop_reason: 'end_turn', usage: USAGE }) }) },
  };
  const dir = mkdtempSync(join(tmpdir(), 'baton-live-test-'));
  return { client, model: DEFAULT_MODEL, fx, budget: new Budget({ file: join(dir, 'usage.json'), dayCap: 1, monthCap: 8 }) };
}

function req(messages: Message[], screen = true): TurnRequest {
  return {
    messages,
    tools: [{ name: TOOL.logObservation, inputSchema: { type: 'object', properties: {} } }],
    context: { memberId: 'nora', now: '2026-10-20T13:00:00', screen },
  };
}

const callObservation: Message = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tu1', name: TOOL.logObservation, input: { memberId: 'nora', text: LINE } }],
};
const result = (isError: boolean): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Noted.', ...(isError ? { is_error: true } : {}) }],
});
const report = FIXED.symptomReport(CLINICIAN);
const texts = (r: Awaited<ReturnType<typeof runLive>>) => r.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));

describe('note-added sentence in live mode', () => {
  it('recognises the report sentences as a write claim and the question as none', () => {
    expect(claimsNoteWritten(FIXED.symptomReport(CLINICIAN))).toBe(true);
    expect(claimsNoteWritten(SPOKEN.symptomReport(CLINICIAN))).toBe(true);
    expect(claimsNoteWritten(FIXED.symptomQuestion(CLINICIAN))).toBe(false);
  });

  it('replaces it when it sits in the same message as the log_observation call', async () => {
    const r = await runLive(req([{ role: 'user', content: LINE }]), deps([
      { type: 'text', text: report },
      { type: 'tool_use', id: 'tu1', name: TOOL.logObservation, input: { memberId: 'nora', text: LINE } },
    ]));
    expect(texts(r)).toEqual([FIXED.symptomQuestion(CLINICIAN)]);
    expect(r.guarded).toBe(true);
    expect(r.content.some((b) => b.type === 'tool_use' && b.name === TOOL.logObservation)).toBe(true);
  });

  it('replaces it when no tool ran at all', async () => {
    const r = await runLive(req([{ role: 'user', content: LINE }]), deps([{ type: 'text', text: report }]));
    expect(texts(r)).toEqual([FIXED.symptomQuestion(CLINICIAN)]);
    expect(r.guarded).toBe(true);
  });

  it('replaces it after log_observation failed', async () => {
    const r = await runLive(
      req([{ role: 'user', content: LINE }, callObservation, result(true)]),
      deps([{ type: 'text', text: report }]),
    );
    expect(texts(r)).toEqual([FIXED.symptomQuestion(CLINICIAN)]);
  });

  it('keeps it after log_observation succeeded', async () => {
    const r = await runLive(
      req([{ role: 'user', content: LINE }, callObservation, result(false)]),
      deps([{ type: 'text', text: report }]),
    );
    expect(texts(r)).toEqual([report]);
    expect(r.guarded).toBe(false);
  });

  it('uses the spoken question on a device without a screen', async () => {
    const r = await runLive(req([{ role: 'user', content: LINE }], false), deps([{ type: 'text', text: SPOKEN.symptomReport(CLINICIAN) }]));
    expect(texts(r)).toEqual([SPOKEN.symptomQuestion(CLINICIAN)]);
  });
});
