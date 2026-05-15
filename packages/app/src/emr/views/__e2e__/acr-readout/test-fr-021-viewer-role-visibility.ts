// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FR-021 viewer-role panel visibility — added by 002-acr-structured-readout C4.
 *
 * Any authenticated user who can view the analysis MUST see the
 * structured readout panel — including read-only / viewer roles that
 * cannot finalize or review.
 */
import { test, expect } from '@playwright/test';

const DEMO = '/cases/demo-case-1';

test('FR-021 viewer role sees the ACR readout panel', async ({ page, context }) => {
  // Impersonate a viewer-only role for the dev-bypass auth path.
  await context.addCookies([
    {
      name: 'liverra-dev-role',
      value: 'view_only',
      url: 'http://localhost:5173',
    },
  ]);

  await page.goto(DEMO);
  const root = page.locator('[data-testid="acr-readout-root"]');
  await expect(root).toBeVisible({ timeout: 10_000 });
  // Six section headers visible regardless of write permissions.
  const h3Count = await root.locator('h3').count();
  expect(h3Count).toBeGreaterThanOrEqual(6);
});

test('FR-021 viewer role can also click Copy (FR-022 reinforcement)', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addCookies([
    {
      name: 'liverra-dev-role',
      value: 'view_only',
      url: 'http://localhost:5173',
    },
  ]);
  await page.goto(DEMO);
  await page.waitForSelector('[data-testid="acr-readout-root"]');
  const copyButton = page.locator('[data-testid="acr-copy-button"]');
  await expect(copyButton).toBeVisible();
  // Button is interactive (not disabled).
  await expect(copyButton).toBeEnabled();
});
