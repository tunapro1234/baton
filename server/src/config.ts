// Environment variables, with the defaults the README documents.
export type Config = {
  port: number;
  db: string;
  now?: string;
  fixture: string;
  token: string;
  allowedOrigins: string[];
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.BATON_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`BATON_PORT is not a port: ${env.BATON_PORT}`);
  return {
    port,
    db: env.BATON_DB || './baton.db',
    ...(env.BATON_NOW ? { now: env.BATON_NOW } : {}),
    fixture: env.BATON_FIXTURE || 'june',
    token: env.BATON_TOKEN ?? '',
    allowedOrigins: (env.BATON_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
