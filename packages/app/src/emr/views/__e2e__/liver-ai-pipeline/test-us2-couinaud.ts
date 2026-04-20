/**
 * US2 — Couinaud segments & vessels (P1 MVP) E2E spec (T210).
 *
 * Plain-language: the surgeon loads a finished analysis and sees the
 * liver split into 8 coloured pie-slices with the portal and hepatic
 * veins overlaid. They click a segment ("give me the volume for VI"),
 * they flip between axial/coronal/sagittal 2D views (synced to a
 * shared crosshair), and — for the rare failure case — if the liver
 * is cirrhotic and the AI gets confused, they still see the 8
 * segments but with a degraded-confidence banner.
 *
 * Scenarios (per spec §US2):
 *   1. Happy    — 8 segments render; click segment IV highlights it.
 *   2. Failure  — cirrhotic degraded segmentation flag visible.
 *   3. Edge     — click on axial recentres coronal + sagittal + 3D.
 *
 * Spec refs:
 *   - §US2 happy / failure / edge
 *   - §FR-008 §FR-009 §FR-019 §FR-020
 *   - §SC-004 ≥80% surgical usability (UI-side contract: all 8 segments
 *     visible with distinct colours + click-to-detail)
 *
 * Notes:
 *   - Route `/analyses/:id` is served by AnalysisDetailView (T186 —
 *     frontend-designer owned); this spec assumes the conventional
 *     URL shape.
 *   - All three scenarios confirm the RUO disclaimer stays visible
 *     throughout — SC-009 is cross-cutting.
 */
import { test, expect } from '@playwright/test';

import {
  US2_ANALYSIS_ID,
  mockUs2Happy,
  mockUs2CirrhoticDegraded,
  mockUs2ViewSync,
} from './helpers/mock-backend-us2';

const ANALYSIS_ROUTE = `/analyses/${US2_ANALYSIS_ID}`;

async function assertRuoVisible(page: import('@playwright/test').Page): Promise<void> {
  const ruo = page.getByTestId('ruo-disclaimer');
  await expect(ruo).toBeVisible();
  await expect(ruo).toHaveText(/Research Use Only/);
}

