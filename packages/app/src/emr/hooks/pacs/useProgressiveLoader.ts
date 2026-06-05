// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useProgressiveLoader Hook
// ============================================================================
// Thin React wrapper around the ProgressiveLoader service. Makes loading
// progress reactive (state updates whenever the loader emits progress) and
// handles cleanup on unmount. Think of it as the "remote control" for the
// progressive loader — the loader does the heavy lifting, and this hook
// just wires the buttons (load, cancel, scroll) to React state.
//
// Key design decisions:
// - Uses a ref to hold the ProgressiveLoader instance (survives re-renders)
// - Wires the onProgress callback to a React setState for reactivity
// - Disposes the loader on unmount to prevent memory leaks
// ============================================================================

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  ProgressiveLoader,
  type LoadProgress,
  type ProgressiveLoaderConfig,
} from '../../services/pacs/progressiveLoader';

// ============================================================================
// Types
// ============================================================================

export interface UseProgressiveLoaderReturn {
  /** Start loading a study. Resolves when the initial batch is ready. */
  loadStudy: (instanceUrls: string[]) => Promise<void>;
  /** Current progress (reactive — updates on every batch) */
  progress: LoadProgress;
  /** Check if a study is large enough to need progressive loading */
  isLargeStudy: (count: number) => boolean;
  /** Update the priority index when the user scrolls to a new frame */
  setPriorityIndex: (index: number) => void;
  /** Check if a specific frame index has been loaded */
  isLoaded: (index: number) => boolean;
  /** Record that an image was accessed (keeps it in the LRU cache longer) */
  touchImage: (url: string) => void;
  /** Cancel background loading (already-loaded images stay) */
  cancel: () => void;
  /** Set the Bearer token used for prefetch requests. Call before loadStudy() if PACS requires auth. */
  setAuthToken: (token: string) => void;
}

// ============================================================================
// Initial state
// ============================================================================

const INITIAL_PROGRESS: LoadProgress = {
  total: 0,
  loaded: 0,
  percent: 0,
  status: 'idle',
};

// ============================================================================
// Hook
// ============================================================================

/**
 * React hook for progressive DICOM study loading.
 *
 * @param config - Optional configuration overrides (batch sizes, thresholds)
 * @returns Reactive loading controls and progress state
 *
 * @example
 * ```tsx
 * const { loadStudy, progress, setPriorityIndex } = useProgressiveLoader();
 *
 * useEffect(() => {
 *   if (instanceUrls.length > 0) {
 *     loadStudy(instanceUrls);
 *   }
 * }, [instanceUrls]);
 *
 * return <ProgressBar value={progress.percent} />;
 * ```
 */
export function useProgressiveLoader(
  config?: ProgressiveLoaderConfig
): UseProgressiveLoaderReturn {
  const [progress, setProgress] = useState<LoadProgress>(INITIAL_PROGRESS);
  const hasConfig = config !== undefined;
  const {
    largeStudyThreshold,
    initialBatchSize,
    backgroundBatchSize,
    maxImagesInMemory,
    evictionThreshold,
    batchDelayMs,
  } = config ?? {};

  // Stabilize config reference without mutating refs during render.
  const stableConfig = useMemo<ProgressiveLoaderConfig | undefined>(() => {
    if (!hasConfig) {
      return undefined;
    }
    return {
      largeStudyThreshold,
      initialBatchSize,
      backgroundBatchSize,
      maxImagesInMemory,
      evictionThreshold,
      batchDelayMs,
    };
  }, [
    hasConfig,
    largeStudyThreshold,
    initialBatchSize,
    backgroundBatchSize,
    maxImagesInMemory,
    evictionThreshold,
    batchDelayMs,
  ]);

  // Keep the loader in a ref so it survives re-renders without recreation
  const loaderRef = useRef<ProgressiveLoader | null>(null);

  // Lazily create the loader on first use
  const getLoader = useCallback((): ProgressiveLoader => {
    if (!loaderRef.current) {
      const loader = new ProgressiveLoader(stableConfig);
      loader.setOnProgress(setProgress);
      loaderRef.current = loader;
    }
    return loaderRef.current;
  }, [stableConfig]);

  // Dispose and recreate loader when config changes
  useEffect(() => {
    return () => {
      if (loaderRef.current) {
        loaderRef.current.dispose();
        loaderRef.current = null;
      }
    };
  }, [stableConfig]);

  // ---- Public API methods (stable references via useCallback) ----

  const loadStudy = useCallback(
    async (instanceUrls: string[]): Promise<void> => {
      const loader = getLoader();
      // Re-wire progress callback in case the loader was recreated
      loader.setOnProgress(setProgress);
      await loader.loadStudy(instanceUrls);
    },
    [getLoader]
  );

  const isLargeStudy = useCallback(
    (count: number): boolean => {
      return getLoader().isLargeStudy(count);
    },
    [getLoader]
  );

  const setPriorityIndex = useCallback(
    (index: number): void => {
      getLoader().setPriorityIndex(index);
    },
    [getLoader]
  );

  const isLoaded = useCallback(
    (index: number): boolean => {
      return getLoader().isLoaded(index);
    },
    [getLoader]
  );

  const touchImage = useCallback(
    (url: string): void => {
      getLoader().touchImage(url);
    },
    [getLoader]
  );

  const cancel = useCallback((): void => {
    getLoader().cancel();
  }, [getLoader]);

  const setAuthToken = useCallback(
    (token: string): void => {
      getLoader().setAuthToken(token);
    },
    [getLoader]
  );

  // ---- Cleanup on unmount ----

  useEffect(() => {
    return () => {
      if (loaderRef.current) {
        loaderRef.current.dispose();
        loaderRef.current = null;
      }
    };
  }, []);

  return {
    loadStudy,
    progress,
    isLargeStudy,
    setPriorityIndex,
    isLoaded,
    touchImage,
    cancel,
    setAuthToken,
  };
}
