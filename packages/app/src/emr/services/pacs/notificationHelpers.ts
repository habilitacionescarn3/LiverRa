// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Notification Helpers — shared by markAsReadService & radiologyReportService
// ============================================================================
// These helpers handle sending "findings available" notifications and resolving
// the ordering physician for an imaging study. Extracted here to avoid
// duplicating the same logic across multiple PACS service files.
//
// Phase-1 status (LiverRa):
//   The FHIR-dependent bits (Communication creation + ServiceRequest lookup)
//   are stubbed as no-ops. The LiverRa FHIR client shim (planned in Phase 4)
//   will replace the Medplum dependencies in the MediMind original. The pure
//   helpers (locale copy, `parseTimeline`) are fully ported.
//
// Ported from MediMind (services/pacs/notificationHelpers.ts).
// ============================================================================

import type { StatusTimelineEntry } from '../../types/pacs';

// Re-export so existing callers that reached for `StatusTimelineEntry` from
// this module keep compiling without chasing the new types location.
export type { StatusTimelineEntry };

// ---------------------------------------------------------------------------
// Minimal FHIR shapes (Phase-1 stubs)
// ---------------------------------------------------------------------------

/**
 * Minimal Reference shape used where MediMind's version imported
 * `@medplum/fhirtypes`. Kept structurally compatible with `Reference<T>`
 * so that the real FHIR types can be swapped in during Phase 4 without
 * touching call sites.
 */
export interface MinimalReference {
  reference?: string;
  display?: string;
  type?: string;
}

/**
 * Minimal FHIR client shape we rely on. Will be replaced with the LiverRa
 * `fhirClient.ts` shim in Phase 4.
 */
export interface MinimalFhirClient {
  createResource: (resource: Record<string, unknown>) => Promise<unknown>;
}

// ============================================================================
// Locale-aware notification messages
// ============================================================================

export const NOTIFICATION_MESSAGES: Record<string, { findingsAvailable: string; noOrderingPhysician: string }> = {
  en: {
    findingsAvailable: 'Findings available for imaging study',
    noOrderingPhysician: 'No ordering physician found — ServiceRequest missing or has no requester.',
  },
  ka: {
    findingsAvailable: 'მიგნებები ხელმისაწვდომია სურათების კვლევისთვის',
    noOrderingPhysician: 'დამნიშნავი ექიმი ვერ მოიძებნა — ServiceRequest არ არის ან მოთხოვნა არ აქვს.',
  },
  ru: {
    findingsAvailable: 'Результаты доступны для исследования',
    noOrderingPhysician: 'Назначивший врач не найден — ServiceRequest отсутствует или не указан заявитель.',
  },
};

// ============================================================================
// Send "findings available" notification
// ============================================================================

/**
 * Send a Communication notification that findings are available.
 *
 * TODO(phase-4): hook up real FHIR client via fhirClient.ts shim (to be
 * created). Should resolve the ordering physician from the associated
 * ServiceRequest and create a Communication resource mirroring MediMind's
 * implementation.
 *
 * @param _fhir Minimal FHIR client (stub parameter kept for signature parity)
 * @param studyId  Imaging study ID
 * @param patientId Patient ID
 * @param locale UI locale code; controls which message text is used
 */
export async function sendFindingsNotification(
  _fhir: MinimalFhirClient,
  studyId: string,
  patientId: string,
  locale: string = 'en'
): Promise<void> {
  // Stub: no-op until the FHIR client shim is wired up.
  // Parameters are accessed so TypeScript doesn't flag them as unused in
  // strict mode — preserves the original signature for future wiring.
  void studyId;
  void patientId;
  void locale;
  void NOTIFICATION_MESSAGES;
  return Promise.resolve();
}

// ============================================================================
// Resolve ordering practitioner
// ============================================================================

/**
 * Look up the ordering physician for an imaging study by finding the
 * associated ServiceRequest and extracting its requester field.
 *
 * TODO(phase-4): hook up real FHIR client via fhirClient.ts shim (to be
 * created). Should return a Reference to the Practitioner (resolving
 * PractitionerRole → Practitioner when needed), or null if the
 * ServiceRequest / requester cannot be found.
 *
 * @returns null in the Phase-1 stub — callers must tolerate the absence of
 *   a recipient until Phase 4.
 */
export async function resolveOrderingPractitioner(
  _fhir: MinimalFhirClient,
  _studyId: string
): Promise<MinimalReference | null> {
  // Stub: returns null (same shape the real lookup returns when no
  // ServiceRequest / requester exists), so callers behave identically.
  return Promise.resolve(null);
}

// ============================================================================
// Parse timeline
// ============================================================================

/**
 * Parse the timeline JSON string into an array of entries.
 * Returns an empty array if parsing fails.
 */
export function parseTimeline(value: string): StatusTimelineEntry[] {
  if (!value) {
    return [];
  }
  try {
    return JSON.parse(value) as StatusTimelineEntry[];
  } catch {
    return [];
  }
}
