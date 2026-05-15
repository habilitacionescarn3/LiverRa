// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acr-readout-locale-theme-matrix — feature 002-acr-structured-readout T102.
 *
 * Playwright visual regression. Full matrix is 4 locales × 2 themes ×
 * 2 viewports × 4 states = 128 screenshots. Only the EN × light ×
 * 1280×720 × 4-state subset is run in the release-blocking step
 * (8 screenshots). Nightly runs the full matrix.
 *
 * To run release-blocking subset locally: `npx playwright test --project=chromium-desktop acr-readout-locale-theme-matrix`.
 */
import { expect, test } from '@playwright/test';

type Locale = 'en' | 'de' | 'ka' | 'ru';
type Scheme = 'light' | 'dark';
type Viewport = { width: number; height: number; name: string };
type State = 'complete' | 'no-lesions' | 'degraded' | 'computing';

const RELEASE_BLOCKING = process.env.LIVERRA_VISUAL_RELEASE === '1';
const LOCALES: Locale[] = RELEASE_BLOCKING ? ['en'] : ['en', 'de', 'ka', 'ru'];
const SCHEMES: Scheme[] = RELEASE_BLOCKING ? ['light'] : ['light', 'dark'];
const VIEWPORTS: Viewport[] = RELEASE_BLOCKING
  ? [{ width: 1280, height: 720, name: 'desktop' }]
  : [
      { width: 1280, height: 720, name: 'desktop' },
      { width: 360, height: 640, name: 'mobile' },
    ];
const STATES: State[] = ['complete', 'no-lesions', 'degraded', 'computing'];

const DEMO = '/cases/demo-case-1';

for (const locale of LOCALES) {
  for (const scheme of SCHEMES) {
    for (const vp of VIEWPORTS) {
      for (const state of STATES) {
        test(`${locale}/${scheme}/${vp.name}/${state}`, async ({ page }) => {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.emulateMedia({ colorScheme: scheme });
          await page.addInitScript(
            ([s, lc]: [string, string]) => {
              document.documentElement.setAttribute('data-mantine-color-scheme', s);
              localStorage.setItem('liverra:locale', lc);
            },
            [scheme, locale],
          );
          // State control: query-string convention picked up by mock backend.
          await page.goto(`${DEMO}?acrState=${state}`);
          await page.waitForSelector('[data-testid="acr-readout-root"]', { timeout: 15_000 });
          await page.waitForLoadState('networkidle');
          const root = page.locator('[data-testid="acr-readout-root"]');
          await expect(root).toHaveScreenshot(
            `acr-${locale}-${scheme}-${vp.name}-${state}.png`,
            { maxDiffPixelRatio: 0.01 },
          );
        });
      }
    }
  }
}
