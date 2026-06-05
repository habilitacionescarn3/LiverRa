// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// usePacsReachability Hook
// ============================================================================
// Pings the PACS Bridge `/health` endpoint to verify that Orthanc + the bridge
// proxy are reachable. Used to gate the imaging worklist and the Save/Load-to-PACS
// buttons so users don't see studies they can't actually open.
//
// This is distinct from `useCloudConnectivity` — that hook monitors Medplum
// Cloud (the FHIR server). This hook monitors the on-prem DICOM stack.
// ============================================================================

import { useEffect, useRef, useState, useCallback } from 'react';

export type PacsReachabilityStatus = 'checking' | 'reachable' | 'unreachable';

export interface UsePacsReachabilityReturn {
  status: PacsReachabilityStatus;
  isReachable: boolean;
  /** Force an immediate re-check. */
  checkNow: () => Promise<void>;
}

// LiverRa: typed via local narrow — this tsconfig doesn't load vite/client.
const PACS_BRIDGE_URL =
  (import.meta as ImportMeta & { env?: { VITE_PACS_BRIDGE_URL?: string } }).env
    ?.VITE_PACS_BRIDGE_URL || '/pacs-bridge';
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 3_000;

async function pingPacsBridge(signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${PACS_BRIDGE_URL}/health`, { signal, method: 'GET' });
    return res.ok;
  } catch (err) {
    // The ping is aborted on the 3s timeout and on unmount/re-run — an expected
    // AbortError, not a real failure. Treat as unreachable without logging noise.
    if ((err as Error)?.name === 'AbortError') {
      return false;
    }
    console.warn('[usePacsReachability] PACS bridge ping failed:', err);
    return false;
  }
}

export function usePacsReachability(): UsePacsReachabilityReturn {
  const [status, setStatus] = useState<PacsReachabilityStatus>('checking');
  const abortRef = useRef<AbortController | null>(null);

  const runCheck = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // Distinguish *our own* timeout (a real "bridge is unreachable" signal) from
    // an abort caused by a newer check superseding this one (StrictMode
    // double-mount, an overlapping interval tick, or a manual Retry mid-flight).
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PING_TIMEOUT_MS);
    const ok = await pingPacsBridge(controller.signal);
    clearTimeout(timer);
    // Only the current check may write status. A superseded ping (aborted by a
    // newer runCheck or by unmount) must NOT be read as "server down" — that was
    // the source of the red banner flashing on initial load. A genuine timeout
    // (timedOut) is still allowed through so real outages surface.
    if (abortRef.current !== controller && !timedOut) {
      return;
    }
    setStatus(ok ? 'reachable' : 'unreachable');
  }, []);

  useEffect(() => {
    // The initial 'checking' state is intentional UI (gates the worklist with a
    // "verifying PACS connection" affordance instead of flashing reachable /
    // unreachable). runCheck only writes status AFTER `await pingPacsBridge` —
    // i.e. in a later microtask, never synchronously inside this effect — so the
    // cascading-render concern the rule guards against does not apply here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runCheck().catch((err) => {
      console.warn('[usePacsReachability] best-effort PACS operation failed:', err);
    });
    const interval = setInterval(() => {
      runCheck().catch((err) => {
        console.warn('[usePacsReachability] best-effort PACS operation failed:', err);
      });
    }, PING_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
      // Clear the ref so any in-flight check fails the identity guard and skips
      // its setStatus after unmount.
      abortRef.current = null;
    };
  }, [runCheck]);

  return {
    status,
    isReachable: status === 'reachable',
    checkNow: runCheck,
  };
}
