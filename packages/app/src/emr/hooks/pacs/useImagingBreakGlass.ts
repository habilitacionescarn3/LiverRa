// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useImagingBreakGlass — Hook for imaging-specific break-glass emergency access
// ============================================================================
// Think of this like a "fire alarm glass box" for imaging data: normally you
// can't access restricted studies, but in an emergency you can "break the glass"
// to get temporary (4-hour) access. Every break-glass event is logged as a
// FHIR AuditEvent and triggers a security alert to the admin team.
//
// This hook manages:
// 1. Checking if the user already has active break-glass access
// 2. Requesting new break-glass access (creates AuditEvent + Communication alert)
// 3. Tracking expiration (4 hours from grant time)
//
// Phase-4 status (LiverRa):
//   All persistence flows through `auditService.ts`, which is routed through
//   `LiverRaFhirClient` (the FHIR stub). Phase 4 wires the real Supabase
//   audit_events table so these AuditEvents land in a tamper-evident log.
//
// Ported from MediMind (hooks/pacs/useImagingBreakGlass.ts) verbatim —
// the service layer already handled the Medplum → LiverRa swap.
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  logImagingBreakGlassAccess,
  sendBreakGlassAlert,
  getActiveImagingBreakGlass,
  IMAGING_BTG_DURATION_MS,
  type ImagingBreakGlassRequest,
} from '../../services/pacs/auditService';

// ============================================================================
// Types
// ============================================================================

export interface ImagingBreakGlassResult {
  /** Whether access was granted */
  granted: boolean;
  /** ISO timestamp when access expires */
  expiresAt?: string;
  /** Error message if not granted */
  error?: string;
  /** The AuditEvent resource ID */
  auditEventId?: string;
}

export interface UseImagingBreakGlassReturn {
  /** Request break-glass access for a patient's imaging data */
  requestAccess: (reason: string) => Promise<ImagingBreakGlassResult>;
  /** Revoke active break-glass access (client-side only) */
  revokeAccess: () => void;
  /** Whether a request is in progress */
  loading: boolean;
  /** Whether the user currently has active break-glass access */
  hasActiveAccess: boolean;
  /** ISO timestamp when access expires (if active) */
  expiresAt: string | null;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for imaging-specific break-glass access (4-hour window).
 *
 * @param patientId - FHIR Patient resource ID
 * @param studyId - Optional FHIR ImagingStudy resource ID
 * @returns Object with requestAccess, revokeAccess, loading, hasActiveAccess, expiresAt
 *
 * @example
 * ```typescript
 * const { requestAccess, hasActiveAccess } = useImagingBreakGlass('patient-123');
 *
 * if (!hasActiveAccess) {
 *   const result = await requestAccess('Emergency: patient coding, need prior imaging');
 * }
 * ```
 */
export function useImagingBreakGlass(
  patientId: string,
  studyId?: string
): UseImagingBreakGlassReturn {
  const [loading, setLoading] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const auditEventId = useRef<string | undefined>();
  const serverCheckDone = useRef(false);

  // On mount, check server for existing active break-glass access
  useEffect(() => {
    if (!patientId || serverCheckDone.current) {
      return;
    }

    let cancelled = false;

    const checkExisting = async (): Promise<void> => {
      try {
        const validEvent = await getActiveImagingBreakGlass(patientId);

        if (cancelled) {
          return;
        }

        if (validEvent?.recorded) {
          const recordedMs = new Date(validEvent.recorded).getTime();
          const expMs = recordedMs + IMAGING_BTG_DURATION_MS;
          setExpiresAt(new Date(expMs).toISOString());
          auditEventId.current = validEvent.id;
        }
      } catch {
        // Fail closed — no access
      } finally {
        serverCheckDone.current = true;
      }
    };

    checkExisting();

    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const requestAccess = useCallback(
    async (reason: string): Promise<ImagingBreakGlassResult> => {
      if (!patientId) {
        return { granted: false, error: 'No patient ID' };
      }

      if (!reason || reason.length < 10) {
        return { granted: false, error: 'Reason must be at least 10 characters' };
      }

      setLoading(true);
      try {
        const request: ImagingBreakGlassRequest = {
          reason,
          patientId,
          studyId,
        };

        // Create the BTG AuditEvent
        const auditEvent = await logImagingBreakGlassAccess(request);

        if (!auditEvent?.id) {
          return { granted: false, error: 'Failed to create audit event' };
        }

        // Send Communication alert to security team (fire-and-forget)
        sendBreakGlassAlert(request, auditEvent.id);

        // Calculate expiration from server-recorded timestamp
        const recordedMs = auditEvent.recorded
          ? new Date(auditEvent.recorded).getTime()
          : Date.now();
        const expMs = recordedMs + IMAGING_BTG_DURATION_MS;
        const expIso = new Date(expMs).toISOString();

        setExpiresAt(expIso);
        auditEventId.current = auditEvent.id;

        return {
          granted: true,
          expiresAt: expIso,
          auditEventId: auditEvent.id,
        };
      } catch {
        return { granted: false, error: 'Failed to grant break-glass access' };
      } finally {
        setLoading(false);
      }
    },
    [patientId, studyId]
  );

  const revokeAccess = useCallback(() => {
    setExpiresAt(null);
    auditEventId.current = undefined;
  }, []);

  // Auto-expiry timer: forces re-render when break-glass access expires,
  // so hasActiveAccess transitions to false at exactly the right moment
  useEffect(() => {
    if (!expiresAt) {
      return;
    }

    const remainingMs = new Date(expiresAt).getTime() - Date.now();

    // Already expired — clear immediately
    if (remainingMs <= 0) {
      setExpiresAt(null);
      return;
    }

    const timer = setTimeout(() => {
      setExpiresAt(null);
    }, remainingMs);

    return () => clearTimeout(timer);
  }, [expiresAt]);

  // Active if we have an expiration time in the future
  const hasActiveAccess = !!expiresAt && new Date(expiresAt) > new Date();

  return {
    requestAccess,
    revokeAccess,
    loading,
    hasActiveAccess,
    expiresAt,
  };
}
