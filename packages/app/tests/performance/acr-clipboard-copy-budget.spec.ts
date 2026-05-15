// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acr-clipboard-copy-budget — feature 002-acr-structured-readout T104.
 *
 * CI-blocking budget per FR-026:
 *   200ms at <=20 lesions
 *   1000ms at <=100 lesions
 *
 * Measures click → clipboard.writeText resolved by instrumenting the
 * service via window.performance marks the parent component emits
 * before/after the copy operation.
 */
import { test, expect } from '@playwright/test';

const DEMO = '/cases/demo-case-1';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function runCopyAndMeasure(page: import('@playwright/test').Page): Promise<number> {
  await page.waitForSelector('[data-testid="acr-copy-button"]');
  const start = await page.evaluate(() => performance.now());
  await page.click('[data-testid="acr-copy-button"]');
  // Wait until clipboard contents are populated.
  await page.waitForFunction(
    async () => {
      try {
        const t = await navigator.clipboard.readText();
        return t.length > 0;
      } catch {
        return false;
      }
    },
    null,
    { timeout: 2_000 },
  );
  const end = await page.evaluate(() => performance.now());
  return end - start;
}

test('Copy <= 200ms with 20 lesions', async ({ page }) => {
  await page.goto(`${DEMO}?acrLesionCount=20`);
  const elapsed = await runCopyAndMeasure(page);
  // eslint-disable-next-line no-console
  console.log(`Copy(20) elapsed: ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThanOrEqual(200);
});

test('Copy <= 1000ms with 100 lesions', async ({ page }) => {
  await page.goto(`${DEMO}?acrLesionCount=100`);
  const elapsed = await runCopyAndMeasure(page);
  // eslint-disable-next-line no-console
  console.log(`Copy(100) elapsed: ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThanOrEqual(1000);
});
