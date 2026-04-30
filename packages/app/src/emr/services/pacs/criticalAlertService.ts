// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Critical Alert Service
// ============================================================================
// FHIR data layer for radiology critical finding alerts.
// Uses Communication resources to create, acknowledge, and track urgent
// findings that require immediate clinical attention.
//
// Think of this like a hospital's "critical results" hotline — when a
// radiologist spots a life-threatening finding (e.g., hepatic arterial
// bleed), they create an alert that the ordering doctor must acknowledge.
//
// Phase-4 status (LiverRa):
//   The persistence layer routes through `LiverRaFhirClient`, which is the
//   stubbed `fhirClient.ts`. Creates echo back, acknowledges are no-ops,
//   searches return an empty bundle. Phase 4 wires Supabase-backed FHIR.
//
// Ported from MediMind (services/pacs/criticalAlertService.ts) with:
//   - `MedplumClient` → `LiverRaFhirClient` (kept method surface identical).
//   - `@medplum/fhirtypes` Communication inlined as a local minimal shape.
//   - `fhir-systems` constants inlined locally under `http://liverra.ai/fhir`
//     namespace — Phase 4 may relocate these into the central constants module.
//   - `requirePermission(..., 'manage-imaging')` removed (LiverRa permission
//     model is RBAC via Cognito + Guarded, wired in Phase 4).
//   - `updateWithIfMatch` optimistic locking swapped for a direct
//     `updateResource` call (Phase 4 will wire the real ETag-based flow).
// ============================================================================

import type { LiverRaFhirClient, FhirResourceLike } from '../fhirClient';
import { FHIR_BASE_URL } from '../../constants/fhir-systems';

// ============================================================================
// Minimal FHIR shape (inlined — Phase 4 may swap for richer FHIR type)
// ============================================================================

/** Minimal FHIR Communication shape used by this service. */
interface Communication extends FhirResourceLike {
  resourceType: 'Communication';
  id?: string;
  status?: string;
  priority?: 'routine' | 'urgent' | 'asap' | 'stat' | string;
  category?: Array<{
    coding?: Array<{ system?: string; code?: string; display?: string }>;
  }>;
  subject?: { reference?: string };
  recipient?: Array<{ reference?: string }>;
  about?: Array<{ reference?: string }>;
  payload?: Array<{ contentString?: string }>;
  sent?: string;
  received?: string;
}

// ============================================================================
// Inline constants (Phase 4 may centralize into fhir-systems.ts)
// ============================================================================

/** LiverRa-owned CodeSystem for Communication categories. */
const COMMUNICATION_CATEGORY_CS = `${FHIR_BASE_URL}/CodeSystem/communication-category` as const;
/** Code for "Critical Radiology Finding" within the communication category CS. */
const CRITICAL_FINDING_CODE = 'critical-finding';

// ============================================================================
// Types
// ============================================================================

export type AlertSeverity = 'critical' | 'urgent' | 'high';

export interface CreateCriticalAlertParams {
  /** Severity level of the finding */
  severity: AlertSeverity;
  /** Description of the critical finding */
  finding: string;
  /** Practitioner ID of the recipient (ordering doctor) */
  recipientId: string;
  /** DiagnosticReport ID the finding is from */
  reportId: string;
  /** Patient ID */
  patientId: string;
}

