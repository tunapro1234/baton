// npm run check:voice: starts the Baton MCP server in memory on a free port, runs voice-ready-mcp
// against it with the read-only calls in voice-calls.json, and writes report.json at the repo root.
// The write tools ask the user through elicitation, so they stay out of the fixtures.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startApp } from '../server/src/http.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = await startApp({
  port: 0,
  db: ':memory:',
  now: process.env.BATON_NOW ?? '2026-10-20T08:00',
  fixture: 'june',
  token: '',
  allowedOrigins: ['http://127.0.0.1:5173'],
});

const args = ['--url', `${app.url}/mcp`, '--fixtures', 'scripts/voice-calls.json', '--json', 'report.json', ...process.argv.slice(2)];
const child = spawn(process.execPath, [`${root}node_modules/voice-ready-mcp/dist/cli.js`, ...args], { cwd: root, stdio: 'inherit' });
const code: number = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)));
await app.close();
process.exit(code);
