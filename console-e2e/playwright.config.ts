import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, PORT } from './harness/env.js';

/**
 * The console, driven in a real browser against the REAL server serving the REAL built console at
 * one origin (SHP-T-6.2) — what ships, not a Vite dev server. `harness/serve.mjs` builds, migrates
 * the `_test` database and starts the server; `harness/global-setup.ts` seeds the baseline and
 * signs each role in once. See README.md.
 */
const external = process.env['SHIPYARD_URL'] !== undefined;

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  globalSetup: './harness/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Against a server someone else started (SHIPYARD_URL), start nothing.
  ...(external
    ? {}
    : {
        webServer: {
          command: 'node harness/serve.mjs',
          url: `${BASE_URL}/api/health`,
          env: { SHIPYARD_PORT: String(PORT) },
          reuseExistingServer: false,
          timeout: 300_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      }),
});
