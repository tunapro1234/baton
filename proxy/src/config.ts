// Environment for the proxy. The key is read here and nowhere else; it is never logged.
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, PROXY_DEFAULT_PORT } from '@baton/contract';
import { defaultUsageFile } from './budget.ts';

export type ProxyConfig = {
  port: number;
  token: string;
  allowedOrigins: string[];
  apiKey: string;
  model: string;
  fixture: string;
  scriptsDir: string;
  budget: { file: string; dayCap: number; monthCap: number };
};

function usd(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number >= 0`);
  return n;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const port = Number(env.BATON_PROXY_PORT ?? PROXY_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`BATON_PROXY_PORT is not a port: ${env.BATON_PROXY_PORT}`);
  return {
    port,
    token: env.BATON_TOKEN ?? '',
    allowedOrigins: (env.BATON_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // The only read of the key: process.env.ANTHROPIC_API_KEY (through the env argument, which defaults to process.env).
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    // Default model is claude-haiku-5-5 (budget default); BATON_MODEL overrides it.
    model: env.BATON_MODEL || DEFAULT_MODEL,
    fixture: env.BATON_FIXTURE || 'june',
    scriptsDir: fileURLToPath(new URL('../../recorded_responses/', import.meta.url)),
    budget: {
      file: env.BATON_USAGE_FILE || defaultUsageFile(),
      dayCap: usd('BATON_BUDGET_USD_DAY', env.BATON_BUDGET_USD_DAY, 1),
      monthCap: usd('BATON_BUDGET_USD_MONTH', env.BATON_BUDGET_USD_MONTH, 8),
    },
  };
}
