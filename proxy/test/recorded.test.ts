import { describe, expect, it } from 'vitest';
import { FIXED, Input, TOOL_NAMES, RecordedScript } from '@baton/contract';
import type { ToolName } from '@baton/contract';
import { loadScripts } from '../src/mock.ts';

const scripts = loadScripts(new URL('../../recorded_responses/', import.meta.url).pathname);
const PLAN = 'Metformin 500 mg, morning and evening';
const CLINICIAN = 'Dr. Lee';
const PLACEHOLDERS = new Set(['{{requestId}}', '{{memberId}}']);

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
    for (const d of texts.filter((t) => t.startsWith("I can't interpret symptoms"))) expect(d).toBe(FIXED.symptom(CLINICIAN));
  });
});
