/**
 * Scenarios TS-14 / TS-15 — Permission edges E2E spec
 * (002-acr-structured-readout T096).
 *
 * Plain-language: two adversarial-but-realistic scenarios.
 *
 *   TS-14: cross-tenant POST → server returns 403. The UI must show a
 *          "tenant violation" toast and NOT retry the POST (this is a
 *          terminal auth failure, not a network blip).
 *   TS-15: revoked-mid-session → server returns 401. The UI shows an
 *          "auth denied" toast and routes the user to the sign-in page.
 *
 * Style follows ./test-us4-compliance-audit.ts.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { installAcrMocks } from './helpers/mock-backend-acr';

const FIXTURE_DIR = 'src/emr/views/__e2e__/acr-readout/fixtures';

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(`${FIXTURE_DIR}/${name}`), 'utf-8'));
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.describe('TS-14/15: Permission edges', () => {
  // -------------------------------------------------------------------------
  // TS-14 — cross-tenant 403 → tenant_violation toast, no retry.
  // -------------------------------------------------------------------------
  test('TS-14: 403 cross-tenant POST shows tenant_violation toast', async ({ page }) => {
    let postCount = 0;
    await installAcrMocks(page, {
      summary: loadFixture('snapshot-complete.json'),
      etag: 'etag-ts14-001',
    });
    // Override the audit route AFTER install so we have control over status.
    await page.route('**/api/v1/analyses/*/report/clipboard-export', async (route) => {
      postCount += 1;
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'https://liverra.ai/errors/tenant-violation',
          title: 'Cross-tenant access denied',
          status: 403,
        }),
      });
    });

    await page.goto('/cases/analysis-ts14-001');
    await expect(page.getByTestId('acr-readout-root')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('acr-copy-button').click();

    const toast = page.getByRole('alert');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toHaveText(/tenant|forbidden|denied|access/i);

    // Wait a beat to ensure no retry happens — terminal auth failure.
    await page.waitForTimeout(2_000);
    expect(postCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // TS-15 — 401 revoked mid-session → auth_denied toast.
  // -------------------------------------------------------------------------
  test('TS-15: 401 revoked-mid-session shows auth_denied toast', async ({ page }) => {
    let postCount = 0;
    await installAcrMocks(page, {
      summary: loadFixture('snapshot-complete.json'),
      etag: 'etag-ts15-001',
    });
    await page.route('**/api/v1/analyses/*/report/clipboard-export', async (route) => {
      postCount += 1;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'https://liverra.ai/errors/unauthorized',
          title: 'Session expired',
          status: 401,
        }),
      });
    });

    await page.goto('/cases/analysis-ts15-001');
    await expect(page.getByTestId('acr-readout-root')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('acr-copy-button').click();

    const toast = page.getByRole('alert');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toHaveText(/auth|sign|expired|denied|login/i);

    // No durable-retry storm — 401 is terminal.
    await page.waitForTimeout(2_000);
    expect(postCount).toBe(1);
  });
});
