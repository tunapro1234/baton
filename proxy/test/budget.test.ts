import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Budget, costUsd } from '../src/budget.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'baton-budget-'));
  file = join(dir, 'usage.json');
});
afterEach(() => {
  // The temp directory is left for the OS; tests keep no state between runs.
});

const at = (iso: string) => () => new Date(iso);

describe('costUsd', () => {
  it('prices a small prompt at 0.10 in and 0.50 out per million tokens', () => {
    expect(costUsd({ input_tokens: 1000, output_tokens: 100 })).toBeCloseTo(0.00015, 10);
  });

  it('prices prompts over 100K tokens at the higher tier', () => {
    expect(costUsd({ input_tokens: 200_000, output_tokens: 1000 })).toBeCloseTo(0.1025, 10);
  });

  it('charges cache writes at 1.25 x input and cache reads at 1 x input', () => {
    // prompt 3100 tokens (small tier): 100 + 1.25 * 1000 + 2000 = 3350 input-equivalent tokens.
    expect(costUsd({ input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000 })).toBeCloseTo(0.000335, 10);
  });

  it('treats missing cache fields as zero', () => {
    expect(costUsd({ input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: null })).toBeCloseTo(0.000006, 10);
  });
});

describe('Budget', () => {
  it('records cost into both counters and persists them', () => {
    const b = new Budget({ file, dayCap: 1, monthCap: 8, clock: at('2026-10-12T10:00:00Z') });
    b.record({ input_tokens: 1000, output_tokens: 100 });
    b.record({ input_tokens: 1000, output_tokens: 100 });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.day).toBe('2026-10-12');
    expect(saved.month).toBe('2026-10');
    expect(saved.dayUsd).toBeCloseTo(0.0003, 10);
    expect(saved.monthUsd).toBeCloseTo(0.0003, 10);
  });

  it('resets the day counter on a new day and keeps the month', () => {
    const day1 = new Budget({ file, dayCap: 1, monthCap: 8, clock: at('2026-10-12T23:00:00Z') });
    day1.record({ input_tokens: 1000, output_tokens: 100 });
    const day2 = new Budget({ file, dayCap: 1, monthCap: 8, clock: at('2026-10-13T01:00:00Z') });
    const s = day2.snapshot();
    expect(s.day).toBe('2026-10-13');
    expect(s.dayUsd).toBe(0);
    expect(s.monthUsd).toBeCloseTo(0.00015, 10);
  });

  it('resets the month counter on a new month', () => {
    writeFileSync(file, JSON.stringify({ day: '2026-09-30', dayUsd: 0.5, month: '2026-09', monthUsd: 7.5 }));
    const b = new Budget({ file, dayCap: 1, monthCap: 8, clock: at('2026-10-01T09:00:00Z') });
    const s = b.snapshot();
    expect(s.dayUsd).toBe(0);
    expect(s.monthUsd).toBe(0);
    expect(b.canSpend()).toBe(true);
  });

  it('ignores a missing or broken usage file', () => {
    writeFileSync(file, '{not json');
    const b = new Budget({ file, dayCap: 1, monthCap: 8, clock: at('2026-10-12T10:00:00Z') });
    expect(b.snapshot()).toMatchObject({ dayUsd: 0, monthUsd: 0 });
  });

  it('stops spending when the day cap is reached', () => {
    const b = new Budget({ file, dayCap: 0.0002, monthCap: 8, clock: at('2026-10-12T10:00:00Z') });
    expect(b.canSpend()).toBe(true);
    b.record({ input_tokens: 1000, output_tokens: 100 });
    expect(b.canSpend()).toBe(true);
    b.record({ input_tokens: 1000, output_tokens: 100 });
    expect(b.canSpend()).toBe(false);
  });

  it('stops spending when the month cap is reached', () => {
    const b = new Budget({ file, dayCap: 1, monthCap: 0.0001, clock: at('2026-10-12T10:00:00Z') });
    b.record({ input_tokens: 1000, output_tokens: 100 });
    expect(b.canSpend()).toBe(false);
  });

  it('with both caps at zero, spends nothing', () => {
    const b = new Budget({ file, dayCap: 0, monthCap: 0, clock: at('2026-10-12T10:00:00Z') });
    expect(b.canSpend()).toBe(false);
  });
});