export interface CriticalAlert {
  /** Communication resource ID */
  id: string;
  /** Severity of the finding */
  severity: AlertSeverity;
  /** Description of the finding */
  finding: string;
  /** Patient reference */
  patientId: string;
  /** Report reference */
  reportId: string;
  /** Recipient practitioner ID */
  recipientId: string;
  /** When the alert was sent */
  sentAt: string;
  /** Whether the alert has been acknowledged */
  acknowledged: boolean;
  /** When the alert was acknowledged (if applicable) */
  acknowledgedAt?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Priority mapping for Communication.priority */
const SEVERITY_TO_PRIORITY: Record<AlertSeverity, 'stat' | 'urgent'> = {
  critical: 'stat',
  urgent: 'urgent',
  high: 'urgent',
};

// ============================================================================
// Core Operations
// ============================================================================

/**
 * Create a critical finding alert as a FHIR Communication resource.
 * The alert is sent to the ordering doctor and requires acknowledgment.
 *
 * TODO(phase-4-supabase): Phase 4 plan wires this through Supabase FHIR +
 * notification fan-out (pager/email/SMS). Today the stub echoes the
 * Communication input back without persistence.
 */
export async function createCriticalAlert(
  fhir: LiverRaFhirClient,
  params: CreateCriticalAlertParams
): Promise<CriticalAlert> {
  const { severity, finding, recipientId, reportId, patientId } = params;

  const communication: Communication = {
    resourceType: 'Communication',
    status: 'in-progress',
    priority: SEVERITY_TO_PRIORITY[severity],
    category: [
      {
        coding: [
          {
            system: COMMUNICATION_CATEGORY_CS,
            code: CRITICAL_FINDING_CODE,
            display: 'Critical Radiology Finding',
          },
        ],
      },
    ],
    subject: { reference: `Patient/${patientId}` },
    recipient: [
      { reference: `Practitioner/${recipientId}` },
    ],
    about: [
      { reference: `DiagnosticReport/${reportId}` },
    ],
    payload: [
      {
        contentString: JSON.stringify({
          severity,
          finding,
        }),
      },
    ],
    sent: new Date().toISOString(),
  };

  const saved = await fhir.createResource(communication);

  if (!saved.id) {
    // Stub path — the FHIR stub echoes back without assigning an id.
    // Generate a deterministic local id so the UI has something to key on
    // until Phase 4 wires the server-assigned id.
    saved.id = `pending-${Date.now()}`;
  }

  return parseCommunicationToAlert(saved);
}

/**
 * Acknowledge a critical alert by updating its Communication status to 'completed'.
 *
 * TODO(phase-4-supabase): Phase 4 plan wires ETag-based optimistic locking
 * via Supabase. Today we just update-in-place through the stub.
 */
export async function acknowledgeCriticalAlert(
  fhir: LiverRaFhirClient,
  communicationId: string
): Promise<void> {
  const existing = await fhir.readResource('Communication', communicationId);
  if (!existing) {
    return;
  }

  await fhir.updateResource({
    ...(existing as Communication),
    id: communicationId,
    resourceType: 'Communication',
    status: 'completed',
    received: new Date().toISOString(),
  });
}

/**
 * Fetch all active (unacknowledged) critical alerts.
 * Active means status is 'in-progress' (not yet acknowledged).
 * Optionally filter by recipient practitioner ID.
 *
 * TODO(phase-4-supabase): Phase 4 plan wires the real search; today the
 * stub returns an empty bundle.
 */
export async function getActiveAlerts(
  fhir: LiverRaFhirClient,
  practitionerId?: string
): Promise<CriticalAlert[]> {
  const searchParams: Record<string, string> = {
    category: `${COMMUNICATION_CATEGORY_CS}|${CRITICAL_FINDING_CODE}`,
    status: 'in-progress',
    _sort: '-sent',
    _count: '100',
  };

  if (practitionerId) {
    searchParams.recipient = `Practitioner/${practitionerId}`;
  }

  const bundle = await fhir.search('Communication', searchParams);

  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((r): r is FhirResourceLike => Boolean(r))
    .map((r) => r as Communication)
    .filter((comm) => comm.id)
    .map(parseCommunicationToAlert);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a Communication resource into a CriticalAlert.
 */
function parseCommunicationToAlert(comm: Communication): CriticalAlert {
  let severity: AlertSeverity = 'high';
  let finding = '';

  // Parse payload JSON
  const payloadStr = comm.payload?.[0]?.contentString;
  if (payloadStr) {
    try {
      const parsed = JSON.parse(payloadStr) as { severity?: AlertSeverity; finding?: string };
      severity = parsed.severity ?? 'high';
      finding = parsed.finding ?? '';
    } catch {
      finding = payloadStr;
    }
  }

  // Extract references
  const patientId = comm.subject?.reference?.replace('Patient/', '') ?? '';
  const reportId = comm.about?.[0]?.reference?.replace('DiagnosticReport/', '') ?? '';
  const recipientId = comm.recipient?.[0]?.reference?.replace('Practitioner/', '') ?? '';

  return {
    id: comm.id as string,
    severity,
    finding,
    patientId,
    reportId,
    recipientId,
    sentAt: comm.sent ?? new Date().toISOString(),
    acknowledged: comm.status === 'completed',
    acknowledgedAt: comm.received ?? undefined,
  };
}

/**
 * Check if an alert is overdue for escalation (past the given threshold).
 * @param alert - The alert to check
 * @param thresholdMs - Escalation threshold in milliseconds (default: 30 minutes)
 */
export function isEscalationDue(
  alert: CriticalAlert,
  thresholdMs = 30 * 60 * 1000
): boolean {
  if (alert.acknowledged) return false;
  const sentTime = new Date(alert.sentAt).getTime();
  if (isNaN(sentTime)) return true; // Fail-open: corrupt dates trigger escalation for safety
  return Date.now() - sentTime >= thresholdMs;
}
