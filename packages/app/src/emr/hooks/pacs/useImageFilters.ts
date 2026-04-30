// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useImageFilters Hook — Image Filter State Management
// ============================================================================
// Provides sharpen/smooth filters for medical images in the PACS viewer.
// Think of it like Instagram filters but for CT scans — applying convolution
// kernels to pixel data to make images clearer (sharpen) or reduce noise (smooth).
//
// How it works:
//   1. User picks a filter type (sharpen/smooth) and strength (light/medium/strong)
//   2. We grab the viewport's current pixel data
//   3. We delegate to imageFilterService which applies the convolution kernel
//   4. The viewport re-renders with the filtered pixels
//   5. We keep the original pixels cached so "Clear Filter" can restore them instantly
//
// Ported from MediMind (hooks/pacs/useImageFilters.ts). No Medplum dependency.
// ============================================================================

import { useState, useCallback, useRef } from 'react';
import { applyFilter as applyServiceFilter } from '../../services/pacs/imageFilterService';
import type { FilterType, FilterStrength } from '../../services/pacs/imageFilterService';

// Re-export types so consumers don't need to import from the service directly
export type { FilterType, FilterStrength };

// ============================================================================
// Types
// ============================================================================

/** Active filter state — null means no filter applied */
export interface ActiveFilter {
  type: FilterType;
  strength: FilterStrength;
}

/** Return type for the useImageFilters hook */
export interface UseImageFiltersReturn {
  /** Currently active filter, or null if no filter applied */
  activeFilter: ActiveFilter | null;
  /** Apply a filter — sets state, applies convolution to viewport pixel data */
  applyFilter: (type: FilterType, strength: FilterStrength) => void;
  /** Clear the filter — restore original pixel data */
  clearFilter: () => void;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * React hook for applying image filters (sharpen/smooth) to the PACS viewport.
 *
 * @param getViewport - Function that returns the current Cornerstone viewport.
 *   Typically `() => renderingEngine.getViewport(activeViewportId)`.
 *   Returns null/undefined if no viewport is active.
 *
 * @returns { activeFilter, applyFilter, clearFilter }
 */
export function useImageFilters(
  getViewport: () => { getImageData?: () => { scalarData: { set: (arr: ArrayLike<number>) => void; length: number } & ArrayLike<number>; dimensions: [number, number, number] } | undefined; render: () => void } | null | undefined
): UseImageFiltersReturn {
  const [activeFilter, setActiveFilter] = useState<ActiveFilter | null>(null);

  // Cache the original (unfiltered) pixel data so we can restore it
  // without re-fetching from the server. Think of it as "save before editing."
  const originalPixelDataRef = useRef<ArrayLike<number> | null>(null);

  /**
   * Apply a filter to the current viewport's pixel data.
   * Delegates to imageFilterService for kernel selection and convolution.
   */
  const applyFilter = useCallback((type: FilterType, strength: FilterStrength) => {
    const viewport = getViewport();
    if (!viewport?.getImageData) {
      return;
    }

    const imageData = viewport.getImageData();
    if (!imageData) {
      return;
    }

    const { scalarData, dimensions } = imageData;
    const width = dimensions[0];
    const height = dimensions[1];

    // Save original pixel data if we haven't already (first filter application)
    if (!originalPixelDataRef.current) {
      const copy = new Float32Array(scalarData.length);
      for (let i = 0; i < scalarData.length; i++) {
        copy[i] = scalarData[i];
      }
      originalPixelDataRef.current = copy;
    }

    // Always apply convolution to the ORIGINAL data (not previously filtered data)
    // This prevents filters from "stacking" and degrading quality
    const source = originalPixelDataRef.current as Float32Array;
    const result = applyServiceFilter(source, width, height, { type, strength });

    // Write filtered pixels back to the viewport
    scalarData.set(result);
    viewport.render();

    setActiveFilter({ type, strength });
  }, [getViewport]);

  /**
   * Clear the active filter — restore original pixel data.
   */
  const clearFilter = useCallback(() => {
    if (!originalPixelDataRef.current) {
      setActiveFilter(null);
      return;
    }

    const viewport = getViewport();
    if (!viewport?.getImageData) {
      originalPixelDataRef.current = null;
      setActiveFilter(null);
      return;
    }

    const imageData = viewport.getImageData();
    if (!imageData) {
      originalPixelDataRef.current = null;
      setActiveFilter(null);
      return;
    }

    // Restore original pixels
    imageData.scalarData.set(originalPixelDataRef.current);
    viewport.render();

    originalPixelDataRef.current = null;
    setActiveFilter(null);
  }, [getViewport]);

  return { activeFilter, applyFilter, clearFilter };
}
