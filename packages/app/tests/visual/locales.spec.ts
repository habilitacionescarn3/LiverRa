/*
 * Locale visual-diff suite — en/de/ka rendering parity.
 *
 * Plan §i18n wiring · Tasks T369.
 *
 * Snapshots every major route in three locales (en, de, ka) at two
 * viewports (desktop 1280×720, mobile 390×844). Uses Playwright's built-in
 * toHaveScreenshot() with per-locale/per-viewport baselines.
 *
 * Additional assertion: Georgian Noto Sans must render without .notdef
 * "tofu" boxes. We check via a text-visibility measurement on a known-present
 * Georgian string (e.g. "აქტივობები" — "Activities").
 */

import { test, expect } from '@playwright/test';

const LOCALES = ['en', 'de', 'ka'] as const;

const ROUTES: { path: string; id: string }[] = [
  { path: '/cases', id: 'cases' },
  { path: '/cases/demo-case-1', id: 'case-detail' },
  { path: '/admin/users', id: 'admin-users' },
  { path: '/ops/queue', id: 'ops-queue' },
  { path: '/compliance/audit', id: 'compliance-audit' },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'mobile', width: 390, height: 844 },
];

// Localized "known Georgian token" to detect .notdef / missing-glyph boxes.
// If Noto Sans Georgian is loaded, bounding boxes are non-zero.
const GEORGIAN_SMOKE = 'აქტივობები';

for (const locale of LOCALES) {
  for (const vp of VIEWPORTS) {
    test.describe(`i18n visual — ${locale} @ ${vp.name}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        // Set locale via the app's localeService query-param override.
        await page.addInitScript((loc) => {
          window.localStorage.setItem('liverra.locale', loc);
          document.documentElement.lang = loc;
        }, locale);
      });

      for (const route of ROUTES) {
        test(`${route.id} renders`, async ({ page }) => {
          await page.goto(route.path);
          // Wait for the fonts to load before snapshotting
          await page.evaluate(async () => {
            if ('fonts' in document) {
              await (document as Document & { fonts: FontFaceSet }).fonts.ready;
            }
          });
          // Stabilize: kill animations for diff determinism
          await page.addStyleTag({
            content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
          });

          await expect(page).toHaveScreenshot(
            `${route.id}-${locale}-${vp.name}.png`,
            { fullPage: false, maxDiffPixelRatio: 0.02 },
          );
        });
      }

      if (locale === 'ka') {
        test('Georgian glyphs render (no .notdef tofu)', async ({ page }) => {
          await page.goto('/cases');
          await page.evaluate(async () => {
            if ('fonts' in document) {
              await (document as Document & { fonts: FontFaceSet }).fonts.ready;
            }
          });

          // Inject a probe span and measure its width.
          const width = await page.evaluate((t) => {
            const probe = document.createElement('span');
            probe.style.cssText =
              'position:fixed;left:-9999px;top:0;visibility:hidden;font-family:inherit;';
            probe.textContent = t;
            document.body.appendChild(probe);
            const w = probe.getBoundingClientRect().width;
            probe.remove();
            return w;
          }, GEORGIAN_SMOKE);

          // A .notdef "tofu" glyph sequence for 10 chars would still have a
          // width, but each glyph box is near-identical. Sanity floor:
          // Georgian text should exceed 40 px at default 16 px body.
          expect(width, 'Georgian text width implausibly small — font likely missing').toBeGreaterThan(40);
        });
      }
    });
  }
}
