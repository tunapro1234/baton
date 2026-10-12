import { describe, expect, it } from 'vitest';
import { loadFixture } from '@baton/contract';
import { activePlan, matchItem, windowForDose } from '../src/domain.ts';

const fx = loadFixture('june');
const plan = activePlan(fx, '2026-10-20');
const ids = (item: string) => matchItem(plan, item).map((p) => p.id).sort();

describe('plan matching', () => {
  it('matches by id, generic name and label', () => {
    expect(ids('metformin')).toEqual(['metformin']);
    expect(ids('Metformin 500 mg')).toEqual(['metformin']);
    expect(ids('her levothyroxine')).toEqual(['levothyroxine']);
  });

  it('matches descriptions word by word', () => {
    expect(ids('the small white one')).toEqual(['amlodipine', 'levothyroxine']);
    expect(ids('the big white pill')).toEqual(['metformin']);
    expect(ids('the large oval tablet')).toEqual(['metformin']);
  });

  it('matches nothing outside the plan', () => {
    expect(ids('vitamin gummies')).toEqual([]);
    expect(ids('the pill')).toEqual([]);
  });

  it('leaves amlodipine out before its start date', () => {
    expect(activePlan(fx, '2026-10-15').map((p) => p.id)).not.toContain('amlodipine');
  });
});

describe('windowForDose', () => {
  it('uses the open window, else the closest one for that med', () => {
    expect(windowForDose(fx, 'metformin', '2026-10-20T08:00:00')?.id).toBe('morning');
    expect(windowForDose(fx, 'metformin', '2026-10-20T17:45:00')?.id).toBe('evening');
    expect(windowForDose(fx, 'amlodipine', '2026-10-20T19:00:00')?.id).toBe('morning');
  });
});
