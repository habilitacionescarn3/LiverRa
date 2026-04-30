// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// useStudyList (LiverRa)
// ============================================================================
// Loads a patient's imaging studies + pending orders, merges them into a
// single chronological list, and exposes loading/error state + a `refetch`.
//
// Ported from MediMind. Medplum dropped in favour of the LiverRa FHIR shim;
// otherwise byte-for-byte identical behaviour. Cancellation + mounted refs
// preserved because Vite + React 19 Strict Mode double-mounts this hook.
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLiverraFhir } from '../useLiverraFhir';
import type { ImagingStudyListItem } from '../../types/pacs';
import {
  listItemsByPatient,
  fetchPendingOrders,
  mergeStudiesAndOrders,
  type ServiceRequestLike,
} from '../../services/pacs/imagingStudyService';

// ============================================================================
// Types
// ============================================================================

interface UseStudyListOptions {
  /** FHIR Patient resource ID. */
  patientId: string;
  /** Only fetch when `true` (default `true`). Set `false` to defer. */
  enabled?: boolean;
}

interface UseStudyListReturn {
  /** Imaging studies for this patient, newest first. */
  studies: ImagingStudyListItem[];
  /** Imaging orders not yet fulfilled. */
  pendingOrders: ServiceRequestLike[];
  /** True during the initial fetch + every refetch. */
  isLoading: boolean;
  /** Error from the most recent fetch, or null. */
  error: Error | null;
  /** Trigger a fresh fetch of studies + orders. */
  refetch: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useStudyList({
  patientId,
  enabled = true,
}: UseStudyListOptions): UseStudyListReturn {
  const fhir = useLiverraFhir();
  const [studies, setStudies] = useState<ImagingStudyListItem[]>([]);
  const [pendingOrders, setPendingOrders] = useState<ServiceRequestLike[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track mount so we never `setState` after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Request-id counter — ignore stale responses when patientId flips.
  const fetchIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    if (!patientId) {
      setStudies([]);
      setPendingOrders([]);
      return;
    }

    const currentFetchId = ++fetchIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const [studyItems, orders] = await Promise.all([
        listItemsByPatient(fhir, patientId),
        fetchPendingOrders(fhir, patientId),
      ]);

      const mergedItems = mergeStudiesAndOrders(studyItems, orders);

      if (currentFetchId === fetchIdRef.current && mountedRef.current) {
        setStudies(mergedItems);
        setPendingOrders(orders);
      }
    } catch (err) {
      if (currentFetchId === fetchIdRef.current && mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (currentFetchId === fetchIdRef.current && mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [fhir, patientId]);

  useEffect(() => {
    if (enabled) {
      void fetchData();
    }
  }, [enabled, fetchData]);

  return {
    studies,
    pendingOrders,
    isLoading,
    error,
    refetch: fetchData,
  };
}
