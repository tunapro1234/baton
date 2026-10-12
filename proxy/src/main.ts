import { configFromEnv } from './config.ts';
import { startProxy } from './server.ts';

const cfg = configFromEnv();
const app = await startProxy(cfg);
// Print the mode only. The key is never printed.
console.log(`Baton assistant proxy on ${app.url} (mode: ${cfg.apiKey ? 'live' : 'mock'})`);

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0));
  });
}
