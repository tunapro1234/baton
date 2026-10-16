import { describe, expect, it } from 'vitest';
import { FIXED, Input, LAST_TOOL_TEXT, SPOKEN, TOOL, TOOL_NAMES, RecordedScript } from '@baton/contract';
import type { ToolName } from '@baton/contract';
import { claimsNoteWritten } from '../src/live.ts';
import { loadScripts } from '../src/mock.ts';

const scripts = loadScripts(new URL('../../recorded_responses/', import.meta.url).pathname);
const PLAN = 'Metformin 500 mg, morning and evening';
const CLINICIAN = 'Dr. Lee';
const PLACEHOLDERS = new Set(['{{requestId}}', '{{memberId}}']);

type Step = { tool?: string; text?: string; noScreen?: string };

/**
 * Every text step that says a note was written: a literal "added ... timeline/note" sentence (screen or
 * no-screen wording), or {{lastToolText}} read back from a log_observation result. Each must follow a
 * log_observation step in the same turn.
 */
function writeClaims(turns: { name: string; steps: readonly Step[] }[]): { claims: number; unbacked: string[] } {
  let claims = 0;
  const unbacked: string[] = [];
  for (const t of turns) {
    t.steps.forEach((st, i) => {
      if (st.text === undefined) return;
      const before = t.steps.slice(0, i).filter((x) => x.tool !== undefined);
      const readsObservation = st.text === LAST_TOOL_TEXT && before.at(-1)?.tool === TOOL.logObservation;
      const literal = [st.text, st.noScreen].some((x) => x !== undefined && claimsNoteWritten(x));
      if (!readsObservation && !literal) return;
      claims++;
      if (!before.some((x) => x.tool === TOOL.logObservation)) unbacked.push(t.name);
    });
  }
  return { claims, unbacked };
}

describe('recorded scripts', () => {
  it('load and validate, with job-named files for the four jobs', () => {
    const names = scripts.map((s) => s.file);
    for (const job of ['visit-prep', 'since-you-left', 'free-question', 'disambiguation', 'demo']) {
      expect(names.some((n) => n.includes(job))).toBe(true);
    }
    for (const s of scripts) expect(() => RecordedScript.parse(s)).not.toThrow();
  });

  it('has at least 20 user lines in total', () => {
    const turns = scripts.reduce((n, s) => n + s.turns.length, 0);
    expect(turns).toBeGreaterThanOrEqual(20);
  });

  it('uses real tool names and arguments that pass the contract input schemas', () => {
    for (const s of scripts) {
      for (const t of s.turns) {
        for (const step of t.steps) {
          if (!('tool' in step)) continue;
          expect(TOOL_NAMES).toContain(step.tool);
          const input = JSON.parse(JSON.stringify(step.input), (_k, v) =>
            PLACEHOLDERS.has(v) ? 'placeholder-value' : v,
          ) as Record<string, unknown>;
          const parsed = Input[step.tool as ToolName].safeParse(input);
          expect(parsed.success, `${s.name}: ${step.tool} ${JSON.stringify(step.input)}`).toBe(true);
        }
      }
    }
  });

  it('keeps fixed sentences exactly as the contract words them', () => {
    const texts = scripts.flatMap((s) => s.turns.flatMap((t) => t.steps.flatMap((st) => ('text' in st ? [st.text] : []))));
    const doses = texts.filter((t) => t.startsWith("I can't advise on doses"));
    expect(doses.length).toBeGreaterThan(0);
    for (const d of doses) expect(d).toBe(FIXED.dose(PLAN, CLINICIAN));
    const symptoms = texts.filter((t) => t.startsWith("I can't interpret symptoms"));
    expect(symptoms.length).toBeGreaterThan(0);
    for (const d of symptoms) expect([FIXED.symptomQuestion(CLINICIAN), FIXED.symptomReport(CLINICIAN)]).toContain(d);
  });

  it('says a symptom note was added only in a turn that ran log_observation first', () => {
    const turns = scripts.flatMap((s) => s.turns.map((t) => ({ name: `${s.name}: ${t.match[0]!.join(' ')}`, steps: t.steps })));
    const { claims, unbacked } = writeClaims(turns);
    // The "seemed dizzy" turn reads back the log_observation result, so at least one claim is checked.
    expect(claims).toBeGreaterThan(0);
    expect(unbacked).toEqual([]);
  });

  it('flags a recorded note-added sentence with no log_observation before it', () => {
    const steps = [{ text: FIXED.symptomQuestion(CLINICIAN), noScreen: SPOKEN.symptomReport(CLINICIAN) }];
    expect(writeClaims([{ name: 'made up', steps }]).unbacked).toEqual(['made up']);
    expect(writeClaims([{ name: 'made up', steps: [{ text: "I've added your note to the timeline." }] }]).unbacked).toEqual(['made up']);
  });

  it('answers the dizziness question with the sentence that claims no write, and runs no tool', () => {
    const turn = scripts.flatMap((s) => s.turns).find((t) => t.match.some((m) => m.includes('dizziness')));
    expect(turn).toBeDefined();
    expect(turn!.steps.some((st) => 'tool' in st)).toBe(false);
    expect(turn!.steps).toContainEqual(expect.objectContaining({ text: FIXED.symptomQuestion(CLINICIAN) }));
  });
});
