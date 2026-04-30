// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// useReadingWorklist (LiverRa)
// ============================================================================
// Auto-refreshing hook that drives the radiology reading worklist. Every 30s
// it re-fetches unread studies, sorts them by priority + wait time, and
// exposes pagination + optimistic removal (so clicking a study in the list
// feels instant even before the server confirms the status change).
//
// Ported from MediMind. Medplum → LiverRa FHIR shim; the `useEventSubscription`
// real-time subscription is dropped (LiverRa doesn't run an event engine
// yet — Phase 4 will revisit). Polling still keeps the board fresh in the
// meantime.
// ============================================================================

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLiverraFhir } from '../useLiverraFhir';
import type {
  ReadingWorklistItem,
  ReadingWorklistFilters,
} from '../../types/pacs';
import { getWorklistItems } from '../../services/pacs/readingWorklistService';
import { worklistTimer } from '../../services/pacs/pacsPerformance';

// ============================================================================
// Constants
// ============================================================================

/** Auto-refresh cadence (30 seconds). */
const REFETCH_INTERVAL_MS = 30_000;

/** Staleness window — skip refetch if we just fetched within this window. */
const STALE_TIME_MS = 10_000;

// ============================================================================
// Types
// ============================================================================

export interface UseReadingWorklistReturn {
  /** Sorted worklist items (priority + wait time). */
  items: ReadingWorklistItem[];
  /** True during the first load / a manual refetch. */
  isLoading: boolean;
  /** Error from the most recent fetch, or null. */
  error: Error | null;
  /** Currently applied filters. */
  filters: ReadingWorklistFilters;
  /** Partial-update the filter state. */
  setFilters: (updates: Partial<ReadingWorklistFilters>) => void;
  /** Reset filters to defaults. */
  clearFilters: () => void;
  /** Count of overdue STAT studies (wait > 30 min). */
  overdueCount: number;
  /** Optimistically hide an item (e.g. when the radiologist opens it). */
  removeFromWorklist: (studyId: string) => void;
  /** Manually trigger a refetch. */
  refetch: () => void;
  /** Timestamp of the last successful fetch. */
  lastUpdated: Date | null;
  /** Next study following `currentStudyId`, or the first item when absent. */
  getNextStudy: (currentStudyId: string) => ReadingWorklistItem | null;
  /** Pagination — true when more results are available. */
  hasMore: boolean;
  /** Load the next page. */
  loadMore: () => void;
  /** True while loading more. */
  isLoadingMore: boolean;
}

// ============================================================================
// Hook
// ============================================================================

const EMPTY_FILTERS: ReadingWorklistFilters = {};

export function useReadingWorklist(): UseReadingWorklistReturn {
  const fhir = useLiverraFhir();

  const [items, setItems] = useState<ReadingWorklistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [filters, setFiltersState] = useState<ReadingWorklistFilters>(EMPTY_FILTERS);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchIdRef = useRef(0);
  const lastFetchTimeRef = useRef(0);
  const removedIdsRef = useRef(new Set<string>());

  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const offsetRef = useRef(0);
  const PAGE_SIZE = 200;

  // --------------------------------------------------------------------------
  // Fetch data
  // --------------------------------------------------------------------------
  const fetchData = useCallback(
    async (force = false) => {
      if (!force && Date.now() - lastFetchTimeRef.current < STALE_TIME_MS) {
        return;
      }

      const currentFetchId = ++fetchIdRef.current;
      setIsLoading(true);
      setError(null);
      worklistTimer.start();

      try {
        offsetRef.current = 0;
        const result = await getWorklistItems(fhir, filters, 0, PAGE_SIZE);
        worklistTimer.stop();

        if (currentFetchId === fetchIdRef.current && mountedRef.current) {
          const filteredResult = result.items.filter(
            (item) => !removedIdsRef.current.has(item.id)
          );
          setItems(filteredResult);
          setHasMore(result.hasMore);
          offsetRef.current = PAGE_SIZE;
          setLastUpdated(new Date());
          lastFetchTimeRef.current = Date.now();
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
    },
    [fhir, filters]
  );

  // --------------------------------------------------------------------------
  // Auto-refresh every 30 seconds
  // --------------------------------------------------------------------------
  useEffect(() => {
    void fetchData(true);
    const intervalId = setInterval(() => {
      void fetchData(true);
    }, REFETCH_INTERVAL_MS);
    return () => {
      clearInterval(intervalId);
    };
  }, [fetchData]);

  // --------------------------------------------------------------------------
  // Filters
  // --------------------------------------------------------------------------
  const setFilters = useCallback((updates: Partial<ReadingWorklistFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...updates }));
    removedIdsRef.current.clear();
  }, []);

  const clearFilters = useCallback(() => {
    setFiltersState(EMPTY_FILTERS);
    removedIdsRef.current.clear();
  }, []);

  // --------------------------------------------------------------------------
  // Optimistic removal
  // --------------------------------------------------------------------------
  const removeFromWorklist = useCallback((studyId: string) => {
    removedIdsRef.current.add(studyId);
    setItems((prev) => prev.filter((item) => item.id !== studyId));
  }, []);

  // --------------------------------------------------------------------------
  // Manual refetch
  // --------------------------------------------------------------------------
  const refetch = useCallback(() => {
    removedIdsRef.current.clear();
    void fetchData(true);
  }, [fetchData]);

  // --------------------------------------------------------------------------
  // Next-study navigation
  // --------------------------------------------------------------------------
  const getNextStudy = useCallback(
    (currentStudyId: string): ReadingWorklistItem | null => {
      if (items.length === 0) return null;
      const currentIndex = items.findIndex((item) => item.id === currentStudyId);
      if (currentIndex === -1) {
        return items[0] || null;
      }
      const nextIndex = currentIndex + 1 < items.length ? currentIndex + 1 : 0;
      if (items[nextIndex]?.id === currentStudyId) return null;
      return items[nextIndex] || null;
    },
    [items]
  );

  // --------------------------------------------------------------------------
  // Pagination
  // --------------------------------------------------------------------------
  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const result = await getWorklistItems(
        fhir,
        filters,
        offsetRef.current,
        PAGE_SIZE
      );
      if (mountedRef.current) {
        const newItems = result.items.filter(
          (item) => !removedIdsRef.current.has(item.id)
        );
        setItems((prev) => [...prev, ...newItems]);
        setHasMore(result.hasMore);
        offsetRef.current += PAGE_SIZE;
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (mountedRef.current) {
        setIsLoadingMore(false);
      }
    }
  }, [fhir, filters, hasMore, isLoadingMore]);

  // --------------------------------------------------------------------------
  // Derived: overdue STAT count
  // --------------------------------------------------------------------------
  const overdueCount = useMemo(
    () => items.filter((item) => item.isOverdue).length,
    [items]
  );

  return {
    items,
    isLoading,
    error,
    filters,
    setFilters,
    clearFilters,
    overdueCount,
    removeFromWorklist,
    refetch,
    lastUpdated,
    getNextStudy,
    hasMore,
    loadMore,
    isLoadingMore,
  };
}
