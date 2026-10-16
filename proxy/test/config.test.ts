import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, PROXY_DEFAULT_PORT } from '@baton/contract';
import { configFromEnv } from '../src/config.ts';
import { buildSystemPrompt, planLineFor } from '../src/system-prompt.ts';
import { loadFixture, NOT_A_MEDICAL_DEVICE, FIXED, SPOKEN } from '@baton/contract';

describe('configFromEnv', () => {
  it('uses the documented defaults', () => {
    const c = configFromEnv({});
    expect(c.port).toBe(PROXY_DEFAULT_PORT);
    expect(c.model).toBe(DEFAULT_MODEL);
    expect(c.apiKey).toBe('');
    expect(c.budget.dayCap).toBe(1);
    expect(c.budget.monthCap).toBe(8);
    expect(c.budget.file).toMatch(/\.baton[\\/]usage\.json$/);
  });

  it('reads the budget caps and the model from the environment', () => {
    const c = configFromEnv({ BATON_BUDGET_USD_DAY: '0.5', BATON_BUDGET_USD_MONTH: '3', BATON_MODEL: 'claude-opus-5-5', BATON_USAGE_FILE: '/x/u.json' });
    expect(c.budget).toEqual({ file: '/x/u.json', dayCap: 0.5, monthCap: 3 });
    expect(c.model).toBe('claude-opus-5-5');
  });

  it('refuses a cap that is not a number', () => {
    expect(() => configFromEnv({ BATON_BUDGET_USD_DAY: 'lots' })).toThrow(/BATON_BUDGET_USD_DAY/);
  });
});

describe('system prompt', () => {
  const fx = loadFixture('june');
  const prompt = buildSystemPrompt(fx, { memberId: 'aylin', now: '2026-10-20T08:00:00' });

  it('carries the medical-device sentence and the fixed replies word for word', () => {
    expect(prompt).toContain(NOT_A_MEDICAL_DEVICE);
    expect(prompt).toContain(FIXED.symptomQuestion('Dr. Lee'));
    expect(prompt).toContain(FIXED.symptomReport('Dr. Lee'));
    expect(prompt).toContain(FIXED.emergency);
  });

  it('ties the symptom report sentence to a successful log_observation and uses the question one otherwise', () => {
    const question = prompt.split('\n').find((l) => l.includes('symptom question'));
    const report = prompt.split('\n').find((l) => l.includes('symptom report'));
    expect(question).toContain(FIXED.symptomQuestion('Dr. Lee'));
    expect(question).not.toContain(FIXED.symptomReport('Dr. Lee'));
    expect(report).toContain('log_observation');
    expect(report).toMatch(/Only after it succeeds/);
    const quiet = buildSystemPrompt(fx, { screen: false });
    expect(quiet).toContain(SPOKEN.symptomQuestion('Dr. Lee'));
    expect(quiet).toContain(SPOKEN.symptomReport('Dr. Lee'));
    expect(quiet).not.toContain(FIXED.symptomReport('Dr. Lee'));
  });

  it('lists the plan and members from the fixture, and never the log', () => {
    expect(prompt).toContain('metformin: Metformin 500 mg');
    expect(prompt).toContain('sam: Sam');
    expect(prompt).not.toContain('gave mom her morning pills');
  });

  it('builds plan lines from the plan item and its windows', () => {
    expect(planLineFor(fx, 'How much metformin should I give her?')).toBe('Metformin 500 mg, morning and evening');
  });
});
