import { configFromEnv } from './config.ts';
import { startApp } from './http.ts';

const cfg = configFromEnv();
const app = await startApp(cfg);
console.log(`Baton MCP server on ${app.url}/mcp (simulated clock ${app.ctx.clock.now()})`);

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0));
  });
}
