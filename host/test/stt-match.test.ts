import { describe, expect, it } from 'vitest';
import { matchNote, matchPlanNames } from '../src/stt-match.ts';

const PLAN = ['metformin', 'amlodipine', 'levothyroxine'];

describe('matchPlanNames', () => {
  it.each([
    ['I gave her the met forming', 'I gave her the metformin', 'met forming'],
    ['she had her levo thyroxine.', 'she had her levothyroxine.', 'levo thyroxine'],
    ['am low dipine is done', 'amlodipine is done', 'am low dipine'],
    ['Metformen at eight', 'metformin at eight', 'Metformen'],
    ['the em-lowdipin is gone', 'the amlodipine is gone', 'em-lowdipin'],
    ['Amla deepen after lunch', 'amlodipine after lunch', 'Amla deepen'],
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

  it.each([
    'the metal pin fell',
    'for men only',
    'she felt fine',
    'I made a format',
    'my old pan is in the sink',
    'an old open window',
    'M-L sizes only',
    'a model pony',
  ])('does not invent a drug in "%s"', (line) => {
    expect(matchPlanNames(line, PLAN).corrections).toEqual([]);
  });

  it('only knows names from the plan', () => {
    expect(matchPlanNames('she took her ibuprofen', PLAN).corrections).toEqual([]);
    expect(matchPlanNames('she took her ibuprofin', ['ibuprofen']).text).toBe('she took her ibuprofen');
  });
});

describe('matchNote', () => {
  it('quotes the phrase without its punctuation and does not double the full stop', () => {
    const heard = "I'll give Mom her met foreman.";
    const r = matchPlanNames(heard, PLAN);
    expect(r.text).toBe("I'll give Mom her metformin.");
    expect(matchNote(heard, r.corrections)).toBe(
      'Heard "I\'ll give Mom her met foreman." Matched to the plan: "met foreman" as metformin.',
    );
  });

  it('adds the full stop inside the quotes when the transcript has none', () => {
    const heard = 'gave her the met forming';
    expect(matchNote(heard, matchPlanNames(heard, PLAN).corrections)).toBe(
      'Heard "gave her the met forming." Matched to the plan: "met forming" as metformin.',
    );
  });

  it('keeps a question mark and lists every phrase', () => {
    const heard = 'Did she get the met forming and am low dipine?';
    expect(matchNote(heard, matchPlanNames(heard, PLAN).corrections)).toBe(
      'Heard "Did she get the met forming and am low dipine?" Matched to the plan: "met forming" as metformin, "am low dipine" as amlodipine.',
    );
  });
});
