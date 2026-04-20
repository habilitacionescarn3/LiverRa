/**
 * ModelBillOfMaterials, RegulatoryClaimRegistry, ErasureRequest, DemoCase
 * domain types.
 *
 * Source of truth: `specs/001-zero-training-mvp/data-model.md` §16-§19.
 */

/**
 * Seven-claim RUO lifecycle keys (data-model §17). Each tenant holds one
 * row per claim; the `status` transitions `ruo → ce_class_iib → fda_510k`
 * as jurisdictions clear. Snapshots of this registry are bundled into
 * every Report (`claim_registry_snapshot`, FR-028b).
 */
export const ClaimKey = {
  FlrVolumetry: 'flr_volumetry',
  ParenchymaSegmentation: 'parenchyma_segmentation',
  CouinaudSegmentation: 'couinaud_segmentation',
  LesionDetection: 'lesion_detection',
  LesionClassification: 'lesion_classification',
  MaskRefinement: 'mask_refinement',
  DicomExport: 'dicom_export',
} as const;
export type ClaimKey = (typeof ClaimKey)[keyof typeof ClaimKey];

/** Regulatory lifecycle status for a single claim. */
export type ClaimStatus = 'ruo' | 'ce_class_iib' | 'fda_510k';

/**
 * Per-build auto-generated model registry (FR-038). One row per
 * (buildSha, modelName) pair. `licenseTextHash` is the SHA-256 of the
 * upstream LICENSE file captured at pin; the build pipeline recomputes it
 * on every release and fails the build on drift — forcing a human
 * re-approval to catch silent licence changes upstream.
 */
export interface ModelBillOfMaterials {
  buildSha: string;
  modelName: string;
  modelFamily: string;
  sourceUrl: string;
  pinnedCommitSha: string;
  licenseTextHash: string;
  licenseName: string;
  integrationDate: string;
  approver: string;
}

/**
 * Per-tenant per-claim lifecycle row (data-model §17).
 * `supersededBy` is set when a subsequent status upgrade retires this row
 * (e.g. `ruo` superseded by `ce_class_iib`) — audit preserves the history.
 */
export interface RegulatoryClaimRegistry {
  claimKey: ClaimKey;
  status: ClaimStatus;
  activatedAt: string;
  supersededBy?: string;
}

/**
 * GDPR Art. 17 case-level erasure workflow (data-model §18 / FR-040).
 * Execution is gated on a fresh MFA challenge (≤5 min before execute);
 * after completion the target Study + all FK-linked records are hard
 * deleted, and referencing AuditEvents are rewritten in-memory at read
 * time so chain integrity is preserved (research §A.3).
 */
export interface ErasureRequest {
  id: string;
  tenantId: string;
  targetStudyId: string;
  requestedByUserId: string;
  justification: string;
  mfaChallengeAt: string;
  executedAt: string | null;
  tombstoneHash: string;
  confirmationPdfUri: string | null;
  status: 'requested' | 'executing' | 'completed' | 'rolled_back';
}

/**
 * Tenant-scoped pre-loaded sample fixture (data-model §19 / FR-042).
 * Reports generated from a DemoCase carry a mandatory "Sample data — not
 * real patient" badge and cannot target a real PACS destination.
 */
export interface DemoCase {
  id: string;
  tenantId: string;
  fixtureName: string;
  studyId: string;
  seededAt: string;
}
