/**
 * Analysis + PipelineCheckpoint domain types.
 *
 * Source of truth: `specs/001-zero-training-mvp/data-model.md` §5 (Analysis)
 * and §6 (PipelineCheckpoint). Field list mirrors the T027 deliverable in
 * `specs/001-zero-training-mvp/tasks.md` — the shortlist of app-visible
 * fields. The Postgres schema carries additional denormalized columns
 * (e.g. `atypical_anatomy_flags`, `confidence_flags`) that are exposed via
 * dedicated projection types in later tasks.
 */

/**
 * Analysis lifecycle states.
 *
 * Modelled as a `const` object + union type (not a TypeScript `enum`) so the
 * emitted bundle is tree-shakable. See CLAUDE.md "enums as const objects".
 */
export const AnalysisStatus = {
  Queued: 'queued',
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Expired: 'expired',
  ImplausibleOutput: 'implausible_output',
} as const;
export type AnalysisStatus = (typeof AnalysisStatus)[keyof typeof AnalysisStatus];

/**
 * One end-to-end run of the cascaded inference pipeline over a Study.
 *
 * Corresponds to data-model §5. `errorSlug` is the terminal-state reason
 * code (one of `timeout`, `implausible_output`, `stage_failure`, etc.).
 * `modelVersions` is the per-stage MBoM key map; keys are the seven stage
 * names from PipelineCheckpoint.
 */
export interface Analysis {
  id: string;
  tenantId: string;
  studyId: string;
  status: AnalysisStatus;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorSlug: string | null;
  modelVersions: Record<string, string>;
}

/**
 * Per-stage durability record. Enables in-flight recovery after worker
 * restart: the orchestrator reads `MAX(stageNo)` for an Analysis and resumes
 * from the next stage. Corresponds to data-model §6.
 *
 * `modelLicenseHash` is the SHA-256 of the upstream LICENSE file captured at
 * MBoM integration time; surfaced here so checkpoint replay can verify the
 * stage ran under a still-valid license (FR-038).
 */
export interface PipelineCheckpoint {
  analysisId: string;
  stageNo: number;
  stage: string;
  outputUri: string | null;
  writtenAt: string;
  modelVersion: string;
  modelLicenseHash: string;
}
