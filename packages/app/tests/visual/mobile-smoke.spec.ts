/*
 * Mobile-smoke — every route at 390×844 (iPhone 12/13/14 Pro base), no
 * horizontal scroll allowed.
 *
 * Plan §Accessibility matrix · Tasks T370 · CLAUDE.md mobile-first rule.
 *
 * A horizontal scrollbar at 390 px indicates a flexbox overflow — usually
 * fixed-width chips, un-truncated long strings, or missing `minWidth: 0`
 * on a flex child (per the project's "Flexbox Text Overflow" CRITICAL rule).
 */

import { test, expect } from '@playwright/test';

const ROUTES: { path: string; id: string }[] = [
  { path: '/', id: 'root' },
  { path: '/cases', id: 'cases' },
  { path: '/cases/demo-case-1', id: 'case-detail' },
  { path: '/admin/users', id: 'admin-users' },
  { path: '/admin/pacs', id: 'admin-pacs' },
  { path: '/ops/queue', id: 'ops-queue' },
  { path: '/compliance/audit', id: 'compliance-audit' },
  { path: '/compliance/claim-registry', id: 'compliance-claim-registry' },
  { path: '/gdpr', id: 'gdpr' },
  { path: '/settings', id: 'settings' },
];

test.describe('Mobile smoke @ 390×844', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  for (const route of ROUTES) {
    test(`${route.id} has no horizontal scrollbar`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState('networkidle');

      const overflow = await page.evaluate(() => {
        const html = document.documentElement;
        const body = document.body;
        return {
          hClientWidth: html.clientWidth,
          hScrollWidth: html.scrollWidth,
          bScrollWidth: body.scrollWidth,
          offenders: Array.from(document.querySelectorAll<HTMLElement>('*'))
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.right > html.clientWidth + 1;
            })
            .slice(0, 5)
            .map((el) => ({
              tag: el.tagName,
              cls: el.className,
              right: el.getBoundingClientRect().right,
            })),
        };
      });

      expect(
        overflow.hScrollWidth,
        `<html> scrollWidth ${overflow.hScrollWidth} exceeds clientWidth ${overflow.hClientWidth}. Offenders: ${JSON.stringify(overflow.offenders)}`,
      ).toBeLessThanOrEqual(overflow.hClientWidth + 1);

      expect(
        overflow.bScrollWidth,
        `<body> scrollWidth ${overflow.bScrollWidth} exceeds clientWidth ${overflow.hClientWidth}`,
      ).toBeLessThanOrEqual(overflow.hClientWidth + 1);
    });

    test(`${route.id} has ≥44 px tap targets`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState('networkidle');

      // Scan for visible interactive elements smaller than 44×44 px.
      const offenders = await page.evaluate(() => {
        const interactive = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"]';
        const bad: { sel: string; width: number; height: number }[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(interactive))) {
          const rect = el.getBoundingClientRect();
          // Ignore hidden / zero-sized elements
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.width < 44 || rect.height < 44) {
            bad.push({
              sel: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`,
              width: rect.width,
              height: rect.height,
            });
          }
        }
        return bad.slice(0, 10);
      });

      expect(
        offenders,
        `Interactive elements < 44×44 px found: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    });
  }
});
