// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useImageFilterReapply — re-apply active image filter when viewport scrolls
// ============================================================================
// useImageFilters caches original pixel data, but when the viewport shows a
// new image the pixels change entirely — so we clear and re-apply.
//
// PACS-M23: defer with `queueMicrotask` so the work runs after React commits
// the new viewport DOM but before the browser paints the next frame.
// `requestAnimationFrame` previously raced with the commit and could apply
// the filter to the stale viewport snapshot.
//
// Extracted from PACSViewer.tsx (PACS-H10).
// ============================================================================

import { useEffect, useRef } from 'react';
import type { ActiveFilter, FilterType, FilterStrength } from './useImageFilters';

export interface UseImageFilterReapplyOptions {
  currentImageIndex: number;
  activeFilter: ActiveFilter | null;
  clearFilter: () => void;
  dropOriginalCache: () => void;
  applyFilter: (type: FilterType, strength: FilterStrength) => void;
}

export function useImageFilterReapply({
  currentImageIndex,
  activeFilter,
  dropOriginalCache,
  applyFilter,
}: UseImageFilterReapplyOptions): void {
  const prevImageIndexRef = useRef(currentImageIndex);

  useEffect(() => {
    if (prevImageIndexRef.current !== currentImageIndex && activeFilter) {
      // Image changed — forget the prior slice's source pixels without writing
      // them into the newly displayed slice, then re-apply against the new data.
      const { type, strength } = activeFilter;
      dropOriginalCache();
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) applyFilter(type, strength);
      });
      prevImageIndexRef.current = currentImageIndex;
      return () => {
        cancelled = true;
      };
    }
    prevImageIndexRef.current = currentImageIndex;
    // LiverRa tsconfig enforces noImplicitReturns — explicit no-cleanup return.
    return undefined;
  }, [currentImageIndex, activeFilter, dropOriginalCache, applyFilter]);
}
