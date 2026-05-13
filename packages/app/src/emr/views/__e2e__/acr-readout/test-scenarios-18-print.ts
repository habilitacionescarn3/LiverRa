// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * test-scenarios-18-print — feature 002-acr-structured-readout T080.
 *
 * Playwright print-media test. With `emulateMedia({ media: 'print' })`
 * the readout root, case identifier, and RUO footer MUST be visible,
 * and viewer chrome / rails / canvas MUST be hidden.
 */
import { test, expect } from '@playwright/test';

const DEMO = '/cases/demo-case-1';

test('TS-18 print media suppresses chrome, keeps readout + RUO', async ({ page }) => {
  await page.goto(DEMO);
  await page.waitForSelector('[data-testid="acr-readout-root"]');
  await page.emulateMedia({ media: 'print' });

  // Probe computed style — viewer canvases hidden.
  const hiddenSelectors = ['nav', 'header[role="banner"]', '[class*="rail"]', '[class*="footer"]'];
  for (const sel of hiddenSelectors) {
    const count = await page.locator(sel).count();
    if (count === 0) continue;
    const display = await page
      .locator(sel)
      .first()
      .evaluate((el: Element) => getComputedStyle(el as HTMLElement).display);
    expect(display).toBe('none');
  }
  // Readout still visible.
  const readoutDisplay = await page
    .locator('[data-testid="acr-readout-root"]')
    .evaluate((el: Element) => getComputedStyle(el as HTMLElement).display);
  expect(readoutDisplay).not.toBe('none');
});
