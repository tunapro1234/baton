import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXED, NOT_A_MEDICAL_DEVICE } from '@baton/contract';
import { emergency, guard } from '../src/guardrail.ts';

const CTX = { clinician: 'Dr. Lee', planLine: 'Metformin 500 mg, morning and evening' };
const evalDir = new URL('../../evals/', import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, evalDir), 'utf8')) as T;
const cases = read<{ id: string; kind: 'dose' | 'interpretation'; draft: string }[]>('guardrail.json');
const clean = read<string[]>('guardrail-clean.json');

describe('guardrail eval set', () => {
  it('has 40 cases, 20 per kind', () => {
    expect(cases).toHaveLength(40);
    expect(cases.filter((c) => c.kind === 'dose')).toHaveLength(20);
    expect(cases.filter((c) => c.kind === 'interpretation')).toHaveLength(20);
  });

  it.each(cases.map((c) => [c.id, c.kind, c.draft] as const))('%s is replaced by its rule', (_id, kind, draft) => {
    const r = guard(draft, CTX);
    expect(r.replaced).toBe(true);
    expect(r.rule).toBe(kind);
    expect(r.text).toBe(kind === 'dose' ? FIXED.dose(CTX.planLine, CTX.clinician) : FIXED.symptom(CTX.clinician));
  });

  it('has 20 clean sentences', () => {
    expect(clean).toHaveLength(20);
  });

  it.each(clean)('passes unchanged: %s', (s) => {
    expect(guard(s, CTX)).toEqual({ text: s, replaced: false });
  });
});

describe('fixed sentences', () => {
  it('pass the guardrail unchanged', () => {
    expect(guard(FIXED.dose(CTX.planLine, CTX.clinician), CTX)).toEqual({ text: FIXED.dose(CTX.planLine, CTX.clinician), replaced: false });
    expect(guard(FIXED.symptom(CTX.clinician), CTX).replaced).toBe(false);
    expect(guard(FIXED.emergency, CTX).replaced).toBe(false);
    expect(guard(NOT_A_MEDICAL_DEVICE, CTX).replaced).toBe(false);
  });
});

describe('emergency', () => {
  it.each(['My mother has chest pain', "She can't breathe", 'He is not breathing well', 'She won\'t wake up', 'She fell and hit her head', 'I think it is a stroke', 'Possible overdose', 'She took too many pills'])(
    'flags %s',
    (text) => expect(emergency(text)).toBe(true),
  );
  it.each(['She seemed dizzy after lunch', 'Did Mom get her metformin?', 'Show me today'])('does not flag %s', (text) => {
    expect(emergency(text)).toBe(false);
  });
});
