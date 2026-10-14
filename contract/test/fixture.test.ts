import { describe, expect, it } from 'vitest';
import { loadFixture, parseFixture } from '../src/index.ts';

const fx = loadFixture('june');

describe('june fixture', () => {
  it('is fictional and dated 2026-10-20', () => {
    expect(fx.label).toBe('fictional');
    expect(fx.household).toMatchObject({ name: 'June Harper', age: 81, fictional: true });
    expect(fx.today).toBe('2026-10-20');
    expect(fx.clinician.name).toBe('Dr. Lee');
  });

  it('has the three caregivers and the three plan items', () => {
    expect(fx.members.map((m) => m.id).sort()).toEqual(['aylin', 'nora', 'sam']);
    expect(fx.members.find((m) => m.id === 'nora')!.shift).toBeNull();
    expect(fx.plan.map((p) => p.id)).toEqual(['metformin', 'amlodipine', 'levothyroxine']);
  });

  it('holds seven days of history before today', () => {
    const days = new Set(fx.events.map((e) => e.at.slice(0, 10)));
    expect(days.size).toBe(7);
    expect([...days].every((d) => d < fx.today)).toBe(true);
  });

  it('contains the stories the demo tells', () => {
    const morningMetformin1015 = fx.events.filter((e) => e.at.startsWith('2026-10-15') && e.medId === 'metformin' && e.windowId === 'morning');
    expect(morningMetformin1015.map((e) => e.memberId)).toEqual(['sam', 'nora']);
    const evening1018 = fx.events.filter((e) => e.at.startsWith('2026-10-18') && e.windowId === 'evening');
    expect(evening1018).toEqual([]);
    expect(fx.observations.length).toBeGreaterThanOrEqual(3);
    expect(fx.observations.some((o) => /dizzy/.test(o.text))).toBe(true);
    expect(fx.planChanges).toHaveLength(1);
    const firstAmlodipine = fx.events.filter((e) => e.medId === 'amlodipine').map((e) => e.at).sort()[0];
    expect(firstAmlodipine!.slice(0, 10)).toBe(fx.planChanges[0]!.date);
  });

  it('rejects references to unknown members', () => {
    const broken = structuredClone(fx);
    broken.events[0]!.memberId = 'nobody';
    expect(() => parseFixture(broken)).toThrow(/unknown member/);
  });
});
