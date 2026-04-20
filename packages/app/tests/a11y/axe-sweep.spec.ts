/*
 * axe-core route-level sweep — WCAG 2.1 AA blocker.
 *
 * Plan §Accessibility matrix · Tasks T371 · Spec §NFR-002.
 *
 * Runs @axe-core/playwright against every addressable route in BOTH the
 * light and dark color schemes. Any "critical" or "serious" violation fails
 * the build; "moderate" is reported but does not block.
 *
 * Per-component ARIA matrix assertions live in T465
 * (`component-aria.spec.ts`). This file is the route-level sweep.
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ROUTES: string[] = [
  '/',
  '/cases',
  '/cases/demo-case-1',
  '/admin/users',
  '/admin/pacs',
  '/ops/queue',
  '/compliance/audit',
  '/compliance/claim-registry',
  '/gdpr',
  '/settings',
];

const SCHEMES: ('light' | 'dark')[] = ['light', 'dark'];

// WCAG 2.1 AA = wcag2a + wcag2aa + wcag21a + wcag21aa
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const scheme of SCHEMES) {
  test.describe(`axe-core sweep — ${scheme} mode`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript((s) => {
        document.documentElement.setAttribute('data-mantine-color-scheme', s);
      }, scheme);
    });

    for (const route of ROUTES) {
      test(`no WCAG 2.1 AA violations on ${route}`, async ({ page }) => {
        await page.goto(route);
        await page.waitForLoadState('networkidle');

        const results = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          // Exclude cornerstone's WebGL canvas — axe cannot meaningfully
          // inspect raster medical pixel data; that route is covered by
          // the keyboard-nav test (T458).
          .exclude('[data-testid="cornerstone-viewport"]')
          .exclude('[data-testid="liver-viewer-3d-canvas"]')
          .analyze();

        const blocking = results.violations.filter(
          (v) => v.impact === 'critical' || v.impact === 'serious',
        );

        if (blocking.length > 0) {
          const summary = blocking
            .map(
              (v) =>
                `${v.id} [${v.impact}] — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`,
            )
            .join('\n');
          throw new Error(
            `${blocking.length} blocking WCAG 2.1 AA violation(s) on ${route} (${scheme}):\n${summary}`,
          );
        }

        // Non-blocking: report moderate issues as test annotations
        const moderate = results.violations.filter(
          (v) => v.impact === 'moderate' || v.impact === 'minor',
        );
        if (moderate.length > 0) {
          test.info().annotations.push({
            type: 'a11y-warn',
            description: `${moderate.length} moderate/minor violation(s) on ${route}`,
          });
        }

        expect(blocking).toEqual([]);
      });
    }
  });
}
