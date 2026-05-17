// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useAnalysisResults — shared TanStack Query hook for the cascade result
 * payload (`GET /api/v1/analyses/{id}/results`).
 *
 * Plain-English:
 *   Whatever the AI pipeline produced for a finished case — the per-segment
 *   masks, the per-lesion bounding boxes, the FLR cutting plane suggestion —
 *   lives at one URL. This hook fetches it once, caches it under the query
 *   key `['analysis', id, 'results']`, and lets every view that needs the
 *   same data (Case detail, Refine workbench, lesion side-panel) share the
 *   cache instead of each issuing its own fetch.
 *
 * Caching contract:
 *   - 30s stale time (matches AnalysisDetailView's original local copy).
 *   - 3s refetch interval while the analysis is `running` or `queued`, so
 *     stages-in-flight stream progress without manual invalidation.
 *   - Disabled when `analysisId` is null/empty.
 *
 * Provenance:
 *   Extracted from `AnalysisDetailView.tsx` (`useAnalysisResults` + the
 *   `ResultsBundle` shape) so the Refine page can mount it without
 *   duplicating the fetch logic. Behavior is byte-identical.
 */

import { useQuery } from '@tanstack/react-query';

export interface ResultsBundleFlrDefault {
  remnant_pct_functional?: string | number | null;
  plane_normal?: { x: number; y: number; z: number } | null;
  plane_offset_mm?: string | number | null;
  plane_pose?: {
    axis?: string;
    z_index?: number;
    bbox_z?: [number, number];
    heuristic?: string;
  } | null;
}

export interface ResultsBundleSegmentation {
  id: string;
  anatomy_category?: string | null;
  anatomy_detail?: string | null;
  volume_ml?: string | number | null;
  mask_url?: string | null;
}

export interface ResultsBundleLesion {
  id: string;
  bbox3d?: {
    x?: number;
    y?: number;
    z?: number;
    dx?: number;
    dy?: number;
    dz?: number;
    x_min?: number;
    y_min?: number;
    z_min?: number;
    x_max?: number;
    y_max?: number;
    z_max?: number;
  } | null;
  couinaud_location?: number | null;
  longest_diameter_mm?: string | number | null;
  classification?: string | null;
}

export interface ResultsBundle {
  flr_default?: ResultsBundleFlrDefault | null;
  segmentations?: ResultsBundleSegmentation[];
  lesions?: ResultsBundleLesion[];
}

export function useAnalysisResults(
  analysisId: string | null | undefined,
  apiBaseUrl: string,
  status?: string,
) {
  return useQuery<ResultsBundle, Error>({
    queryKey: ['analysis', analysisId, 'results'],
    queryFn: async () => {
      const r = await fetch(
        `${apiBaseUrl}/analyses/${encodeURIComponent(analysisId!)}/results`,
        { credentials: 'include' },
      );
      if (!r.ok) throw new Error(`GET /analyses/${analysisId}/results -> ${r.status}`);
      return r.json();
    },
    enabled: typeof analysisId === 'string' && analysisId.length > 0,
    staleTime: 30_000,
    refetchInterval: status === 'running' || status === 'queued' ? 3_000 : false,
  });
}
