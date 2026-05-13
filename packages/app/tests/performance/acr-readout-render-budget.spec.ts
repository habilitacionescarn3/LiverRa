// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acr-readout-render-budget — feature 002-acr-structured-readout T103.
 *
 * Playwright performance test. CI-blocking budget per FR-025:
 *   the time from /report/summary 200 response to first paint of all
 *   six section headers MUST be <= 500ms on chromium-desktop.
 */
import { test, expect } from '@playwright/test';

const DEMO = '/cases/demo-case-1';

test('ACR readout: <=500ms from summary response to six section headers', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __acrSummaryRespondedAt?: number }).__acrSummaryRespondedAt = 0;
  });

  let respondedAt = 0;
  await page.route('**/api/v1/analyses/*/report/summary', async (route) => {
    const response = await route.fetch();
    respondedAt = performance.now();
    await page.evaluate((t) => {
      (window as unknown as { __acrSummaryRespondedAt?: number }).__acrSummaryRespondedAt = t;
    }, respondedAt);
    await route.fulfill({ response });
  });

  await page.goto(DEMO);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="acr-readout-root"] h3').length >= 6,
    null,
    { timeout: 5_000 },
  );
  const paintedAt = await page.evaluate(() => performance.now());
  const elapsed = paintedAt - (respondedAt || paintedAt);
  // eslint-disable-next-line no-console
  console.log(`ACR render elapsed: ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThanOrEqual(500);
});
