/**
 * Mock backend for Phase 3 / US1 Playwright E2E tests (task T192).
 *
 * Plain-language: these helpers intercept every `/api/v1/*` request the app
 * makes during a test and return a scripted reply — so the test can run
 * without a real FastAPI server, Triton, Orthanc, or S3. Think of it as a
 * body double: the UI can't tell it's not the real backend.
 *
 * Each helper attaches Playwright `page.route()` handlers matching one of the
 * three US1 scenarios in `spec.md §US1`:
 *   - happy          → SC-002 (≤5 min upload-to-FLR)
 *   - missingPhase   → `missing_portal_venous_phase` rejection within 30 s
 *   - coldStart      → distinct warm-up indicator (NOT error variant)
 *
 * All handlers emit the `ruo-disclaimer` payload field so SC-009 assertions
 * ("Research Use Only" visible on every AI output) stay honest even under
 * mock conditions.
 *
 * Problem+json bodies follow RFC 9457 with LiverRa's `slug` extension per
 * `contracts/api-openapi.yaml`.
 */
import type { Page, Route } from '@playwright/test';

const STUDY_ID = 'study-e2e-us1-0001';
const ANALYSIS_ID = 'analysis-e2e-us1-0001';

// Tiny helper: respond JSON.
const json = (route: Route, status: number, body: unknown, extraHeaders: Record<string, string> = {}): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'x-ruo-disclaimer': 'Research Use Only', ...extraHeaders },
    body: JSON.stringify(body),
  });

const problemJson = (route: Route, status: number, body: unknown): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    body: JSON.stringify(body),
  });

/**
 * Build an SSE response body from a scripted sequence of stage-complete
 * events. Playwright's `route.fulfill()` can return a streaming body via
 * a single string — we concatenate SSE frames separated by `\n\n`.
 * Real backend sends them over time; for test speed we flush all at once.
 */
function buildSseStream(stages: Array<{ stage: string; pct: number; eta_s: number }>): string {
  const frames: string[] = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    frames.push(
      `event: stage-complete\ndata: ${JSON.stringify({
        analysis_id: ANALYSIS_ID,
        stage: s.stage,
        progress_pct: s.pct,
        eta_seconds: s.eta_s,
        ruo_disclaimer: 'Research Use Only',
      })}\n\n`,
    );
  }
  frames.push(
    `event: analysis-complete\ndata: ${JSON.stringify({
      analysis_id: ANALYSIS_ID,
      status: 'completed',
      ruo_disclaimer: 'Research Use Only',
    })}\n\n`,
  );
  return frames.join('');
}

// ---------------------------------------------------------------------------
// Shared health + RUO stubs attached by every scenario.
// ---------------------------------------------------------------------------
async function attachCommon(page: Page, healthPayload: unknown): Promise<void> {
  await page.route('**/api/v1/system/health', (route) => json(route, 200, healthPayload));
  await page.route('**/api/v1/system/ruo-disclaimer', (route) =>
    json(route, 200, {
      text: 'Research Use Only — not for clinical decision-making.',
      locale: 'en',
    }),
  );
  // Current user — minimum surface so route guards pass.
  await page.route('**/api/v1/users/me', (route) =>
    json(route, 200, {
      id: 'user-e2e',
      email: 'e2e@liverra.ai',
      roles: ['surgeon'],
      tenant_id: 'tenant-e2e',
    }),
  );
}

