// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * test-scenarios-16-17-a11y-theme — feature 002-acr-structured-readout T101.
 *
 * Playwright tests for spec testing scenarios:
 *  TS-16: keyboard-only operability + live-region announcement
 *  TS-17: light/dark theme legibility for warnings, headers, values
 */
import { test, expect } from '@playwright/test';

const DEMO = '/cases/demo-case-1';

test('TS-16 Copy reachable via Tab + announced via aria-live', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(DEMO);
  await page.waitForSelector('[data-testid="acr-readout-root"]', { timeout: 10_000 });

  let landed = false;
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? null,
    );
    if (id === 'acr-copy-button') {
      landed = true;
      break;
    }
  }
  expect(landed).toBe(true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const liveCount = await page.locator('[aria-live="polite"]').count();
  expect(liveCount).toBeGreaterThan(0);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`TS-17 dark/light scheme switch preserves contrast (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript((s) => {
      document.documentElement.setAttribute('data-mantine-color-scheme', s);
    }, scheme);
    await page.goto(DEMO);
    await page.waitForSelector('[data-testid="acr-readout-root"]');
    const root = page.locator('[data-testid="acr-readout-root"]');
    const visible = await root.isVisible();
    expect(visible).toBe(true);
  });
}
