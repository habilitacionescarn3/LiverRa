// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * US2 mock-backend helpers — Couinaud + vessels (T210).
 *
 * Plain-language: Playwright runs the app under test but we don't want
 * to spin up a real FastAPI + Triton + Orthanc stack for every CI run.
 * This file is the "body double" for the backend during US2 scenarios:
 *   • Scenario 1 — Happy:     8 Couinaud segments + portal+hepatic veins.
 *   • Scenario 2 — Failure:   cirrhotic liver → degraded segmentation flag.
 *   • Scenario 3 — Edge:      MPR view sync across axial/coronal/sagittal.
 *
 * We keep this file separate from ``mock-backend.ts`` so the US2 task
 * can land without stepping on the US1+US3 agents' in-flight edits to
 * the shared file (per the CLAUDE.md "max 3 files per batch + no bulk
 * regex" rule). The two files share identifiers via constants.
 */

import type { Page, Route } from '@playwright/test';

export const US2_STUDY_ID = 'study-e2e-us2-0001';
export const US2_ANALYSIS_ID = 'analysis-e2e-us2-0001';

const COUINAUD_LABELS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] as const;

const json = (route: Route, status: number, body: unknown): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'x-ruo-disclaimer': 'Research Use Only' },
    body: JSON.stringify(body),
  });

/** Build the segment-detail payload for /analyses/{id}/segments. */
function buildSegments(options: {
  totalLiverVolumeMl: number;
  degraded?: boolean;
}): Record<string, unknown> {
  const { totalLiverVolumeMl, degraded } = options;
  // Distribute volume across 8 segments so Σ ≈ totalLiverVolumeMl.
  const shares = [0.04, 0.10, 0.10, 0.15, 0.12, 0.12, 0.14, 0.23];
  const segments = COUINAUD_LABELS.map((label, i) => ({
    label,
    anatomy_category: 'couinaud',
    volume_ml: +(totalLiverVolumeMl * shares[i]).toFixed(1),
    snomed_code: `24529${i + 3}007`,
    mask_uri: `s3://mock/couinaud_${label}.nii.gz`,
    sanity_flags: degraded
      ? { degraded_segmentation: true, topology_confidence: 0.42 }
      : {},
  }));
  return {
    analysis_id: US2_ANALYSIS_ID,
    total_liver_volume_ml: totalLiverVolumeMl,
    implausible_output_reason: degraded ? 'cirrhosis_degraded_segmentation' : null,
    segments,
    vessels: [
      {
        anatomy_category: 'portal_vein',
        volume_ml: 34.2,
        mask_uri: 's3://mock/portal.nii.gz',
        containment_ratio: 0.96,
      },
      {
        anatomy_category: 'hepatic_vein',
        volume_ml: 28.7,
        mask_uri: 's3://mock/hepatic.nii.gz',
        containment_ratio: 0.94,
      },
    ],
    ruo_disclaimer: 'Research Use Only',
  };
}

async function attachCommon(page: Page): Promise<void> {
  await page.route('**/api/v1/system/health', (route) =>
    json(route, 200, { status: 'ok', gpu: { state: 'warm', predicted_warm_s: 0 } }),
  );
  await page.route('**/api/v1/users/me', (route) =>
    json(route, 200, {
      id: 'user-e2e',
      email: 'e2e@liverra.ai',
      roles: ['surgeon'],
      tenant_id: 'tenant-e2e',
    }),
  );
  await page.route(`**/api/v1/analyses/${US2_ANALYSIS_ID}`, (route) =>
    json(route, 200, {
      id: US2_ANALYSIS_ID,
      study_id: US2_STUDY_ID,
      status: 'completed',
      stage: 'complete',
      progress_pct: 100,
      ruo_disclaimer: 'Research Use Only',
    }),
  );
}

// ---------------------------------------------------------------------------
// Scenario 1 — Happy: 8 Couinaud segments + portal+hepatic veins render.
// ---------------------------------------------------------------------------

export async function mockUs2Happy(page: Page): Promise<void> {
  await attachCommon(page);

  await page.route(`**/api/v1/analyses/${US2_ANALYSIS_ID}/segments`, (route) =>
    json(route, 200, buildSegments({ totalLiverVolumeMl: 1620 })),
  );

  await page.route(`**/api/v1/analyses/${US2_ANALYSIS_ID}/stream`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache', connection: 'keep-alive' },
      body:
        `event: stage-complete\ndata: ${JSON.stringify({
          analysis_id: US2_ANALYSIS_ID,
          stage: 'couinaud',
          progress_pct: 75,
          eta_seconds: 20,
          ruo_disclaimer: 'Research Use Only',
        })}\n\n` +
        `event: analysis-complete\ndata: ${JSON.stringify({
          analysis_id: US2_ANALYSIS_ID,
          status: 'completed',
          ruo_disclaimer: 'Research Use Only',
        })}\n\n`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Scenario 2 — Failure: cirrhotic liver, degraded segmentation flag.
// ---------------------------------------------------------------------------

export async function mockUs2CirrhoticDegraded(page: Page): Promise<void> {
  await attachCommon(page);

  await page.route(`**/api/v1/analyses/${US2_ANALYSIS_ID}/segments`, (route) =>
    json(route, 200, buildSegments({ totalLiverVolumeMl: 1180, degraded: true })),
  );

  // SSE replays a Stage-3 complete event but also signals a sanity flag
  // via the analysis envelope so the UI shows a degraded banner.
  await page.route(`**/api/v1/analyses/${US2_ANALYSIS_ID}`, (route) =>
    json(route, 200, {
      id: US2_ANALYSIS_ID,
      study_id: US2_STUDY_ID,
      status: 'completed',
      stage: 'complete',
      progress_pct: 100,
      implausible_output_reason: 'cirrhosis_degraded_segmentation',
      sanity_flags: { topology_confidence: 0.42, cirrhotic: true },
      ruo_disclaimer: 'Research Use Only',
    }),
  );
}

// ---------------------------------------------------------------------------
// Scenario 3 — Edge: MPR view sync.
//
// Nothing backend-specific is needed; the synchronization is purely a
// client-side behaviour of MultiPlanarViews. The mock still wires the
// segments endpoint so the viewer has something to render.
// ---------------------------------------------------------------------------

export async function mockUs2ViewSync(page: Page): Promise<void> {
  await mockUs2Happy(page);
}
