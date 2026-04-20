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
} as const;

export type LiverRaExtensionKey = keyof typeof LIVERRA_EXTENSIONS;
export type LiverRaExtensionUrl = (typeof LIVERRA_EXTENSIONS)[LiverRaExtensionKey];
