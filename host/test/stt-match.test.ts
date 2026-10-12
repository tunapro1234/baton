import { describe, expect, it } from 'vitest';
import { matchPlanNames } from '../src/stt-match.ts';

const PLAN = ['metformin', 'amlodipine', 'levothyroxine'];

describe('matchPlanNames', () => {
  it.each([
    ['I gave her the met forming', 'I gave her the metformin', 'met forming'],
    ['she had her levo thyroxine.', 'she had her levothyroxine.', 'levo thyroxine.'],
    ['am low dipine is done', 'amlodipine is done', 'am low dipine'],
    ['Metformen at eight', 'metformin at eight', 'Metformen'],
  ])('puts back "%s"', (heard, want, piece) => {
    const r = matchPlanNames(heard, PLAN);
    expect(r.text).toBe(want);
    expect(r.corrections[0]?.heard).toBe(piece);
  });

  it('leaves exact names and other words alone', () => {
    const r = matchPlanNames('I gave her the metformin and the small white one', PLAN);
    expect(r.text).toBe('I gave her the metformin and the small white one');
    expect(r.corrections).toEqual([]);
  });

  it.each(['the metal pin fell', 'for men only', 'she felt fine', 'I made a format'])('does not invent a drug in "%s"', (line) => {
    expect(matchPlanNames(line, PLAN).corrections).toEqual([]);
  });

  it('only knows names from the plan', () => {
    expect(matchPlanNames('she took her ibuprofen', PLAN).corrections).toEqual([]);
    expect(matchPlanNames('she took her ibuprofin', ['ibuprofen']).text).toBe('she took her ibuprofen');
  });
});
