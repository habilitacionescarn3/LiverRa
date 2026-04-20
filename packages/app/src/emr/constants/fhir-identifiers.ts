// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * LiverRa — FHIR Identifier Naming Systems
 *
 * Declarative manifest of every identifier system LiverRa issues. Used by:
 *   - FHIR validators (prove each identifier.system is a known, described namespace).
 *   - Medplum bootstrap (registers `NamingSystem` resources per tenant).
 *   - UI helpers that need a human label for an identifier badge.
 *
 * Plain-English analogy:
 *   A NamingSystem is the "issuing authority" stamped on an ID card. Georgia's
 *   national ID has one issuer; LiverRa internal Study IDs have another; etc.
 */

import { FHIR_SYSTEMS } from './fhir-systems';

/** Shape of a LiverRa identifier-system entry. */
export interface LiverRaIdentifierSystemEntry {
  /** Canonical FHIR identifier.system URL (from `FHIR_SYSTEMS`). */
  system: string;
  /** Human-readable label for the UI / documentation. */
  display: string;
  /** Optional ISO OID root if the identifier is ever externalized as an OID URN. */
  oidRoot?: string;
}

/**
 * Every LiverRa-issued identifier system. Keys mirror `FHIR_SYSTEMS.*_SID`
 * constants for a 1:1 lookup.
 */
export const LIVERRA_IDENTIFIER_SYSTEMS = {
  TENANT: {
    system: FHIR_SYSTEMS.TENANT_SID,
    display: 'LiverRa Tenant Identifier',
  },
  USER_COGNITO_SUB: {
    system: FHIR_SYSTEMS.USER_COGNITO_SUB_SID,
    display: 'AWS Cognito Sub (LiverRa user identity)',
  },
  STUDY_UID: {
    system: FHIR_SYSTEMS.STUDY_UID_SID,
    display: 'DICOM Study Instance UID (LiverRa-scoped)',
  },
  SERIES_UID: {
    system: FHIR_SYSTEMS.SERIES_UID_SID,
    display: 'DICOM Series Instance UID (LiverRa-scoped)',
  },
  SOP_INSTANCE_UID: {
    system: FHIR_SYSTEMS.SOP_INSTANCE_UID_SID,
    display: 'DICOM SOP Instance UID (LiverRa-scoped)',
  },
  ANALYSIS_ID: {
    system: FHIR_SYSTEMS.ANALYSIS_ID_SID,
    display: 'LiverRa Analysis ID',
  },
  REPORT_ID: {
    system: FHIR_SYSTEMS.REPORT_ID_SID,
    display: 'LiverRa Report ID',
  },
  LESION_ID: {
    system: FHIR_SYSTEMS.LESION_ID_SID,
    display: 'LiverRa Lesion ID',
  },
  SEGMENTATION_ID: {
    system: FHIR_SYSTEMS.SEGMENTATION_ID_SID,
    display: 'LiverRa Segmentation ID',
  },
  MBOM_BUILD_SHA: {
    system: FHIR_SYSTEMS.MBOM_BUILD_SHA_SID,
    display: 'LiverRa MBoM Build SHA',
  },
} as const satisfies Record<string, LiverRaIdentifierSystemEntry>;

export type LiverRaIdentifierSystemKey = keyof typeof LIVERRA_IDENTIFIER_SYSTEMS;