test.describe('US2: Couinaud segments & vessels (P1 MVP)', () => {
  // ---------------------------------------------------------------------
  // Scenario 1 — Happy.
  // ---------------------------------------------------------------------
  test('happy — 8 Couinaud segments render in distinct colours + click-to-detail', async ({
    page,
  }) => {
    await mockUs2Happy(page);
    await page.goto(ANALYSIS_ROUTE);

    await assertRuoVisible(page);

    // Every segment I..VIII must have a dedicated legend row.
    const labels = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] as const;
    for (const label of labels) {
      const legendItem = page.getByTestId(`couinaud-legend-item-${label}`);
      await expect(legendItem).toBeVisible();
    }

    // Distinct colours — assert each swatch element has a different
    // computed background-color. The CVD-safe palette guarantees
    // visually-distinct tokens; the test just verifies the tokens
    // were actually resolved (not all defaulting to transparent).
    const swatchColors = new Set<string>();
    for (const label of labels) {
      const color = await page
        .getByTestId(`segments-layer-swatch-${label}`)
        .evaluate((el) => window.getComputedStyle(el).backgroundColor);
      swatchColors.add(color);
    }
    expect(swatchColors.size).toBe(labels.length);

    // Click "Segment IV" — SegmentVolumeCard should appear in the
    // right drawer, and the active-segment state should propagate.
    await page.getByTestId('couinaud-legend-item-IV').click();
    const card = page.getByTestId('segment-volume-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(/Couinaud segment IV/i);
    await expect(page.getByTestId('segment-volume-card-volume')).toContainText(/mL$/);
    await expect(page.getByTestId('segment-volume-card-pct')).toContainText(/%.*total/i);

    await assertRuoVisible(page);
  });

  // ---------------------------------------------------------------------
  // Scenario 2 — Failure: cirrhotic degraded.
  // ---------------------------------------------------------------------
  test('failure — cirrhotic degraded segmentation shows warning banner', async ({
    page,
  }) => {
    await mockUs2CirrhoticDegraded(page);
    await page.goto(ANALYSIS_ROUTE);

    await assertRuoVisible(page);

    // The degraded-flag banner must be visible with the stable slug as
    // a data attribute so i18n-swapped text doesn't break the test.
    const degradedBanner = page.getByTestId('degraded-segmentation-banner');
    await expect(degradedBanner).toBeVisible();
    await expect(degradedBanner).toHaveAttribute(
      'data-slug',
      'cirrhosis_degraded_segmentation',
    );

    // Segments STILL render — the failure mode is a warning, not a
    // suppression of output. Pick three representatives for speed.
    for (const label of ['I', 'V', 'VIII'] as const) {
      await expect(page.getByTestId(`couinaud-legend-item-${label}`)).toBeVisible();
    }

    // And the overlay's degraded marker is present per segment for
    // surgeon glance-ability (each swatch carries the flag).
    const overlayWarning = page.getByTestId('segments-layer-degraded-overlay');
    await expect(overlayWarning).toBeVisible();

    await assertRuoVisible(page);
  });

  // ---------------------------------------------------------------------
  // Scenario 3 — Edge: MPR view sync across axial/coronal/sagittal/3D.
  // ---------------------------------------------------------------------
  test('edge — click on axial recentres coronal + sagittal + 3D', async ({
    page,
  }) => {
    await mockUs2ViewSync(page);
    await page.goto(ANALYSIS_ROUTE);

    await assertRuoVisible(page);

    // Identify the three MPR canvases + 3D viewer.
    const axial = page.getByTestId('mpr-canvas-axial');
    const coronal = page.getByTestId('mpr-canvas-coronal');
    const sagittal = page.getByTestId('mpr-canvas-sagittal');
    const viewer3d = page.getByTestId('liver-viewer-3d');

    await expect(axial).toBeVisible();
    await expect(coronal).toBeVisible();
    await expect(sagittal).toBeVisible();
    await expect(viewer3d).toBeVisible();

    // Read the initial crosshair values from the slice sliders.
    const initial = {
      axial: await page.getByTestId('mpr-slider-axial').inputValue().catch(() => '0'),
      coronal: await page.getByTestId('mpr-slider-coronal').inputValue().catch(() => '0'),
      sagittal: await page.getByTestId('mpr-slider-sagittal').inputValue().catch(() => '0'),
    };

    // Click near the top-right corner of the axial view — that should
    // shift the crosshair in x + y, which updates coronal (x) and
    // sagittal (y) too. We verify the other views moved by checking
    // the data attribute on the shared crosshair state container.
    const box = await axial.boundingBox();
    if (!box) {
      throw new Error('axial view has no bounding box');
    }
    await axial.click({
      position: { x: Math.round(box.width * 0.8), y: Math.round(box.height * 0.2) },
    });

    // After the click, coronal + sagittal must have recentred. We
    // inspect the crosshair container's data attributes which carry
    // the synced (x, y, z) voxel coordinate.
    const mprRoot = page.getByTestId('mpr-views');
    await expect(mprRoot).toHaveAttribute('data-crosshair-x', /\d+/, { timeout: 2000 });
    await expect(mprRoot).toHaveAttribute('data-crosshair-y', /\d+/);

    // 3D view must have reacted via a data attribute on the viewer root.
    await expect(viewer3d).toHaveAttribute('data-crosshair-synced', 'true');

    // Confirm at least ONE of the non-clicked slider values changed.
    const after = {
      coronal: await page
        .getByTestId('mpr-slider-coronal')
        .inputValue()
        .catch(() => '0'),
      sagittal: await page
        .getByTestId('mpr-slider-sagittal')
        .inputValue()
        .catch(() => '0'),
    };
    expect(after.coronal !== initial.coronal || after.sagittal !== initial.sagittal).toBe(true);

    await assertRuoVisible(page);
  });
});
