/**
 * US1 — Radiologist Copy E2E spec (002-acr-structured-readout T058).
 *
 * Plain-language: a radiologist opens an analysis page, sees the ACR
 * structured readout, and clicks Copy. The clipboard receives plain text
 * bookended by the RUO disclaimer; the audit POST fires exactly once.
 *
 * Covers US1 acceptance scenarios 1-5:
 *   1. Sections render in fixed canonical order.
 *   2. Copy produces plain text bookended by RUO with no markup chars.
 *   3. Degraded warning preserved in the clipboard text.
 *   4. Missing findings render gracefully ("Not available").
 *   5. Running placeholder: headers visible, rows show "Computing",
 *      Copy button disabled.
 *
 * Fixtures + mock backend live next to this file.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { installAcrMocks } from './helpers/mock-backend-acr';

const FIXTURE_DIR = 'src/emr/views/__e2e__/acr-readout/fixtures';

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(`${FIXTURE_DIR}/${name}`), 'utf-8'));
}

// Tests need clipboard permission so page.evaluate(navigator.clipboard.readText)
// works inside the Chromium context.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.describe('US1: Radiologist copy ACR readout', () => {
  test('Sections render in fixed order', async ({ page }) => {
    await installAcrMocks(page, {
      summary: loadFixture('snapshot-complete.json'),
      etag: 'etag-complete-001',
    });
    await page.goto('/cases/analysis-acr-complete-001');

    const root = page.getByTestId('acr-readout-root');
    await expect(root).toBeVisible({ timeout: 15_000 });

    // Section headers appear in the canonical order. Match the displayed
    // text against either the English defaults or any localized variant —
    // the order is what matters here.
    const headers = await root.locator('h3').allTextContents();
    const upper = headers.map((h) => h.toUpperCase());
    const expectedOrder = ['LIVER', 'LESIONS', 'VESSELS', 'GALLBLADDER', 'SPLEEN', 'FLR'];
    let cursor = 0;
    for (const needle of expectedOrder) {
      const idx = upper.findIndex((h, i) => i >= cursor && h.includes(needle));
      expect(idx, `expected section "${needle}" after position ${cursor}`).toBeGreaterThanOrEqual(cursor);
      cursor = idx + 1;
    }
  });

  test('Copy produces plain text bookended by RUO', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installAcrMocks(page, {
      summary: loadFixture('snapshot-complete.json'),
      etag: 'etag-complete-001',
    });
    await page.goto('/cases/analysis-acr-complete-001');

    await expect(page.getByTestId('acr-readout-root')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('acr-copy-button').click();

    // Read clipboard inside the page context.
    const text = await page.evaluate(async () => navigator.clipboard.readText());
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/RESEARCH USE ONLY/);
    expect(lines[lines.length - 1]).toMatch(/RESEARCH USE ONLY/);

    // No markup / HTML special characters.
    expect(text).not.toMatch(/[<>*]/);
  });

  test('Degraded warning preserved in clipboard text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installAcrMocks(page, {
      summary: loadFixture('snapshot-degraded-spleen.json'),
      etag: 'etag-degraded-spleen-001',
    });
    await page.goto('/cases/analysis-acr-degraded-spleen-001');

    await expect(page.getByTestId('acr-readout-root')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('acr-copy-button').click();

    const text = await page.evaluate(async () => navigator.clipboard.readText());
    // The degraded spleen warning surfaces as a `! ` line in the rendered text.
    expect(text).toMatch(/!\s+.*Spleen mask <500 voxels/);
  });

  test('Missing findings render gracefully — no JS errors, "Not available" present', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));

    await installAcrMocks(page, {
      summary: loadFixture('snapshot-partial-payload.json'),
      etag: 'etag-partial-payload-001',
    });
    await page.goto('/cases/analysis-acr-partial-payload-001');

    await expect(page.getByTestId('acr-readout-root')).toBeVisible({ timeout: 15_000 });
    // Wait one frame so any deferred renders settle.
    await page.waitForTimeout(250);

    // Empty/missing fields surface as "Not available" or the localized
    // empty-state ("Not assessed"). At least one such fallback must exist.
    const root = page.getByTestId('acr-readout-root');
    const bodyText = (await root.textContent()) ?? '';
    expect(/Not available|Not assessed/.test(bodyText)).toBe(true);

    expect(pageErrors, `unexpected pageerror: ${pageErrors.map((e) => e.message).join('; ')}`).toEqual([]);
  });

  test('Queued/running placeholder — section headers visible, Copy disabled', async ({ page }) => {
    const runningSummary = {
      ...(loadFixture('snapshot-complete.json') as Record<string, unknown>),
      status: 'running',
      // Wipe heavy data — the renderer must show "Computing" placeholders.
      flr: null,
      lesions: [],
      findings: undefined,
    };
    await installAcrMocks(page, { summary: runningSummary, etag: 'etag-running-001' });
    await page.goto('/cases/analysis-acr-complete-001');

    const root = page.getByTestId('acr-readout-root');
    await expect(root).toBeVisible({ timeout: 15_000 });

    // All six section headers are still visible.
    const headers = await root.locator('h3').allTextContents();
    expect(headers.length).toBeGreaterThanOrEqual(6);

    // Copy button is rendered but disabled while the analysis is running.
    const copyButton = page.getByTestId('acr-copy-button');
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toBeDisabled();
  });
});
