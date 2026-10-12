import { describe, expect, it } from 'vitest';
import {
  ANNOTATIONS, FIXED, Input, Output, PROTOCOL_VERSION, RESOURCE, SUBSCRIBABLE, TOOL, TOOL_NAMES, TOOL_VIEW, UI,
  VISIT_NOTE, jsonSchema,
} from '../src/index.ts';

describe('contract', () => {
  it('names nine tools, each with input, output and annotations', () => {
    expect(TOOL_NAMES).toHaveLength(9);
    expect(new Set(TOOL_NAMES).size).toBe(9);
    for (const t of TOOL_NAMES) {
      expect(Input[t], t).toBeDefined();
      expect(Output[t], t).toBeDefined();
      expect(ANNOTATIONS[t], t).toBeDefined();
    }
  });

  it('targets MCP 2025-11-25', () => {
    expect(PROTOCOL_VERSION).toBe('2025-11-25');
  });

  it('attaches views only to today, brief and visit', () => {
    expect(TOOL_VIEW).toEqual({ today_view: UI.today, handoff_brief: UI.brief, visit_brief: UI.visit });
  });

  it('lets clients subscribe to everything except the read-only plan', () => {
    expect(SUBSCRIBABLE).not.toContain(RESOURCE.plan);
    expect(SUBSCRIBABLE).toHaveLength(3);
  });

  it('marks correct_entry as the only destructive tool', () => {
    const destructive = TOOL_NAMES.filter((t) => ANNOTATIONS[t].destructiveHint);
    expect(destructive).toEqual([TOOL.correctEntry]);
  });

  it('produces object JSON Schemas without a $schema key', () => {
    for (const t of TOOL_NAMES) {
      for (const s of [jsonSchema(Input[t]), jsonSchema(Output[t])]) {
        expect(s.type).toBe('object');
        expect(s).not.toHaveProperty('$schema');
        expect(s.additionalProperties).not.toBe(false);
      }
    }
    expect(jsonSchema(Input.log_care_event).required).toEqual(
      expect.arrayContaining(['memberId', 'items', 'heardText', 'requestId']),
    );
  });

  it('words the duplicate warning as a fact, not advice', () => {
    expect(FIXED.duplicate('Sam', 'metformin', '8:05')).toBe('Sam logged metformin at 8:05. Log again anyway?');
  });

  it('keeps fixed safety replies', () => {
    expect(FIXED.dose('Metformin 500 mg in the morning and evening', 'Dr. Lee')).toBe(
      "I can't advise on doses. The plan says Metformin 500 mg in the morning and evening. Please ask Dr. Lee.",
    );
    expect(FIXED.symptom('Dr. Lee')).toBe("I can't interpret symptoms. I've added it to the timeline for Dr. Lee.");
  });

  it('pins the visit note', () => {
    const ok = Output.visit_brief.safeParse({ from: '2026-10-13', to: '2026-10-20', clinician: 'Dr. Lee', rows: [], note: VISIT_NOTE });
    expect(ok.success).toBe(true);
    const bad = Output.visit_brief.safeParse({ from: '2026-10-13', to: '2026-10-20', clinician: 'Dr. Lee', rows: [], note: 'x' });
    expect(bad.success).toBe(false);
  });

  it('rejects zoned timestamps in outputs', () => {
    const r = Output.log_observation.safeParse({ observationId: 'o1', at: '2026-10-20T08:05:00Z', text: 'x' });
    expect(r.success).toBe(false);
  });
});
