/**
 * US3 — Reviewer MedSAM-2 missed-lesion append E2E spec.
 *
 * Plain-language: sometimes the AI misses a small lesion. The radiologist
 * can point at the missed spot on the 3D viewer; MedSAM-2 runs a one-prompt
 * segmentation and a new Lesion row appears in the drawer list, tagged
 * `discovery_source='reviewer_prompted'`. The backend also writes a FHIR
 * AuditEvent noting the human in the loop. This test walks that full path
 * against a mock backend.
 *
 * Task: T417 (Phase 5 · US3 · P3, Phase-6 dependency flagged)
 * Spec refs:
 *   - §US3 Edge — "Radiologist drops a marker on a missed lesion; one-prompt
 *     re-segmentation appends the lesion with 'manually prompted' tag."
 *   - FR-016 — MedSAM-2 reviewer prompts
 *   - data-model.md §8 Lesion.discovery_source
 *
 * Phase-6 dependency: the `/reviews/{review_id}/lesion-prompt` endpoint +
 * the `RefineTools > Add lesion` UI live in the US4 / Phase 6 refinement
 * work. We stub both here so the contract is locked and regressions surface
 * early. Suites can gate this file on a `@phase-6` Playwright grep (e.g.
 * `npx playwright test --grep-invert "@phase-6"`) until Phase 6 lands.
 */
import { test, expect } from '@playwright/test';
import { mockUs3ReviewerPrompt, createAuditSink } from './helpers/mock-backend';

const ANALYSIS_ID = 'analysis-e2e-us1-0001';

test.describe('US3: Reviewer MedSAM-2 missed-lesion append @phase-6', () => {
  test('edge — marker drop appends reviewer_prompted lesion + audit event', async ({ page }) => {
    // Shared sink so the mock backend can record the audit event and the
    // test can inspect it after the UI mutation completes.
    const audit = createAuditSink();
    await mockUs3ReviewerPrompt(page, audit);

    await page.goto(`/cases/${ANALYSIS_ID}`);

    // Precondition: the lesions tab already shows N=3 AI-detected rows.
    await page.getByTestId('drawer-tab-lesions').click();
    const rowsBefore = page.getByTestId(/^lesion-row-/);
    await expect(rowsBefore).toHaveCount(3, { timeout: 30_000 });

    // Step 1 — reviewer opens the "Add lesion" tool in RefineTools. The
    // button lives on the viewer toolbar and is a Phase-6 surface.
    await page.getByTestId('refine-tools-add-lesion').click();

    // Step 2 — reviewer drops a marker on the 3D viewer at a parenchyma
    // coordinate (X,Y,Z). We click the exact pixel position — the viewer
    // resolves it to a voxel coordinate before POSTing.
    const viewer = page.getByTestId('liver-viewer-3d');
    await viewer.click({ position: { x: 240, y: 180 } });

    // Step 3 — the UI must show a progress indicator while MedSAM-2 runs.
    // (Mock returns instantly but the element should render at least once.)
    await expect(page.getByTestId('medsam-progress')).toBeVisible({ timeout: 5_000 });

    // Step 4 — row count increments to N+1 and the new row carries the
    // deterministic `data-discovery-source="reviewer_prompted"` attribute.
    const rowsAfter = page.getByTestId(/^lesion-row-/);
    await expect(rowsAfter).toHaveCount(4, { timeout: 15_000 });

    const newRow = page.getByTestId('lesion-row-lesion-reviewer-prompted-001');
    await expect(newRow).toBeVisible();
    await expect(newRow).toHaveAttribute('data-discovery-source', 'reviewer_prompted');

    // A visual "manually prompted" tag must be rendered so a reviewer can
    // distinguish human-in-the-loop rows from AI-detected ones.
    await expect(newRow.getByTestId('lesion-reviewer-prompted-tag')).toBeVisible();

    // Step 5 — the mock backend must have recorded the audit event the
    // real backend would write via the FHIR AuditEvent chain-of-hashes.
    expect(audit.events.length).toBeGreaterThanOrEqual(1);
    const promptedEvent = audit.events.find(
      (e) => e.action === 'reviewer_prompted_lesion_added',
    );
    expect(promptedEvent).toBeDefined();
    const payload = promptedEvent?.payload as {
      lesion_id?: string;
      analysis_id?: string;
      marker_voxel?: number[] | null;
    };
    expect(payload?.lesion_id).toBe('lesion-reviewer-prompted-001');
    expect(payload?.analysis_id).toBe(ANALYSIS_ID);
  });
});
