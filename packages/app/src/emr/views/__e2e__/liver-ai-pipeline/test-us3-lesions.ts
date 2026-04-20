/**
 * US3 — Lesion detection & classification (P3) E2E spec.
 *
 * Plain-language: after the AI pipeline has classified liver lesions (HCC,
 * ICC, metastasis, FNH, hemangioma, cyst — or "abstained" when confidence
 * is too low), this test drives the lesion list in the case-detail drawer
 * and proves that:
 *   1. The list hydrates once classification is done and centering the
 *      viewer on a row works end-to-end.
 *   2. Low-confidence rows render with an "Uncertain" badge (dashed border
 *      + help tooltip), NOT a class name.
 *   3. Hovering over empty parenchyma surfaces an "Add lesion" affordance —
 *      the MedSAM-2 one-prompt append path lives in T417 for full coverage.
 *
 * Task: T229 (Phase 5 · US3 · P3)
 * Spec refs:
 *   - §US3 — happy / failure / edge scenarios
 *   - FR-011 — abstention display when `max(probs) < threshold`
 *   - FR-016 — reviewer-prompted lesion append (partial coverage here, full
 *     coverage in T417 / `test-us3-lesion-append.ts`)
 *   - SC-005 — lesion sensitivity ≥0.78 (regression gate tested separately)
 *   - SC-009 — RUO disclaimer visible throughout
 */
import { test, expect } from '@playwright/test';
import { mockUs3Happy, mockUs3LowConfidence } from './helpers/mock-backend';

const ANALYSIS_ID = 'analysis-e2e-us1-0001';

async function assertRuoVisible(page: import('@playwright/test').Page): Promise<void> {
  const ruo = page.getByTestId('ruo-disclaimer');
  await expect(ruo).toBeVisible();
  await expect(ruo).toHaveText(/Research Use Only/);
}

test.describe('US3: Lesion detection & classification (P3)', () => {
  // ---------------------------------------------------------------------
  // Scenario 1 — Happy: list appears, classification + confidence rendered,
  // clicking a row recenters the 3D + slice viewers, detail panel opens.
  // ---------------------------------------------------------------------
  test('happy — lesions hydrate after classification stage', async ({ page }) => {
    await mockUs3Happy(page);
    await page.goto(`/cases/${ANALYSIS_ID}`);
    await assertRuoVisible(page);

    // Open the lesions tab in the drawer.
    await page.getByTestId('drawer-tab-lesions').click();

    // Wait for the SSE `classification` frame to land — the list gets three rows.
    const rows = page.getByTestId(/^lesion-row-/);
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    await assertRuoVisible(page);

    // Confidence bar must be visible on every row.
    const firstRow = page.getByTestId('lesion-row-lesion-001');
    await expect(firstRow.getByTestId('lesion-confidence-bar')).toBeVisible();
    // Suggested class text must be present (HCC for lesion-001 at 0.89 conf).
    await expect(firstRow).toContainText(/HCC/i);

    // Click the row → all views should recenter + detail panel opens.
    await firstRow.click();
    await expect(page.getByTestId('lesion-detail-panel')).toBeVisible();
    await expect(page.getByTestId('liver-viewer-3d')).toHaveAttribute(
      'data-focus-lesion-id',
      'lesion-001',
    );
    await expect(page.getByTestId('slice-viewer-axial')).toHaveAttribute(
      'data-focus-lesion-id',
      'lesion-001',
    );
    await assertRuoVisible(page);
  });

  // ---------------------------------------------------------------------
  // Scenario 2 — Failure: low-confidence lesion must show "Uncertain" badge
  // with dashed border and help tooltip. NO class name should be rendered.
  // ---------------------------------------------------------------------
  test('failure — low-confidence abstention shows Uncertain badge', async ({ page }) => {
    await mockUs3LowConfidence(page);
    await page.goto(`/cases/${ANALYSIS_ID}`);
    await assertRuoVisible(page);

    await page.getByTestId('drawer-tab-lesions').click();

    const uncertainRow = page.getByTestId('lesion-row-lesion-uncertain-001');
    await expect(uncertainRow).toBeVisible({ timeout: 30_000 });

    // Badge must read "Uncertain", have dashed-border class, and carry the
    // deterministic attribute so the dashed-border CSS isn't a styling
    // accident — the data attribute is the contract.
    const badge = uncertainRow.getByTestId('lesion-badge');
    await expect(badge).toHaveText(/Uncertain/i);
    await expect(badge).toHaveAttribute('data-abstained', 'true');
    await expect(badge).toHaveClass(/dashed|abstained/);

    // Class name MUST NOT be rendered on an abstained row.
    await expect(badge).not.toContainText(/^(HCC|ICC|Metastasis|FNH|Hemangioma|Cyst)$/i);

    // Help tooltip — hover shows the explanation text (FR-011).
    await badge.hover();
    const tooltip = page.getByTestId('lesion-uncertain-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(/AI could not confidently classify/i);
    await assertRuoVisible(page);
  });

  // ---------------------------------------------------------------------
  // Scenario 3 — Edge (partial): hovering over empty parenchyma shows the
  // "Add lesion" affordance. The full MedSAM-2 append flow is covered by
  // T417 in `test-us3-lesion-append.ts` — here we only prove the entry
  // point exists so US3 sign-off is not blocked on Phase 6.
  // ---------------------------------------------------------------------
  test('edge — Add lesion button visible when hovering empty parenchyma', async ({ page }) => {
    await mockUs3Happy(page);
    await page.goto(`/cases/${ANALYSIS_ID}`);
    await assertRuoVisible(page);

    await page.getByTestId('drawer-tab-lesions').click();

    // Hover over a region of the 3D viewer known (via mock) to be parenchyma
    // but not inside any detected lesion mask.
    const viewer = page.getByTestId('liver-viewer-3d');
    await viewer.hover({ position: { x: 120, y: 120 } });

    // The "Add lesion here" affordance must appear. It lives in the viewer's
    // cursor HUD — the testid is stable across Phase 5 and Phase 6.
    const addBtn = page.getByTestId('add-lesion-cursor-button');
    await expect(addBtn).toBeVisible();
    await expect(addBtn).toHaveText(/Add lesion/i);
    await assertRuoVisible(page);

    // NOTE: clicking through to the MedSAM-2 POST + new row assertion is
    // T417's job — this test intentionally stops at the affordance.
  });
});
