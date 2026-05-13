// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical wire-shape source for the analysis report summary endpoint
 * (`GET /api/v1/analyses/{id}/report/summary`).
 *
 * Extracted from `components/report/ReportInlineView.tsx` (lines 46-92 in
 * the pre-extraction file) by 002-acr-structured-readout so both the
 * inline-view renderer AND the new ACR structured-readout panel consume
 * one source of truth — the foundation that lets the cross-channel
 * parity test (FR-024a) ever hold.
 *
 * No transformation lives here. This module is purely the shape +
 * the fetch primitive. Caching/staleness/ETag concerns live in
 * `hooks/useReportSummary.ts`.
 */

// Finding payload types. Ported verbatim from FindingsCard.tsx in
// 002-acr-structured-readout T045 so the deletion of FindingsCard can
// proceed cleanly. Source-of-truth for the wire shape of every Phase 1
// heuristic finding in `analysis_finding`.

/**
 * `computed_at` is attached server-side per finding payload by the
 * `/report/summary` handler (002-acr-structured-readout C2) so the
 * frontend can derive the FR-023c stale-finding marker by comparing
 * against the latest completed-stage timestamp.
 */
interface WithComputedAt {
  computed_at?: string | null;
}

export interface HUStats extends WithComputedAt {
  mean: number;
  median: number;
  p10: number;
  p90: number;
  std: number;
  voxel_count: number;
}

export interface SpleenFinding extends WithComputedAt {
  volume_ml: number;
  splenomegaly: boolean;
  threshold_ml: number;
  reference: string;
  /** Optional degraded-mask warning (e.g., <500 voxels). */
  warning?: string | null;
}

export interface SteatosisFinding extends WithComputedAt {
  grade: 'none' | 'mild' | 'moderate' | 'severe';
  liver_mean_hu: number;
  spleen_mean_hu: number | null;
  liver_spleen_delta: number | null;
  warnings: string[];
  reference: string;
}

export interface CalcifiedLesionFinding extends WithComputedAt {
  lesion_id: string;
  hu_max: number;
  pct_calcified: number;
  interpretation: string;
}

export interface SimpleBiliaryCystFinding extends WithComputedAt {
  lesion_id: string;
  hu_mean: number;
  hu_std: number;
  sphericity: number;
  wall_thickness_mm: number;
  interpretation: string;
}

export interface IndeterminateMalignantFinding extends WithComputedAt {
  lr_m_count: number;
  lesions: Array<{ lesion_id: string; confidence: number | null }>;
  interpretation: string;
}

export interface GallbladderFinding extends WithComputedAt {
  volume_ml: number;
  wall_thickness_mm: number;
  wall_thickened: boolean;
  stones_detected: boolean;
  stone_voxel_count: number;
}

export interface FindingsPayload {
  hu_stats?: HUStats | null;
  spleen?: SpleenFinding | null;
  steatosis?: SteatosisFinding | null;
  calcified_lesions?: CalcifiedLesionFinding[] | null;
  simple_biliary_cysts?: SimpleBiliaryCystFinding[] | null;
  indeterminate_malignant?: IndeterminateMalignantFinding | null;
  gallbladder?: GallbladderFinding | null;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export interface ReportSummaryStage {
  stage_no: number;
  stage: string;
  model_version: string | null;
  license_hash: string | null;
  written_at: string | null;
  /** Optional — backends emitting completion timestamps include this. */
  computed_at?: string | null;
  status?: 'queued' | 'running' | 'completed' | 'failed' | string;
}

export interface ReportSummaryFlr {
  total_ml: number | null;
  flr_ml: number | null;
  flr_pct: number | null;
  plane_pose: Record<string, unknown> | null;
  plan_pattern?: string | null;
  safety_class?: 'low' | 'borderline' | 'adequate' | string | null;
  computed_at?: string | null;
}

export interface ReportSummarySegmentation {
  anatomy_category: string;
  anatomy_detail: string | null;
  volume_ml: number | null;
}

export interface ReportSummaryLesion {
  id: string;
  bbox3d: number[] | null;
  longest_diameter_mm: number | null;
  segment?: string | null;
  size_mm?: number | null;
  volume_ml?: number | null;
  classification?: {
    label?: string | null;
    confidence?: number | null;
    probs?: Record<string, number> | null;
  } | null;
}

export interface ReportSummaryQcFlag {
  level: 'info' | 'warn' | string;
  code: string;
  message: string;
}

export interface ReportSummary {
  analysis_id: string;
  study_id: string;
  patient_ref: string | null;
  status: string;
  /** Added by 002-acr-structured-readout for the concurrency/freshness gate (FR-023a). */
  updated_at?: string | null;
  /** Added by 002-acr-structured-readout — also surfaced as ETag header. */
  etag?: string | null;
  tenant_id?: string | null;
  started_at: string | null;
  completed_at: string | null;
  pipeline_version: string | null;
  stages: ReportSummaryStage[];
  flr: ReportSummaryFlr | null;
  segmentations: ReportSummarySegmentation[];
  lesions: ReportSummaryLesion[];
  qc_flags: ReportSummaryQcFlag[];
  findings?: FindingsPayload;
}

export interface ReportSummaryWithMeta {
  body: ReportSummary;
  /** ETag header from the GET response (or null if backend did not emit one). */
  etag: string | null;
  /** Last-Modified header (or null). */
  lastModified: string | null;
}

/**
 * Fetch the report summary body, no metadata. Kept for backward
 * compatibility with the original ReportInlineView call site.
 */
export async function fetchReportSummary(analysisId: string): Promise<ReportSummary> {
  const meta = await fetchReportSummaryWithMeta(analysisId);
  return meta.body;
}

/**
 * Fetch the report summary AND its ETag / Last-Modified headers — used
 * by `useReportSummary` and the clipboard concurrency gate.
 */
export async function fetchReportSummaryWithMeta(
  analysisId: string,
): Promise<ReportSummaryWithMeta> {
  const base = readApiBaseUrl();
  const r = await fetch(
    `${base}/analyses/${encodeURIComponent(analysisId)}/report/summary`,
    { credentials: 'include' },
  );
  if (!r.ok) throw new Error(`Report summary failed: HTTP ${r.status}`);
  const body = (await r.json()) as ReportSummary;
  const etag = r.headers.get('ETag');
  const lastModified = r.headers.get('Last-Modified');
  return {
    body: {
      ...body,
      etag: etag ?? body.etag ?? null,
    },
    etag,
    lastModified,
  };
}

/**
 * Freshness probe used immediately before a clipboard write to detect
 * server-side mutation since panel-open (contracts/readout-api.md §2).
 *
 * Returns the current ETag (or null) from a HEAD request. Caller
 * compares against the value captured at panel-open time.
 */
export async function headReportSummaryEtag(analysisId: string): Promise<string | null> {
  const base = readApiBaseUrl();
  const r = await fetch(
    `${base}/analyses/${encodeURIComponent(analysisId)}/report/summary`,
    { credentials: 'include', method: 'HEAD' },
  );
  if (!r.ok) {
    // Surface auth failures to the caller; 5xx returns null so caller
    // can treat the gate as "unknown" and continue with write.
    if (r.status === 401 || r.status === 403) {
      throw new Error(`Report summary HEAD denied: HTTP ${r.status}`);
    }
    return null;
  }
  return r.headers.get('ETag');
}
