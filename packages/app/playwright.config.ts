/**
 * Playwright config for LiverRa app E2E tests.
 *
 * Scope: Phase 3 User Story smoke tests under `src/emr/views/__e2e__/`.
 * These tests are self-contained: they stub all `/api/v1/*` routes via
 * `helpers/mock-backend.ts`. No real backend, Triton, or PACS is required —
 * Vite is the only process we boot.
 *
 * Viewport matrix (per CLAUDE.md mobile-first rule + task T192 guidance):
 *   - chromium-desktop: 1280×720 (primary surgeon workstation target)
 *   - chromium-mobile:  360×640  (ward/tablet — skipped per-test when the
 *                                 view uses WebGPU which headless CI can't
 *                                 always satisfy)
 *
 * CI-friendly defaults: 2 retries on CI, zero retries locally, HTML reporter.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.LIVERRA_E2E_PORT ?? 5173);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './src/emr/views/__e2e__',
  testMatch: /test-.*\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 6 * 60 * 1000, // SC-002 allows up to 5 min for FLR; +60s slack.
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 360, height: 640 },
      },
    },
  ],

  webServer: {
    command: `npx vite --port ${PORT}`,
    url: BASE_URL,
    cwd: '.',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