// ---------------------------------------------------------------------------
// Scenario 1 — Happy path.
// ---------------------------------------------------------------------------
export async function mockIngestHappy(page: Page): Promise<void> {
  await attachCommon(page, { status: 'ok', gpu: { predicted_warm_s: 0, state: 'warm' } });

  // Upload endpoint returns a fresh study_id.
  await page.route('**/api/v1/ingest/uploads', (route) =>
    json(route, 200, {
      study_id: STUDY_ID,
      analysis_id: ANALYSIS_ID,
      status: 'accepted',
      ruo_disclaimer: 'Research Use Only',
    }),
  );

  // Analysis resource — poll-safe; returns the latest known state.
  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}`, (route) =>
    json(route, 200, {
      id: ANALYSIS_ID,
      study_id: STUDY_ID,
      status: 'completed',
      stage: 'complete',
      progress_pct: 100,
      flr_pct: 42.7,
      ruo_disclaimer: 'Research Use Only',
    }),
  );

  // SSE stream — compressed timeline so the test finishes fast while still
  // exercising every UI stage indicator per US1 acceptance criteria.
  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}/stream`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-ruo-disclaimer': 'Research Use Only',
      },
      body: buildSseStream([
        { stage: 'uploading', pct: 10, eta_s: 240 },
        { stage: 'anonymizing', pct: 25, eta_s: 200 },
        { stage: 'running_stu_net', pct: 55, eta_s: 120 },
        { stage: 'running_couinaud', pct: 75, eta_s: 60 },
        { stage: 'running_lilnet', pct: 90, eta_s: 25 },
        { stage: 'computing_flr', pct: 99, eta_s: 5 },
      ]),
    }),
  );

  // Results endpoint — parenchyma mask URI + initial FLR at completion.
  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}/results`, (route) =>
    json(route, 200, {
      analysis_id: ANALYSIS_ID,
      parenchyma_uri: 's3://mock/parenchyma.nii.gz',
      segments_uri: 's3://mock/couinaud.nii.gz',
      lesions_uri: 's3://mock/lesions.nii.gz',
      initial_flr_pct: 42.7,
      total_liver_volume_ml: 1620,
      remnant_volume_ml: 692,
      ruo_disclaimer: 'Research Use Only',
    }),
  );

  // Resection-plane update endpoint — echoes a new FLR so the drag test can
  // assert on a changed readout. Deterministic but non-zero.
  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}/resection-plane`, (route) =>
    json(route, 200, {
      analysis_id: ANALYSIS_ID,
      flr_pct: 38.4,
      remnant_volume_ml: 622,
      ruo_disclaimer: 'Research Use Only',
    }),
  );
}

// ---------------------------------------------------------------------------
// Scenario 2 — Missing portal-venous phase.
// ---------------------------------------------------------------------------
export async function mockIngestMissingPhase(page: Page): Promise<void> {
  await attachCommon(page, { status: 'ok', gpu: { predicted_warm_s: 0, state: 'warm' } });

  await page.route('**/api/v1/ingest/uploads', (route) =>
    problemJson(route, 422, {
      type: 'https://liverra.ai/problems/missing_portal_venous_phase',
      title: 'Required imaging phase is missing',
      status: 422,
      slug: 'missing_portal_venous_phase',
      detail:
        'Portal-venous phase required for FLR calculation. Detected phases: unenhanced, arterial, delayed.',
      instance: '/api/v1/ingest/uploads',
      ruo_disclaimer: 'Research Use Only',
    }),
  );
}

// ---------------------------------------------------------------------------
// Scenario 3 — Cold-start warm-up.
// ---------------------------------------------------------------------------
export async function mockColdStart(page: Page): Promise<void> {
  // Health reports GPU is warming with a predicted time — UI must show the
  // info-variant banner, never the error variant.
  await attachCommon(page, {
    status: 'ok',
    gpu: { predicted_warm_s: 45, state: 'warming' },
    ruo_disclaimer: 'Research Use Only',
  });

  // Upload still succeeds (cold start ≠ rejection).
  await page.route('**/api/v1/ingest/uploads', (route) =>
    json(route, 200, {
      study_id: STUDY_ID,
      analysis_id: ANALYSIS_ID,
      status: 'queued',
      queue_reason: 'gpu_warming',
      ruo_disclaimer: 'Research Use Only',
    }),
  );

  // Analysis stays queued while models warm up.
  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}`, (route) =>
    json(route, 200, {
      id: ANALYSIS_ID,
      study_id: STUDY_ID,
      status: 'queued',
      stage: 'waiting_warmup',
      progress_pct: 0,
      queue_reason: 'gpu_warming',
      ruo_disclaimer: 'Research Use Only',
    }),
  );

  // SSE stream opens but sends only the initial waiting frame — no analysis-
  // complete event yet.
  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}/stream`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache', connection: 'keep-alive' },
      body:
        `event: stage-complete\ndata: ${JSON.stringify({
          analysis_id: ANALYSIS_ID,
          stage: 'waiting_warmup',
          progress_pct: 0,
          eta_seconds: 45,
          ruo_disclaimer: 'Research Use Only',
        })}\n\n`,
    }),
  );
}

// ===========================================================================
// US3 — Lesion detection & classification (T229, T417).
// ===========================================================================
//
// These helpers share the same STUDY_ID / ANALYSIS_ID surface as US1 so a
// suite can chain scenarios (upload → inspect lesions) without juggling ids.
// The payload shapes mirror `contracts/api-openapi.yaml` + data-model.md §8/§9.
// ---------------------------------------------------------------------------

const REVIEW_ID = 'review-e2e-us3-0001';

/** An audit-event sink the assertions can introspect. Populated by POST routes. */
export interface MockAuditSink {
  events: Array<{ action: string; payload: unknown }>;
}

