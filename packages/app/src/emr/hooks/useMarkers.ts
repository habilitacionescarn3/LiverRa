// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useMarkers (Phase G5).
 *
 * Plain-English: fetches the list of reviewer-placed "markers" (sticky
 * notes anchored in voxel space) for a given analysis. The Refine page
 * left rail renders these so the reviewer can see at a glance every spot
 * they tagged during the session.
 *
 * Same architectural shape as `useLesions` / `useAnalysisResults`:
 *   - TanStack Query under key `['analysis', analysisId, 'markers']`.
 *   - `staleTime: 30_000` — markers don't change often; this avoids
 *     refetch storms when a reviewer scrolls.
 *   - `enabled` gated on a real analysisId so the hook is safe to mount
 *     before routing has resolved.
 *
 * Endpoint: `GET ${apiBaseUrl}/analyses/{id}/markers` — credentials
 * included so the FastAPI session cookie travels.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

/**
 * Marker row as returned from `GET /api/v1/analyses/{id}/markers`.
 *
 * Mirrors the backend `ReviewerMarker` shape — kept inline here so
 * callers don't have to import from a generated schema bundle that
 * Phase G hasn't regenerated yet.
 */
export interface ReviewerMarker {
  id: string;
  analysis_id: string;
  review_id: string;
  voxel: [number, number, number];
  couinaud_segment: string | null;
  segmentation_id: string | null;
  label: string | null;
  note: string | null;
  created_at: string;
  created_by: string;
}

/** Query-key builder. Exported so mutations can target the same cache entry. */
export const markersQueryKey = (analysisId: string) =>
  ['analysis', analysisId, 'markers'] as const;

async function fetchMarkers(
  analysisId: string,
  apiBaseUrl: string,
): Promise<ReviewerMarker[]> {
  const res = await fetch(
    `${apiBaseUrl}/analyses/${encodeURIComponent(analysisId)}/markers`,
    { credentials: 'include' },
  );
  if (!res.ok) {
    throw new Error(`Failed to load markers for analysis ${analysisId}: HTTP ${res.status}`);
  }
  const json = (await res.json()) as ReviewerMarker[] | { markers?: ReviewerMarker[] };
  // Backend may wrap the list in `{ markers: [...] }` or return a bare array.
  if (Array.isArray(json)) return json;
  return Array.isArray(json.markers) ? json.markers : [];
}

/**
 * Subscribe to the marker list for a given analysis.
 */
export function useMarkers(
  analysisId: string | undefined,
  apiBaseUrl: string,
): UseQueryResult<ReviewerMarker[], Error> {
  const enabled = typeof analysisId === 'string' && analysisId.length > 0;
  return useQuery<ReviewerMarker[], Error>({
    queryKey: enabled
      ? markersQueryKey(analysisId as string)
      : ['analysis', '__disabled__', 'markers'],
    queryFn: () => fetchMarkers(analysisId as string, apiBaseUrl),
    enabled,
    staleTime: 30_000,
  });
}

export default useMarkers;
