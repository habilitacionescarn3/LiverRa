/**
 * AuditEvent + AuditEventChain domain types.
 *
 * Source of truth: `specs/001-zero-training-mvp/data-model.md` §14 and
 * `research.md` §A.3 (chain-of-hashes). LiverRa's AuditEvent is a thin
 * façade over FHIR R4 AuditEvent; the `extensions` bag carries the four
 * LiverRa-specific extensions (permission-checked, model-version,
 * chain-sequence-no, chain-leaf-hash).
 *
 * The 24-member `AuditCategory` is the authoritative enumeration of event
 * kinds the platform emits (FR-029a). Adding a new category requires a
 * migration touching both Postgres and the Medplum CodeSystem.
 */

/**
 * Canonical enumeration of audit event categories. Exactly 25 members.
 * Declared as a `const` object + union for tree-shakable compile output.
 */
export const AuditCategory = {
  StudyUpload: 'study_upload',
  Anonymization: 'anonymization',
  AnalysisStart: 'analysis_start',
  AnalysisComplete: 'analysis_complete',
  MaskEdit: 'mask_edit',
  LesionReprompt: 'lesion_reprompt',
  ClassificationOverride: 'classification_override',
  ReportFinalize: 'report_finalize',
  ReportRetract: 'report_retract',
  PacsPushAttempt: 'pacs_push_attempt',
  PacsPushSuccess: 'pacs_push_success',
  PacsPushFailure: 'pacs_push_failure',
  ArtifactExport: 'artifact_export',
  PermissionCheck: 'permission_check',
  ReviewSeatAcquired: 'review_seat_acquired',
  ReviewSeatReleased: 'review_seat_released',
  ErasureRequested: 'erasure_requested',
  ErasureExecuted: 'erasure_executed',
  LicenseDriftDetected: 'license_drift_detected',
  TenantCreate: 'tenant_create',
  UserRoleChange: 'user_role_change',
  StepUpMfa: 'step_up_mfa',
  ConfigChange: 'config_change',
  TamperingAttempt: 'tampering_attempt',
  /** Added by 002-acr-structured-readout — clipboard export of the ACR structured readout panel. */
  ReadoutClipboardExport: 'readout_clipboard_export',
} as const;
export type AuditCategory = (typeof AuditCategory)[keyof typeof AuditCategory];

/**
 * Outcome of the audited action — mirrors FHIR R4 AuditEvent.outcome codes
 * (`0`=success, `4`=minor-failure, `8`=serious-failure, `12`=major-failure).
 */
export type AuditOutcome = 'success' | 'minor_failure' | 'serious_failure' | 'major_failure';

/**
 * Domain projection of a FHIR R4 AuditEvent resource.
 *
 * `claimKey` is populated for events tied to a RegulatoryClaimRegistry row
 * (e.g. an artifact export carries the snapshot of the claim state at
 * export time per FR-028b).
 *
 * `extensions` is a free-form map covering LiverRa-specific extensions
 * plus any resource-specific payload. Strongly-typed wrappers live in
 * the audit writer service.
 */
export interface AuditEvent {
  id: string;
  tenantId: string;
  category: AuditCategory;
  action: string;
  outcome: AuditOutcome;
  userId: string | null;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
  extensions: Record<string, unknown>;
  claimKey?: string;
}

/**
 * Tamper-evident per-tenant chain row. Research §A.3 is authoritative.
 *
 * `leafHash = sha256(prevLeafHash || sha256(tenantId || ':' || sequenceNo || ':' || canonicalJson))`
 *
 * Genesis (sequenceNo = 1) uses `Tenant.audit_chain_genesis_hash` as
 * `prevLeafHash`. Daily Merkle roots are rolled up to the S3 Object-Lock
 * bucket `liverra-audit-anchors-eu-central-1` in compliance mode.
 */
export interface AuditEventChain {
  tenantId: string;
  sequenceNo: number;
  leafHash: Uint8Array;
  prevLeafHash: Uint8Array;
  canonicalJson: string;
  writtenAt: string;
}