/** Factory: each test gets its own sink so suites can't bleed into each other. */
export function createAuditSink(): MockAuditSink {
  return { events: [] };
}

/**
 * Canonical lesion fixtures. Three AI-detected rows + shapes for the two
 * "uncertain" and "reviewer_prompted" variants. Exported so individual
 * tests can inject a tailored subset when an edge case demands it.
 */
export const US3_LESION_FIXTURES = {
  /** Three healthy AI-detected lesions with high classification confidence. */
  happy: [
    {
      id: 'lesion-001',
      couinaud_location: 'VII',
      longest_diameter_mm: 22.4,
      volume_ml: 5.8,
      discovery_source: 'ai_detected',
      classification: {
        suggested_class: 'hcc',
        confidence_vector: { hcc: 0.89, icc: 0.03, metastasis: 0.04, fnh: 0.02, hemangioma: 0.01, cyst: 0.01 },
        abstention_threshold_used: 0.6,
        temperature_applied: 1.5,
        model_version: 'lilnet-1.0.0',
        reviewer_override_class: null,
      },
    },
    {
      id: 'lesion-002',
      couinaud_location: 'IVb',
      longest_diameter_mm: 14.1,
      volume_ml: 1.5,
      discovery_source: 'ai_detected',
      classification: {
        suggested_class: 'metastasis',
        confidence_vector: { hcc: 0.05, icc: 0.02, metastasis: 0.84, fnh: 0.04, hemangioma: 0.03, cyst: 0.02 },
        abstention_threshold_used: 0.6,
        temperature_applied: 1.5,
        model_version: 'lilnet-1.0.0',
        reviewer_override_class: null,
      },
    },
    {
      id: 'lesion-003',
      couinaud_location: 'III',
      longest_diameter_mm: 10.2,
      volume_ml: 0.55,
      discovery_source: 'ai_detected',
      classification: {
        suggested_class: 'cyst',
        confidence_vector: { hcc: 0.02, icc: 0.01, metastasis: 0.02, fnh: 0.01, hemangioma: 0.04, cyst: 0.9 },
        abstention_threshold_used: 0.6,
        temperature_applied: 1.5,
        model_version: 'lilnet-1.0.0',
        reviewer_override_class: null,
      },
    },
  ],
  /** Single low-confidence lesion that must trigger the abstention banner. */
  lowConfidence: [
    {
      id: 'lesion-uncertain-001',
      couinaud_location: 'V',
      longest_diameter_mm: 9.8,
      volume_ml: 0.48,
      discovery_source: 'ai_detected',
      classification: {
        // `max_prob = 0.5` < threshold 0.6 → backend returns `abstained`
        suggested_class: 'abstained',
        confidence_vector: { hcc: 0.5, icc: 0.1, metastasis: 0.2, fnh: 0.1, hemangioma: 0.05, cyst: 0.05 },
        abstention_threshold_used: 0.6,
        temperature_applied: 1.5,
        model_version: 'lilnet-1.0.0',
        reviewer_override_class: null,
      },
    },
  ],
};

/** Build a minimal US3 `/results` payload with a given lesion array. */
function buildResultsWithLesions(lesions: unknown[]): Record<string, unknown> {
  return {
    analysis_id: ANALYSIS_ID,
    parenchyma_uri: 's3://mock/parenchyma.nii.gz',
    segments_uri: 's3://mock/couinaud.nii.gz',
    lesions_uri: 's3://mock/lesions.nii.gz',
    initial_flr_pct: 42.7,
    total_liver_volume_ml: 1620,
    remnant_volume_ml: 692,
    lesions,
    ruo_disclaimer: 'Research Use Only',
  };
}

/**
 * Scenario 1 — Happy: three AI-detected lesions appear after the
 * classification stage completes. SSE stream fires stage-complete events in
 * order so the test can observe lesion-list hydration on the classification
 * frame.
 */
