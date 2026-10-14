import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// The demo video shoot: the same mock setup as playwright.config.ts on its own ports, recorded at 1920x1080.
// Caregiver lines are synthetic clips played into the microphone input (see e2e-video/mic.ts); recognition
// is the page's own Whisper. Not part of npm run e2e: npm run e2e:video, one run per shoot.
const SERVER = 37331;
const HOST = 37332;
const PROXY = 37334;
const repo = fileURLToPath(new URL('..', import.meta.url));
const size = { width: 1920, height: 1080 };

export default defineConfig({
  testDir: './e2e-video',
  outputDir: './test-results/video',
  workers: 1,
  // A shoot is long (model load, seven recognitions on CPU) and the build machine freezes hot jobs.
  timeout: 1_200_000,
  retries: 0,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${HOST}`,
    trace: 'off',
    screenshot: 'off',
    video: { mode: 'on', size },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: size,
        deviceScaleFactor: 1,
        launchOptions: { args: ['--disable-gpu', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] },
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
