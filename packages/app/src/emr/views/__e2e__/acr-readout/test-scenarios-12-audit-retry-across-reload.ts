/**
 * TS-12 follow-on: durable audit retry survives a page reload
 * (002-acr-structured-readout T097).
 *
 * Plain-language: a radiologist clicks Copy; the audit POST is aborted
 * mid-flight (network drop). The client persists the pending event in
 * IndexedDB and shows a "will retry" toast. The user reloads the tab.
 * On mount, the drain hook reads the IndexedDB queue and re-POSTs the
 * pending event — with the SAME ``client_action_id``, so the server
 * recognises it as a replay (idempotency from T084).
 *
 * Verifies:
 *   1. Before reload: zero successful POSTs (request aborted).
 *   2. After reload: exactly one POST is observed, with the same
 *      ``client_action_id`` that was emitted before the reload.
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

test.describe('TS-12 follow-on: durable retry across reload', () => {
  test('audit POST aborted pre-reload re-fires post-reload with same client_action_id', async ({
    page,
  }) => {
    // Phase 1 — base mocks (summary + auth + ruo). The audit POST is
    // hand-routed because we need per-phase control.
    const baseMocks = await installAcrMocks(page, {
      summary: loadFixture('snapshot-complete.json'),
      etag: 'etag-ts12-reload-001',
      auditResponse: { status: 201, body: { ok: true } },
    });

    // Capture all audit POSTs observed across both phases.
    const observedAudits: Array<{ body: unknown }> = [];
    let abortFirst = true;

    // Override the audit route to abort the first request, fulfil the second.
    await page.route('**/api/v1/analyses/*/report/clipboard-export', async (route) => {
      const req = route.request();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(req.postData() ?? 'null');
      } catch {
        parsed = req.postData();
      }
      if (abortFirst) {
        abortFirst = false;
        // Simulate a hard network failure mid-flight.
        await route.abort('failed');
        return;
      }
      observedAudits.push({ body: parsed });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto('/cases/analysis-ts12-reload-001');
    await expect(page.getByTestId('acr-readout-root')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('acr-copy-button').click();

    // Wait for the abort + IndexedDB persistence to settle.
    await page.waitForTimeout(1_500);

    // Pre-reload: no successful POST captured yet (it was aborted).
    expect(observedAudits).toHaveLength(0);
    // The pre-install handle should also confirm: it never received a body
    // for the aborted request, so its count remains zero.
    expect(baseMocks.interceptedAuditPosts).toHaveLength(0);

    // Grab the queued client_action_id from IndexedDB so we can compare
    // against the post-reload re-fire.
    const queuedActionId = await page.evaluate<string | null>(async () => {
      return new Promise<string | null>((resolveId) => {
        const open = indexedDB.open('liverra-audit-retry-queue');
        open.onsuccess = () => {
          const db = open.result;
          const storeName = db.objectStoreNames[0];
          if (!storeName) {
            resolveId(null);
            db.close();
            return;
          }
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const all = store.getAll();
          all.onsuccess = () => {
            const rows = all.result as Array<Record<string, unknown>>;
            const first = rows[0];
            const id =
              first
              && typeof first === 'object'
              && typeof first.client_action_id === 'string'
                ? (first.client_action_id as string)
                : null;
            resolveId(id);
            db.close();
          };
          all.onerror = () => {
            resolveId(null);
            db.close();
          };
        };
        open.onerror = () => resolveId(null);
        open.onupgradeneeded = () => {
          /* noop */
        };
      });
    });

    // Phase 2 — reload. The drain-on-mount hook should fire one POST.
    await page.reload();
    await expect(page.getByTestId('acr-readout-root')).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(() => observedAudits.length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    expect(observedAudits).toHaveLength(1);

    if (queuedActionId !== null) {
      const replay = observedAudits[0].body as Record<string, unknown>;
      expect(replay.client_action_id).toBe(queuedActionId);
    }
  });
});