export async function mockUs3Happy(page: Page): Promise<void> {
  await attachCommon(page, { status: 'ok', gpu: { predicted_warm_s: 0, state: 'warm' } });

  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}`, (route) =>
    json(route, 200, {
      id: ANALYSIS_ID,
      study_id: STUDY_ID,
      status: 'completed',
      stage: 'complete',
      progress_pct: 100,
      ruo_disclaimer: 'Research Use Only',
    }),
  );

  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}/results`, (route) =>
    json(route, 200, buildResultsWithLesions(US3_LESION_FIXTURES.happy)),
  );

  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}/stream`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache', connection: 'keep-alive' },
      body: buildSseStream([
        { stage: 'parenchyma', pct: 20, eta_s: 120 },
        { stage: 'couinaud', pct: 45, eta_s: 90 },
        { stage: 'lesion_detection', pct: 70, eta_s: 40 },
        { stage: 'classification', pct: 95, eta_s: 10 },
      ]),
    }),
  );
}

/**
 * Scenario 2 — Failure: single low-confidence lesion with `abstained` class
 * and `max_prob=0.5`. The UI must surface an "Uncertain" badge with dashed
 * border + help tooltip text.
 */
export async function mockUs3LowConfidence(page: Page): Promise<void> {
  await attachCommon(page, { status: 'ok', gpu: { predicted_warm_s: 0, state: 'warm' } });

  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}`, (route) =>
    json(route, 200, {
      id: ANALYSIS_ID,
      study_id: STUDY_ID,
      status: 'completed',
      stage: 'complete',
      progress_pct: 100,
      ruo_disclaimer: 'Research Use Only',
    }),
  );

  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}/results`, (route) =>
    json(route, 200, buildResultsWithLesions(US3_LESION_FIXTURES.lowConfidence)),
  );

  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}/stream`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache', connection: 'keep-alive' },
      body: buildSseStream([
        { stage: 'classification', pct: 95, eta_s: 5 },
      ]),
    }),
  );
}

/**
 * Scenario 3 — Edge: radiologist drops a marker on an AI-missed lesion;
 * MedSAM-2 returns a new `Lesion` with `discovery_source='reviewer_prompted'`.
 *
 * Phase-6 dependency note: the `/reviews/{review_id}/lesion-prompt` endpoint
 * lives in the US4 refinement contract. We stub it here with a fixed payload
 * so US3 E2E tests can cover the edge without waiting for Phase 6 to land.
 *
 * @param page   Playwright page
 * @param audit  Audit sink the mutation handler appends to; tests read from it
 *               to prove the FHIR AuditEvent emit contract held.
 */
export async function mockUs3ReviewerPrompt(
  page: Page,
  audit: MockAuditSink,
): Promise<void> {
  // Start from the happy baseline (3 AI-detected lesions).
  await mockUs3Happy(page);

  // Review session bootstrap — stubbed minimum so the tool can start.
  await page.route(`**/api/v1/reviews/${REVIEW_ID}`, (route) =>
    json(route, 200, {
      id: REVIEW_ID,
      analysis_id: ANALYSIS_ID,
      reviewer_user_id: 'user-e2e',
      seat_held_until: new Date(Date.now() + 300_000).toISOString(),
      started_at: new Date().toISOString(),
      finalized_at: null,
      edit_count: 0,
      is_addendum_of_review_id: null,
    }),
  );

  // MedSAM-2 one-prompt endpoint — returns a new Lesion with
  // `discovery_source='reviewer_prompted'` and appends to the happy fixture.
  const appendedLesions = [...US3_LESION_FIXTURES.happy];
  await page.route(`**/api/v1/reviews/${REVIEW_ID}/lesion-prompt`, async (route) => {
    const body = route.request().postDataJSON() as { marker_voxel?: number[] } | null;
    const newLesion = {
      id: 'lesion-reviewer-prompted-001',
      couinaud_location: 'VIII',
      longest_diameter_mm: 7.8,
      volume_ml: 0.3,
      discovery_source: 'reviewer_prompted' as const,
      classification: {
        suggested_class: 'metastasis' as const,
        confidence_vector: {
          hcc: 0.05,
          icc: 0.02,
          metastasis: 0.8,
          fnh: 0.05,
          hemangioma: 0.05,
          cyst: 0.03,
        },
        abstention_threshold_used: 0.6,
        temperature_applied: 1.5,
        model_version: 'lilnet-1.0.0',
        reviewer_override_class: null,
      },
    };
    appendedLesions.push(newLesion);

    // Record the audit event the mutation should have produced — in the real
    // backend this goes to a FHIR AuditEvent via the chain-of-hashes writer.
    audit.events.push({
      action: 'reviewer_prompted_lesion_added',
      payload: {
        review_id: REVIEW_ID,
        analysis_id: ANALYSIS_ID,
        lesion_id: newLesion.id,
        marker_voxel: body?.marker_voxel ?? null,
      },
    });

    return json(route, 201, newLesion);
  });

  // After append, the results endpoint must return the N+1 list.
  await page.route(`**/api/v1/analyses/${ANALYSIS_ID}/results`, (route) =>
    json(route, 200, buildResultsWithLesions(appendedLesions)),
  );
}
