// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * LiverRa — FHIR Extension URLs
 *
 * All LiverRa-authored `StructureDefinition` URLs. The actual JSON
 * StructureDefinition resources live in `packages/fhirtypes/src/liverra/extensions/`
 * and are POSTed to Medplum by `scripts/bootstrap-medplum-project.py` at tenant
 * provisioning time (research §A.2).
 *
 * Plain-English analogy:
 *   A FHIR extension is a sticky note stuck onto a standard medical form —
 *   carrying the metadata that stock FHIR doesn't know about (e.g. "which ML
 *   model produced this result" or "is the RUO watermark burnt in?").
 *
 * Categories:
 *   - AUDIT_*     → attached to `AuditEvent` (chain-of-custody, model identity)
 *   - RUO_*       → attached to `DiagnosticReport` / `DocumentReference`
 *   - Analysis-level sanity + safety flags → attached to `Observation`
 *     or LiverRa's custom Analysis resource
 */

import { FHIR_BASE_URL } from './fhir-systems';

/** Base path for every LiverRa-defined StructureDefinition. */
const EXT_BASE = `${FHIR_BASE_URL}/StructureDefinition` as const;

/**
 * Canonical URL for every LiverRa extension. Do NOT construct these URLs
 * dynamically elsewhere — import and reference the key.
 */
export const LIVERRA_EXTENSIONS = {
  // -- AuditEvent extensions (chain-of-hashes + model traceability) --

  /** Boolean. Set on every AuditEvent to prove RBAC was evaluated before the action. */
  AUDIT_PERMISSION_CHECKED: `${EXT_BASE}/audit-permission-checked`,

  /** String. MBoM (Model Bill-of-Materials) build SHA — identifies the exact model
   *  versions responsible for the audited action. */
  AUDIT_MODEL_VERSION: `${EXT_BASE}/audit-model-version`,

  /** PositiveInt. Monotonic sequence number within the per-tenant audit chain
   *  (research §A.3 tamper-evident chain-of-hashes). */
  AUDIT_CHAIN_SEQUENCE_NO: `${EXT_BASE}/audit-chain-sequence-no`,

  /** Base64Binary. SHA-256 leaf hash of this audit record, feeding the daily
   *  Merkle root pushed to S3 Object Lock. */
  AUDIT_CHAIN_LEAF_HASH: `${EXT_BASE}/audit-chain-leaf-hash`,

  // -- AuditEvent extensions added by 002-acr-structured-readout --

  /** Code. Locale actually rendered for an export (after fallback resolution).
   *  Used by ReadoutClipboardExport events. */
  AUDIT_LOCALE: `${EXT_BASE}/audit-locale`,

  /** Reference(Organization). Tenant the audited action belongs to.
   *  Included for forensic completeness on cross-tenant access attempts. */
  AUDIT_TENANT: `${EXT_BASE}/audit-tenant`,

  /** Uuid. Client-supplied idempotency key per user click; identical across
   *  durable retries of the same export. */
  AUDIT_CLIENT_ACTION_ID: `${EXT_BASE}/audit-client-action-id`,

  /** Code. Why a failed AuditEvent failed
   *  (network | clipboard_blocked | audit_chain_unavailable | auth_denied | tenant_violation). */
  AUDIT_FAILURE_CATEGORY: `${EXT_BASE}/audit-failure-category`,

  // -- RUO (Research Use Only) watermark + claim tracking --

  /** Code. Which RUO claim-registry key applies to this output (FR-028b). */
  RUO_CLAIM_KEY: `${EXT_BASE}/ruo-claim-key`,

  /** Boolean. True if the RUO watermark was verifiably burnt in at render time. */
  RUO_WATERMARK_PRESENT: `${EXT_BASE}/ruo-watermark-present`,

  // -- Analysis-level safety flags --

  /** CodeableConcept (0..*). Atypical-anatomy detectors (transplant, situs inversus,
   *  partial-coverage, vessel variant, …) that fired on this study. */
  ATYPICAL_ANATOMY_FLAGS: `${EXT_BASE}/atypical-anatomy-flags`,

  /** Code. Why the end-of-pipeline sanity validator rejected this output
   *  (sum_mismatch / segment_zero_volume / flr_negative / classification_nonnormal). */
  IMPLAUSIBLE_OUTPUT_REASON: `${EXT_BASE}/implausible-output-reason`,

  /** Boolean. True if the input CT did not fully cover the liver (cranial/caudal clipping). */
  PARTIAL_COVERAGE_FLAG: `${EXT_BASE}/partial-coverage-flag`,

  // -- ImagingStudy workflow extensions (PACS reading worklist) --

  /** Code. LiverRa workflow status complementing FHIR `ImagingStudy.status`.
   *  Permitted values: ordered | scheduled | in-progress | images-available |
   *  preliminary-read | reported. */
  IMAGING_STUDY_STATUS: `${EXT_BASE}/imaging-study-status`,

  /** String. JSON-encoded array of `{at, status, by}` workflow transitions for
   *  this `ImagingStudy`. Single string slot keeps the timeline tamper-evidently
   *  hashable from one extension. */
  IMAGING_STUDY_TIMELINE: `${EXT_BASE}/imaging-study-timeline`,

  /** Code. Reading-priority for the study (`stat | urgent | routine`). Resolved
   *  onto `ImagingStudy` for worklist sorting; mirrors `ServiceRequest.priority`. */
  IMAGING_PRIORITY: `${EXT_BASE}/imaging-priority`,

  /** String. Orthanc-side study UUID (edge PACS) that this `ImagingStudy` mirrors,
   *  used to round-trip back to Orthanc for WADO retrieval. */
  ORTHANC_STUDY_ID: `${EXT_BASE}/orthanc-study-id`,
} as const;

export type LiverRaExtensionKey = keyof typeof LIVERRA_EXTENSIONS;
export type LiverRaExtensionUrl = (typeof LIVERRA_EXTENSIONS)[LiverRaExtensionKey];
