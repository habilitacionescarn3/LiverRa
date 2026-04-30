// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useCloudConnectivity Hook
// ============================================================================
// Monitors connectivity to the cloud FHIR server and provides a degraded mode
// when the connection drops. Think of it like an airplane mode indicator —
// when the cloud goes offline, the PACS viewer still works for viewing images
// (from the local Orthanc server), but cloud features like annotations and
// reports are disabled until it reconnects.
//
// Phase-1 status (LiverRa):
//   This hook currently returns `online` unconditionally. The real
//   connectivity probe — originally an authenticated Medplum
//   `fhir/R4/metadata` round-trip in MediMind — will be re-wired in Phase 4
//   against LiverRa's FHIR client shim (AWS Cognito + Supabase-backed FHIR)
//   plus an Orthanc health-check. Keeping the shape stable lets the PACS
//   viewer import this hook today without pulling Medplum into the bundle.
//
// Ported from MediMind (hooks/pacs/useCloudConnectivity.ts). Medplum stripped.
// ============================================================================

import { useState, useCallback, useRef, useEffect } from 'react';

// ============================================================================
// Types
// ============================================================================

export type CloudStatus = 'online' | 'offline' | 'checking';

export interface UseCloudConnectivityReturn {
  /** Current cloud connectivity status */
  status: CloudStatus;
  /** Whether the cloud is online (shorthand for status === 'online') */
  isOnline: boolean;
  /** Whether FHIR-dependent features should be disabled */
  isMedplumDisabled: boolean;
  /** Number of consecutive failed pings */
  failedPings: number;
  /** When the last successful ping occurred (null if never) */
  lastOnlineAt: Date | null;
  /** Force an immediate connectivity check */
  checkNow: () => Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

/** How often to ping (milliseconds) */
const PING_INTERVAL_MS = 30_000; // 30 seconds

// ============================================================================
// Hook
// ============================================================================

export function useCloudConnectivity(): UseCloudConnectivityReturn {
  // TODO(phase-4): hook up real FHIR client via fhirClient.ts shim (to be
  // created). For now we assume the cloud is always reachable so downstream
  // PACS components can render without a reachable FHIR server during bring-up.
  const [status] = useState<CloudStatus>('online');
  const [failedPings] = useState(0);
  const [lastOnlineAt] = useState<Date | null>(() => new Date());

  const mountedRef = useRef(true);

  // --------------------------------------------------------------------------
  // checkNow — stub. Resolves immediately with status unchanged.
  // --------------------------------------------------------------------------
  const checkNow = useCallback(async (): Promise<void> => {
    // TODO(phase-4): replace with actual FHIR metadata probe + Orthanc
    // health-check. Must respect `mountedRef` and update `status`,
    // `failedPings`, and `lastOnlineAt` per MediMind's original behaviour
    // (threshold: 2 consecutive failures → 'offline').
    if (!mountedRef.current) {
      return;
    }
    return Promise.resolve();
  }, []);

  // --------------------------------------------------------------------------
  // Lifecycle — keep the periodic-ping scaffolding so the hook signature
  // matches MediMind. The interval currently no-ops but preserves the
  // mount/unmount contract expected by consumers.
  // --------------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;

    // Do an initial check after a short delay (don't block first render)
    const initialTimeout = setTimeout(() => {
      void checkNow();
    }, 3_000);

    // Then check every PING_INTERVAL_MS
    const intervalId = setInterval(() => {
      void checkNow();
    }, PING_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearTimeout(initialTimeout);
      clearInterval(intervalId);
    };
  }, [checkNow]);

  // --------------------------------------------------------------------------
  // Derived values
  // --------------------------------------------------------------------------
  const isOnline = status === 'online';
  const isMedplumDisabled = status === 'offline';

  return {
    status,
    isOnline,
    isMedplumDisabled,
    failedPings,
    lastOnlineAt,
    checkNow,
  };
}
