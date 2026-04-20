/**
 * US4 — Session-expiry mid-edit replay E2E spec (T420).
 *
 * Plain-language: a reviewer is mid-refinement when their JWT expires.
 * Nothing should be lost:
 *   1. The in-flight mask-refine write falls through to IndexedDB (the
 *      `offlineQueue` outbox) because the server answers 401.
 *   2. The session-timeout modal pops — the reviewer re-authenticates
 *      via silent-renew or a password prompt.
 *   3. On fresh auth, the sync worker replays the queued writes and a
 *      toast surfaces "Resumed after reauthentication".
 *
 * Task: T420. Spec refs: FR-018a, FR-018c.
 */
import { test, expect } from '@playwright/test';

test.describe('US4: Session expiry mid-edit (P4)', () => {
  test('queues edits during expiry, replays after re-auth', async ({
    page,
    context,
  }) => {
    await page.goto('/cases/a-happy/analysis');

    // 1. Acquire seat + pick a tool.
    await expect(page.getByTestId('review-seat-badge')).toHaveAttribute(
      'data-has-seat',
      'true',
    );
    await page
      .getByTestId('refine-tools')
      .getByRole('button', { name: /add/i })
      .click();

    // 2. Simulate 401 on the next mutating request by blanking the
    //    auth cookie. The server's middleware will reject with 401,
    //    the sync worker keeps the row, and the modal fires.
    await context.clearCookies();

    const indicator = page.getByTestId('sync-indicator');
    const canvas = page.getByTestId('viewer-canvas');

    await canvas.click({ position: { x: 248, y: 192 } });

    // Session-timeout modal must appear (FR-018a).
    const modal = page.getByRole('dialog', { name: /session|re-?auth/i });
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Indicator shows the edit is still pending (not discarded).
    await expect(indicator).toHaveAttribute(
      'aria-label',
      /queue|offline.*1/i,
    );

    // 3. Re-authenticate (happy-path helper in the mock backend).
    await page.getByRole('button', { name: /re-?authenticate|sign in/i }).click();

    // 4. Worker replays → depth 0 + "Resumed after reauthentication" toast.
    await expect(indicator).toHaveAttribute(
      'aria-label',
      /online(?!.*queue)/i,
      { timeout: 20_000 },
    );
    const toast = page.getByRole('status');
    await expect(toast).toContainText(/Resumed after reauthentication/i);
  });
});
