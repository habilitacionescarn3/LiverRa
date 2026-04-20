/*
 * Keyboard-only a11y — LiverViewer3D + ResectionPlaneTool (NFR-002 WCAG 2.1 AA).
 *
 * Tasks T458.
 *
 * Scenarios:
 *   1. Tab focuses the 3D viewer → Arrow keys rotate, +/- zoom, L toggles layers.
 *   2. Tab focuses the ResectionPlaneTool slider → Left/Right nudges ±1 mm,
 *      PageUp/PageDown nudges ±10 mm.
 *   3. `aria-valuenow` updates on every nudge.
 *   4. The live region (role="status") announces the new value in plain language.
 *
 * No mouse events are issued. Entire flow via `page.keyboard.*` only.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';

async function focusByTabUntil(page: Page, locator: Locator, maxTabs = 50): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    const active = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    const expected = await locator.getAttribute('data-testid');
    if (active === expected) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Could not tab-focus ${await locator.getAttribute('data-testid')} within ${maxTabs} tabs`);
}

test.describe('LiverViewer3D keyboard navigation (NFR-002)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/cases/demo-case-1');
    await page.waitForSelector('[data-testid="liver-viewer-3d-canvas"]');
  });

  test('Tab to viewer, arrow rotates, camera azimuth state changes', async ({ page }) => {
    const viewer = page.getByTestId('liver-viewer-3d-canvas');
    await focusByTabUntil(page, viewer);

    const azimuthBefore = await viewer.getAttribute('data-camera-azimuth');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const azimuthAfter = await viewer.getAttribute('data-camera-azimuth');

    expect(azimuthAfter, 'data-camera-azimuth must update on arrow rotation').not.toBe(azimuthBefore);
  });

  test('+/- zoom adjusts camera distance', async ({ page }) => {
    const viewer = page.getByTestId('liver-viewer-3d-canvas');
    await focusByTabUntil(page, viewer);

    const zoomBefore = Number(await viewer.getAttribute('data-camera-distance'));
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    const zoomAfter = Number(await viewer.getAttribute('data-camera-distance'));
    expect(zoomAfter).toBeLessThan(zoomBefore);

    await page.keyboard.press('-');
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    const zoomRestored = Number(await viewer.getAttribute('data-camera-distance'));
    expect(zoomRestored).toBeGreaterThan(zoomAfter);
  });

  test('L toggles layer visibility', async ({ page }) => {
    const viewer = page.getByTestId('liver-viewer-3d-canvas');
    await focusByTabUntil(page, viewer);

    const visibleBefore = await viewer.getAttribute('data-layers-visible');
    await page.keyboard.press('l');
    const visibleAfter = await viewer.getAttribute('data-layers-visible');
    expect(visibleAfter).not.toBe(visibleBefore);
  });
});

test.describe('ResectionPlaneTool keyboard navigation (NFR-002)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/cases/demo-case-1?tool=resection-plane');
    await page.waitForSelector('[data-testid="resection-plane-slider"]');
  });

  test('ArrowLeft/Right nudges ±1 mm, aria-valuenow updates, live region announces', async ({ page }) => {
    const slider = page.getByTestId('resection-plane-slider');
    const live = page.locator('[role="status"]');

    await focusByTabUntil(page, slider);
    const valueBefore = Number(await slider.getAttribute('aria-valuenow'));

    await page.keyboard.press('ArrowRight');
    const afterOne = Number(await slider.getAttribute('aria-valuenow'));
    expect(afterOne, '1 mm nudge expected').toBe(valueBefore + 1);

    await page.keyboard.press('ArrowLeft');
    const back = Number(await slider.getAttribute('aria-valuenow'));
    expect(back).toBe(valueBefore);

    // Live region must announce at least once (assertive / polite status)
    const liveText = await live.innerText();
    expect(liveText.length, 'Live region should announce slider value change').toBeGreaterThan(0);
  });

  test('PageUp/PageDown nudges ±10 mm', async ({ page }) => {
    const slider = page.getByTestId('resection-plane-slider');
    await focusByTabUntil(page, slider);
    const valueBefore = Number(await slider.getAttribute('aria-valuenow'));

    await page.keyboard.press('PageUp');
    const afterPgUp = Number(await slider.getAttribute('aria-valuenow'));
    expect(afterPgUp - valueBefore, 'PageUp should add 10').toBe(10);

    await page.keyboard.press('PageDown');
    const afterPgDn = Number(await slider.getAttribute('aria-valuenow'));
    expect(afterPgDn).toBe(valueBefore);
  });
});
