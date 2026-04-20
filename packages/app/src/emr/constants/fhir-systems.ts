// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * LiverRa — FHIR Systems (Single Source of Truth)
 *
 * Centralizes every FHIR-namespaced URL used by the LiverRa frontend + backend.
 * The Constitution (§IV FHIR-first) forbids hard-coded FHIR URL strings anywhere
 * else in the codebase. Consumers MUST import from this module.
 *
 * Plain-English analogy:
 *   Think of this file as the "address book" for every identifier type and
 *   terminology LiverRa talks about. If you need to name a study, a tenant,
 *   a SNOMED code — you look up the address here first.
 *
 * URL patterns (LiverRa-defined):
 *   - Identifier systems: `${FHIR_BASE_URL}/sid/[name]`
 *   - CodeSystems:        `${FHIR_BASE_URL}/CodeSystem/[name]`
 *   - ValueSets:          `${FHIR_BASE_URL}/ValueSet/[name]`
 *   - Extensions:         `${FHIR_BASE_URL}/StructureDefinition/[name]` (see fhir-extensions.ts)
 *
 * External standard systems (SNOMED, LOINC, DICOM, etc.) are exported from
 * `EXTERNAL_SYSTEMS` below.
 *
 * @see https://hl7.org/fhir/R4/extensibility.html
 * @see https://hl7.org/fhir/R4/terminologies.html
 */

// ============================================================================
// Base URL
// ============================================================================

/** Root namespace for every LiverRa-authored FHIR artifact. */
export const FHIR_BASE_URL = 'http://liverra.ai/fhir' as const;

// ============================================================================
// LiverRa identifier + code system URLs
// ============================================================================

/**
 * All LiverRa-owned FHIR identifier systems and CodeSystem URLs.
 *
 * - `*_SID`   → identifier systems (Patient.identifier, ImagingStudy.identifier, …)
 * - `*_CS`    → LiverRa-authored CodeSystem URLs
 */
export const FHIR_SYSTEMS = {
  // -- Identifier systems (LiverRa-assigned business identifiers) --
  TENANT_SID: `${FHIR_BASE_URL}/sid/tenant`,
  USER_COGNITO_SUB_SID: `${FHIR_BASE_URL}/sid/user-cognito-sub`,
  STUDY_UID_SID: `${FHIR_BASE_URL}/sid/study-uid`,
  SERIES_UID_SID: `${FHIR_BASE_URL}/sid/series-uid`,
  SOP_INSTANCE_UID_SID: `${FHIR_BASE_URL}/sid/sop-instance-uid`,
  ANALYSIS_ID_SID: `${FHIR_BASE_URL}/sid/analysis-id`,
  REPORT_ID_SID: `${FHIR_BASE_URL}/sid/report-id`,
  LESION_ID_SID: `${FHIR_BASE_URL}/sid/lesion-id`,
  SEGMENTATION_ID_SID: `${FHIR_BASE_URL}/sid/segmentation-id`,
  MBOM_BUILD_SHA_SID: `${FHIR_BASE_URL}/sid/mbom-build-sha`,

  // -- LiverRa CodeSystems (project-private vocabularies) --
  LIVERRA_LESION_CLASS_CS: `${FHIR_BASE_URL}/CodeSystem/lesion-class`,
  LIVERRA_FLR_ADEQUACY_CS: `${FHIR_BASE_URL}/CodeSystem/flr-adequacy`,
  LIVERRA_IMPLAUSIBLE_REASON_CS: `${FHIR_BASE_URL}/CodeSystem/implausible-output-reason`,
  LIVERRA_ATYPICAL_ANATOMY_CS: `${FHIR_BASE_URL}/CodeSystem/atypical-anatomy-flags`,
  LIVERRA_PIPELINE_STAGE_CS: `${FHIR_BASE_URL}/CodeSystem/pipeline-stage`,
  LIVERRA_RUO_CLAIM_KEY_CS: `${FHIR_BASE_URL}/CodeSystem/ruo-claim-key`,
} as const;

// ============================================================================
// External (standards-body-owned) systems
// ============================================================================

/**
 * Standard, non-LiverRa FHIR/terminology URLs. These are owned by HL7, IHTSDO,
 * Regenstrief, NEMA, etc. — LiverRa MUST use the canonical forms below and
 * never invent aliases.
 */
export const EXTERNAL_SYSTEMS = {
  /** SNOMED CT (IHTSDO). Canonical URI for CodeableConcept.coding.system. */
  SNOMED: 'http://snomed.info/sct',

  /** LOINC (Regenstrief). */
  LOINC: 'http://loinc.org',

  /** DICOM UID identifier system (use for Study/Series/SOP UIDs cited as FHIR identifiers). */
  DICOM: 'urn:dicom:uid',

  /** DICOM Controlled Terminology (DCM) — for AuditEvent action/code + SR template IDs. */
  DICOM_DCM: 'http://dicom.nema.org/resources/ontology/DCM',

  /** RxNorm (NLM) — medication codes. */
  RXNORM: 'http://www.nlm.nih.gov/research/umls/rxnorm',

  /** ICD-10 + ICD-10-CM (HL7 SID). */
  ICD10: 'http://hl7.org/fhir/sid/icd-10',
  ICD10_CM: 'http://hl7.org/fhir/sid/icd-10-cm',

  /** UCUM (units of measure). */
  UCUM: 'http://unitsofmeasure.org',

  /** FHIR AuditEvent action CodeSystem. */
  AUDIT_EVENT_ACTION: 'http://hl7.org/fhir/audit-event-action',
} as const;

// ============================================================================
// Type helpers
// ============================================================================

export type FhirSystemKey = keyof typeof FHIR_SYSTEMS;
export type FhirSystemUrl = (typeof FHIR_SYSTEMS)[FhirSystemKey];

export type ExternalSystemKey = keyof typeof EXTERNAL_SYSTEMS;
export type ExternalSystemUrl = (typeof EXTERNAL_SYSTEMS)[ExternalSystemKey];
