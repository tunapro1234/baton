// Spend counter for live calls. It guards real money, so it is the one place that reads the wall clock:
// the day and the month that reset the counters come from the real date.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export type BudgetState = { day: string; dayUsd: number; month: string; monthUsd: number };

export type BudgetOptions = {
  file: string;
  dayCap: number;
  monthCap: number;
  /** Test hook. Production uses the real clock. */
  clock?: () => Date;
};

// USD per million tokens. Prompts over 100K tokens are priced in the higher tier.
const LARGE_PROMPT_TOKENS = 100_000;
const SMALL = { input: 0.1, output: 0.5 };
const LARGE = { input: 0.5, output: 2.5 };

/**
 * Cost of one response. Cache writes are charged at 1.25 x the input price and cache reads at 1 x.
 * The real cache-read price is lower, so this overestimates on purpose: the cap can only trip early.
 */
export function costUsd(u: Usage): number {
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const prompt = u.input_tokens + cacheWrite + cacheRead;
  const price = prompt > LARGE_PROMPT_TOKENS ? LARGE : SMALL;
  const inputEquivalent = u.input_tokens + 1.25 * cacheWrite + cacheRead;
  return (inputEquivalent * price.input + u.output_tokens * price.output) / 1_000_000;
}

export function defaultUsageFile(): string {
  return fileURLToPath(new URL('../../.baton/usage.json', import.meta.url));
}

function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export class Budget {
  private readonly file: string;
  private readonly dayCap: number;
  private readonly monthCap: number;
  private readonly clock: () => Date;

  constructor(opts: BudgetOptions) {
    this.file = opts.file;
    this.dayCap = opts.dayCap;
    this.monthCap = opts.monthCap;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Current counters with the day and month rollover applied. Reads the file; does not write it. */
  snapshot(): BudgetState {
    const now = this.clock();
    const day = dayOf(now);
    const month = monthOf(now);
    let raw: Partial<BudgetState> = {};
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BudgetState>;
    } catch {
      raw = {};
    }
    return {
      day,
      dayUsd: raw.day === day ? num(raw.dayUsd) : 0,
      month,
      monthUsd: raw.month === month ? num(raw.monthUsd) : 0,
    };
  }

  canSpend(): boolean {
    const s = this.snapshot();
    return s.dayUsd < this.dayCap && s.monthUsd < this.monthCap;
  }

  /** Adds the cost of one response to both counters and writes the file. */
  record(usage: Usage): number {
    const cost = costUsd(usage);
    const s = this.snapshot();
    const next: BudgetState = { ...s, dayUsd: s.dayUsd + cost, monthUsd: s.monthUsd + cost };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, this.file);
    return cost;
  }

  caps(): { dayCap: number; monthCap: number } {
    return { dayCap: this.dayCap, monthCap: this.monthCap };
  }
}
