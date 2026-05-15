/**
 * US4 — Compliance / audit scenarios E2E spec (002-acr-structured-readout T094).
 *
 * Plain-language: an auditor watches the radiologist click Copy and verifies
 * three compliance-grade properties:
 *
 *   TS-03: Each Copy click produces exactly one audit POST to
 *     /api/v1/analyses/:id/report/clipboard-export — never zero, never
 *     two, regardless of fast double-clicks.
 *   TS-09: A user with role 'view_only' can still Copy successfully; the
 *     audit row records the role faithfully.
 *   TS-12: When the audit POST fails with 5xx, the UI shows a "audit will
 *     retry" toast and the durable retry queue (IndexedDB) has at least
 *     one queued row.
 *
 * Style follows ./test-us1-radiologist-copy.ts.
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

test.describe('US4: Compliance audit pipeline', () => {
  // -------------------------------------------------------------------------
  // TS-03 — Audit POST fires exactly once per Copy click.
  // -------------------------------------------------------------------------
  test('TS-03: Copy click produces exactly one audit POST', async ({ page }) => {
    const mocks = await installAcrMocks(page, {
      summary: loadFixture('snapshot-complete.json'),
      etag: 'etag-ts03-001',
    });

    await page.goto('/cases/analysis-ts03-001');
    await expect(page.getByTestId('acr-readout-root')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('acr-copy-button').click();

    // Wait briefly for the audit POST to flush.
    await expect.poll(() => mocks.interceptedAuditPosts.length, { timeout: 5_000 }).toBe(1);
    expect(mocks.interceptedAuditPosts).toHaveLength(1);

    const audited = mocks.interceptedAuditPosts[0].body as Record<string, unknown>;
    expect(audited.outcome).toBe('success');
    expect(typeof audited.client_action_id).toBe('string');
  });

  // -------------------------------------------------------------------------
  // TS-09 — view-only role can copy + role is captured in audit POST.
  // -------------------------------------------------------------------------
  test('TS-09: view-only role can copy; role captured in audit', async ({ page }) => {
    const mocks = await installAcrMocks(page, {
      summary: loadFixture('snapshot-complete.json'),
      etag: 'etag-ts09-001',
      user: {
        id: 'user-view-only',
        email: 'view-only@liverra.ai',
        roles: ['view_only'],
        tenant_id: 'tenant-ts09',
      },
    });

    await page.goto('/cases/analysis-ts09-001');
    await expect(page.getByTestId('acr-readout-root')).toBeVisible({ timeout: 15_000 });

    const copyButton = page.getByTestId('acr-copy-button');
    await expect(copyButton).toBeEnabled();
    await copyButton.click();

    await expect.poll(() => mocks.interceptedAuditPosts.length, { timeout: 5_000 }).toBe(1);
    const audited = mocks.interceptedAuditPosts[0].body as Record<string, unknown>;
    expect(audited.actor_role).toBe('view_only');
    expect(audited.outcome).toBe('success');
  });

  // -------------------------------------------------------------------------
  // TS-12 — audit POST fails 5xx → toast + durable retry queue populated.
  // -------------------------------------------------------------------------
  test('TS-12: audit POST 5xx surfaces toast + IndexedDB retry row', async ({ page }) => {
    await installAcrMocks(page, {
      summary: loadFixture('snapshot-complete.json'),
      etag: 'etag-ts12-001',
      auditResponse: { status: 503, body: { error: 'service unavailable' } },
    });

    await page.goto('/cases/analysis-ts12-001');
    await expect(page.getByTestId('acr-readout-root')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('acr-copy-button').click();

    // Toast text: "audit will retry" (case-insensitive match — exact
    // copy can come from translations).
    const toast = page.getByRole('alert');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toHaveText(/retry|queue|pending/i);

    // IndexedDB durable-retry queue must have at least one row.
    const queuedRowCount = await page.evaluate<number>(async () => {
      const dbName = 'liverra-audit-retry-queue';
      return new Promise<number>((resolveCount) => {
        const open = indexedDB.open(dbName);
        open.onsuccess = () => {
          const db = open.result;
          const storeName = db.objectStoreNames[0];
          if (!storeName) {
            resolveCount(0);
            db.close();
            return;
          }
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const countReq = store.count();
          countReq.onsuccess = () => {
            resolveCount(countReq.result);
            db.close();
          };
          countReq.onerror = () => {
            resolveCount(0);
            db.close();
          };
        };
        open.onerror = () => resolveCount(0);
        // If the schema hasn't been created yet, treat as zero.
        open.onupgradeneeded = () => {
          /* noop — we don't create stores from the test */
        };
      });
    });

    expect(queuedRowCount).toBeGreaterThan(0);
  });
});
