import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Ports chosen away from the defaults so a running dev setup is never touched.
const SERVER = 37311;
const HOST = 37312;
const PROXY = 37314;
const repo = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  // The build machine runs these under a CPU quota and freezes hot jobs. The wall clock keeps running
  // through a freeze, so waits are generous and a test gets one retry (Playwright reports it as flaky).
  timeout: 120_000,
  retries: 1,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${HOST}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
        // Server rule: no GPU, software ANGLE.
        launchOptions: { args: ['--disable-gpu', '--use-angle=swiftshader'] },
      },
    },
  ],
  webServer: [
    {
      command: 'npm start -w server',
      cwd: repo,
      url: `http://127.0.0.1:${SERVER}/healthz`,
      reuseExistingServer: false,
      env: {
        BATON_PORT: String(SERVER),
        BATON_DB: ':memory:',
        BATON_NOW: '2026-10-20T08:00:00',
        BATON_TOKEN: '',
        BATON_ALLOWED_ORIGINS: `http://127.0.0.1:${HOST}`,
      },
    },
    {
      // Mock mode only: the key is blanked, so every assistant turn is a recorded response.
      command: 'npm start -w proxy',
      cwd: repo,
      url: `http://127.0.0.1:${PROXY}/healthz`,
      reuseExistingServer: false,
      env: {
        ANTHROPIC_API_KEY: '',
        BATON_PROXY_PORT: String(PROXY),
        BATON_TOKEN: '',
        BATON_ALLOWED_ORIGINS: `http://127.0.0.1:${HOST}`,
      },
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${HOST} --strictPort`,
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      url: `http://127.0.0.1:${HOST}`,
      reuseExistingServer: false,
      env: {
        VITE_BATON_SERVER: `http://127.0.0.1:${SERVER}`,
        BATON_HOST_NO_WATCH: '1',
        VITE_BATON_PROXY: `http://127.0.0.1:${PROXY}`,
      },
    },
  ],
});
