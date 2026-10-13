// The public demo process (scripts/demo.ts): refuses a key, answers from recorded responses only,
// serves rooms and the assistant on one port, and marks every response noindex.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/demo.ts', import.meta.url));
const ORIGIN = 'http://127.0.0.1:5173';
const running: ChildProcess[] = [];

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, BATON_PORT: '0', BATON_ALLOWED_ORIGINS: ORIGIN };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function run(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; url?: string; code?: number; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    running.push(child);
    let err = '';
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.stdout!.on('data', (d: Buffer) => {
      const m = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(d.toString());
      if (m) resolve({ child, url: m[1], err });
    });
    child.on('exit', (code) => resolve({ child, code: code ?? -1, err }));
  });
}

afterEach(() => {
  for (const c of running.splice(0)) if (c.exitCode === null) c.kill('SIGTERM');
});

describe('demo service', () => {
  it('will not start with ANTHROPIC_API_KEY in the environment', async () => {
    const r = await run({ ...baseEnv(), ANTHROPIC_API_KEY: 'not-a-real-key' });
    expect(r.url).toBeUndefined();
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/recorded responses only/);
    expect(r.err).not.toContain('not-a-real-key');
  });

  it('answers in mock mode with both caps at 0, serves a room, and sends noindex everywhere', async () => {
    const r = await run(baseEnv());
    expect(r.url).toBeDefined();
    const health = await fetch(`${r.url}/assistant/healthz`);
    expect(health.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const h = (await health.json()) as { mode: string; budget: { dayCap: number; monthCap: number } };
    expect(h.mode).toBe('mock');
    expect(h.budget).toMatchObject({ dayCap: 0, monthCap: 0 });

    const turn = await fetch(`${r.url}/assistant/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'What is the capital of France?' }], tools: [] }),
    });
    expect(turn.status).toBe(200);
    expect(((await turn.json()) as { mode: string }).mode).toBe('mock');

    const clock = await fetch(`${r.url}/r/aaaaaaaaaaaa1111/clock`, { headers: { Origin: ORIGIN } });
    expect(clock.status).toBe(200);
    expect(clock.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const missing = await fetch(`${r.url}/mcp`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});
