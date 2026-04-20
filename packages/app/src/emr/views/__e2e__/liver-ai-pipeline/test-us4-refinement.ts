/**
 * US4 — Interactive refinement (P4) E2E spec (T256 + T421).
 *
 * Plain-language: a surgeon clicks once inside an under-segmented tumor
 * and expects the AI mask to grow within 30 seconds. We also test:
 *   2. clicking in an empty region → clean rejection, no mask change;
 *   3. offline → click queued to IndexedDB → reconnect → auto-sync;
 *   4. undo stack pops all three refine clicks → original AI mask
 *      restored pixel-identical AND timeline still shows the edit +
 *      undo events (append-only per FR-017b).
 *
 * Task: T256 (Phase 6 · US4 · P4) + T421 (4th scenario appended).
 * Spec refs: §US4, FR-015, FR-017, FR-017b, FR-018c, SC-006.
 */
import { test, expect } from '@playwright/test';

test.describe('US4: Interactive refinement (P4)', () => {
  // ---------------------------------------------------------------------
  // Scenario 1 — Happy click-to-refine ≤30 s (FR-015 / SC-006).
  // ---------------------------------------------------------------------
  test('happy: click expands mask locally within 30 s', async ({ page }) => {
    await page.goto('/cases/a-happy/analysis');
    const seatBadge = page.getByTestId('review-seat-badge');
    await expect(seatBadge).toHaveAttribute('data-has-seat', 'true');

    const tools = page.getByTestId('refine-tools');
    await expect(tools).toBeVisible();
    await tools.getByRole('button', { name: /add/i }).click();

    const maskBefore = await page
      .getByTestId('mask-voxel-count')
      .textContent();

    const startedAt = Date.now();
    await page.getByTestId('viewer-canvas').click({ position: { x: 240, y: 180 } });

    await expect
      .poll(
        async () => {
          const raw = await page.getByTestId('mask-voxel-count').textContent();
          return Number(raw ?? 0);
        },
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBeGreaterThan(Number(maskBefore ?? 0));

    expect(Date.now() - startedAt).toBeLessThan(30_000);

    // RUO watermark must remain visible (SC-009).
    await expect(page.getByTestId('ruo-disclaimer')).toBeVisible();
  });

  // ---------------------------------------------------------------------
  // Scenario 2 — Empty-region click rejected cleanly (spec §US4 Failure).
  // ---------------------------------------------------------------------
  test('failure: empty-region click rejected with toast, no mutation', async ({
    page,
  }) => {
    await page.goto('/cases/a-happy/analysis');
    await page
      .getByTestId('refine-tools')
      .getByRole('button', { name: /add/i })
      .click();

    const before = await page.getByTestId('mask-voxel-count').textContent();

    // Click in corner coordinates guaranteed to be outside liver mask.
    await page.getByTestId('viewer-canvas').click({ position: { x: 5, y: 5 } });

    const toast = page.getByRole('alert');
    await expect(toast).toContainText(/no change|homogeneous|empty/i);

    const after = await page.getByTestId('mask-voxel-count').textContent();
    expect(after).toBe(before);
  });

  // ---------------------------------------------------------------------
  // Scenario 3 — Offline queue → reconnect auto-sync (FR-018c).
  // ---------------------------------------------------------------------
  test('edge: offline click queues to IndexedDB then syncs on reconnect', async ({
    page,
    context,
  }) => {
    await page.goto('/cases/a-happy/analysis');
    await page
      .getByTestId('refine-tools')
      .getByRole('button', { name: /add/i })
      .click();

    await context.setOffline(true);

    await page.getByTestId('viewer-canvas').click({ position: { x: 260, y: 200 } });

    const indicator = page.getByTestId('sync-indicator');
    await expect(indicator).toHaveAttribute(
      'aria-label',
      /offline.*1|queue/i,
    );

    // Open the popover — the pending row must include the edit_type.
    await indicator.click();
    await expect(
      page.getByTestId('sync-indicator').locator('..'),
    ).toContainText(/mask|refine/i);

    await context.setOffline(false);

    // Worker fires on the `online` event → depth drops back to 0.
    await expect(indicator).toHaveAttribute(
      'aria-label',
      /online(?!.*queue)/i,
      { timeout: 20_000 },
    );
  });

  // ---------------------------------------------------------------------
  // Scenario 4 — Undo restores AI mask + timeline intact (T421).
  // ---------------------------------------------------------------------
  test('undo: three refine clicks fully reversed, timeline append-only', async ({
    page,
  }) => {
    await page.goto('/cases/a-happy/analysis');

    const aiMaskHash = await page
      .getByTestId('mask-hash-ai')
      .textContent();
    expect(aiMaskHash).toBeTruthy();

    await page
      .getByTestId('refine-tools')
      .getByRole('button', { name: /add/i })
      .click();
    const canvas = page.getByTestId('viewer-canvas');
    for (const pt of [
      { x: 240, y: 180 },
      { x: 242, y: 182 },
      { x: 244, y: 184 },
    ]) {
      await canvas.click({ position: pt });
      await page.waitForTimeout(150);
    }

    const undo = page.getByTestId('refinement-undo');
    for (let i = 0; i < 3; i += 1) {
      await undo.click();
      await page.waitForTimeout(150);
    }

    // Current mask must equal the original AI mask (pixel-exact hash).
    const currentHash = await page
      .getByTestId('mask-hash-current')
      .textContent();
    expect(currentHash).toBe(aiMaskHash);

    // Timeline must still list all 6 events (3 edits + 3 undos).
    const timeline = page.getByTestId('review-timeline');
    await expect(timeline.getByTestId('timeline-entry')).toHaveCount(6);
  });
});
