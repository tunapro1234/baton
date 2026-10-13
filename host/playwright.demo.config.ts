import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// The public demo setup end to end: the demo build (npm run build:demo) served by vite preview,
// which forwards /r/ and /assistant/ to the demo service the way the reverse proxy does.
const DEMO = 37321;
const HOST = 37322;
const repo = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './e2e-demo',
  workers: 1,
  // Same reasons as playwright.config.ts: a CPU quota and freezes on the build machine.
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
        launchOptions: { args: ['--disable-gpu', '--use-angle=swiftshader'] },
      },
    },
  ],
  webServer: [
    {
      command: 'npm run demo',
      cwd: repo,
      url: `http://127.0.0.1:${DEMO}/healthz`,
      reuseExistingServer: false,
      env: {
        BATON_PORT: String(DEMO),
        BATON_NOW: '2026-10-20T08:00:00',
        BATON_ALLOWED_ORIGINS: `http://127.0.0.1:${HOST}`,
      },
    },
    {
      command: `npm run build:demo && npx vite preview --outDir dist-demo --port ${HOST} --strictPort`,
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      url: `http://127.0.0.1:${HOST}`,
      reuseExistingServer: false,
      timeout: 600_000,
      env: { BATON_DEMO_UPSTREAM: `http://127.0.0.1:${DEMO}` },
    },
  ],
});
