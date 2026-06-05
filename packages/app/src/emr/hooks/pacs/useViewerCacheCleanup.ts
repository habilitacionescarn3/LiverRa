// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useViewerCacheCleanup — scoped CS3D cache + volume eviction on unmount
// (PACS-C7 / D3)
// ============================================================================
// Owns the cache cleanup refs + unmount effect. Two refs are tracked:
//   - activeVolumeIdRef: the live MPR volume id, so the rendering effect can
//     swap volumes during the session AND unmount can release it.
//   - studyImageIdsRef: the full all-series imageId list of the study this
//     viewer currently displays (kept in sync by PACSViewer's rendering
//     effect). On unmount we evict ONLY these images.
//
// D3: the previous unmount path called cache.purgeCache() — a GLOBAL wipe.
// That also discarded any prior-study / prefetched / sibling-viewer frames, so
// returning to the worklist and re-opening a study cold-refetched + re-decoded
// everything. Scoped per-image eviction keeps the teardown memory guarantee
// (no orphaned pixel data from THIS viewer) while leaving other cached studies
// warm. General memory pressure is still bounded by the 3GB size-pressure
// budget configured in cornerstoneInit (512MB on mobile).
//
// Extracted from PACSViewer.tsx (PACS-H10).
// ============================================================================

import { useEffect, useRef, type MutableRefObject } from 'react';
import { cache } from '@cornerstonejs/core';
import { MASKED_VOLUME_SUFFIX } from '../../services/pacs/structureIsolation';

export interface ViewerCacheCleanupRefs {
  /** Live MPR volume id (null when not in volume mode). */
  activeVolumeIdRef: MutableRefObject<string | null>;
  /** Full all-series imageId list of the currently displayed study. */
  studyImageIdsRef: MutableRefObject<string[] | undefined>;
}

export function useViewerCacheCleanup(): ViewerCacheCleanupRefs {
  const activeVolumeIdRef = useRef<string | null>(null);
  const studyImageIdsRef = useRef<string[] | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (activeVolumeIdRef.current) {
        try {
          cache.removeVolumeLoadObject(activeVolumeIdRef.current);
          // Drop the derived structure-isolation masked sibling too — nothing else
          // tracks its id, so without this it leaks (~432MB) past teardown.
          cache.removeVolumeLoadObject(`${activeVolumeIdRef.current}${MASKED_VOLUME_SUFFIX}`);
        } catch (err) {
          console.warn('[useViewerCacheCleanup] best-effort PACS operation failed:', err);
        }
        activeVolumeIdRef.current = null;
      }
      // PACS-C7 / D3: evict ONLY this viewer's study images on unmount so 2D
      // stack pixel data does not survive past teardown — without the global
      // purgeCache() that also wiped unrelated/prefetched studies and forced a
      // cold re-decode on back-navigation.
      const imageIds = studyImageIdsRef.current;
      if (imageIds && imageIds.length > 0) {
        for (const imageId of imageIds) {
          try {
            cache.removeImageLoadObject(imageId);
          } catch (err) {
            console.warn('[useViewerCacheCleanup] best-effort PACS operation failed:', err);
          }
        }
      }
      studyImageIdsRef.current = undefined;
    };
  }, []);

  return { activeVolumeIdRef, studyImageIdsRef };
}
