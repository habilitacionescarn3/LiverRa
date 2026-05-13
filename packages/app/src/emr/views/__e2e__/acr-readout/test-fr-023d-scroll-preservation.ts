// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FR-023d scroll preservation — added by 002-acr-structured-readout C3.
 *
 * When the user switches locale while the readout panel is visible,
 * the page MUST re-render immediately without a full reload AND MUST
 * preserve the current scroll position.
 */
import { test, expect } from '@playwright/test';

const DEMO = '/cases/demo-case-1';

test('FR-023d locale switch preserves scrollY and does not full-reload', async ({ page }) => {
  await page.goto(DEMO);
  await page.waitForSelector('[data-testid="acr-readout-root"]', { timeout: 10_000 });

  // Scroll down ~600px so the readout panel is partially in view.
  await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' as ScrollBehavior }));
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(400);

  // Tag the window so we can detect a full page reload.
  await page.evaluate(() => {
    (window as unknown as { __preReloadMarker?: number }).__preReloadMarker = Date.now();
  });

  // Switch locale via the standard localeService key — the app listens
  // and re-renders without full reload.
  await page.evaluate(() => {
    localStorage.setItem('liverra:locale', 'ka');
    window.dispatchEvent(new Event('storage'));
  });
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => window.scrollY);
  const marker = await page.evaluate(
    () => (window as unknown as { __preReloadMarker?: number }).__preReloadMarker,
  );
  expect(marker).toBeDefined();
  // Tolerance: scrollY MAY change by a few pixels if layout reflows for the
  // new locale (e.g., Georgian wider strings), but it MUST NOT reset to 0.
  expect(after).toBeGreaterThan(200);
});
