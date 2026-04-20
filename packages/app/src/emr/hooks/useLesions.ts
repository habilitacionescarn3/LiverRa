// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useLesions (T221).
 *
 * Plain-English: the lesion list on the right-hand drawer needs to know every
 * focal liver lesion the AI found, what class it belongs to ("HCC", "cyst",
 * etc.), and how confident the classifier was. Those lesions live on the
 * analysis's `results` payload. This hook fetches that payload, pulls the
 * `lesions` array out, caches it under `['analysis', id, 'lesions']`, and
 * re-fetches whenever the backend announces — over SSE — that the
 * `classification` stage has completed.
 *
 * Analogy: imagine the radiologist's nurse stapling a new page of
 * tumor measurements onto the patient's chart every time the lab calls back
 * with a fresh result — the nurse always grabs the latest, replaces the old
 * page, and everyone downstream sees the update without refreshing.
 *
 * Why its own hook and not part of `useAnalysis`:
 *   - Lesion re-renders are expensive (tumor list, detail panel, 3D overlay),
 *     so we want an independent cache key that only invalidates on
 *     classification updates — not every `stage-complete`.
 *   - Reviewer-initiated lesion appends (FR-016 / MedSAM-2) mutate just this
 *     query; isolating it keeps mutation surface area small.
 *
 * Wiring note: `useAnalysis.ts` handles `stage-complete` invalidation for the
 * top-level analysis query. This hook subscribes to the SAME SSE endpoint
 * but specifically filters for `stage: 'classification'` to avoid spurious
 * lesion refetches during earlier pipeline stages.
 *
 * Spec refs:
 *   - plan.md §Data Fetching Strategy (query-key hierarchy)
 *   - spec.md §US3 (lesion list + classification display)
 *   - data-model.md §8 Lesion, §9 Classification
 *   - FR-011 (abstention), FR-016 (reviewer-prompted lesion append)
 */

import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { components } from '../services/api-schema.gen';

/**
 * Lesion row as returned from `GET /api/v1/analyses/{id}/results`.
 *
 * We mirror the generated `components["schemas"]["Lesion"]` shape here so
 * callers can reach in for id + classification fields without re-importing
 * the generated schema module every time.
 */
export type Lesion = components['schemas']['Lesion'];

/**
 * Shape of the results payload we pluck the lesion array out of. The backend
 * returns far more than just lesions (parenchyma URI, segments URI, FLR, ...)
 * but we deliberately type-narrow here so the caller sees only what it needs.
 */
interface AnalysisResultsWithLesions {
  lesions?: Lesion[];
  [key: string]: unknown;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

/**
 * Query-key builder. Exported so mutations (reviewer override, MedSAM-2
 * append) and sibling hooks (`useAnalysisInvalidation`) can target the same
 * cache entry without typo drift.
 */
export const lesionsQueryKey = (analysisId: string) =>
  ['analysis', analysisId, 'lesions'] as const;

async function fetchLesions(analysisId: string): Promise<Lesion[]> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(
    `${baseUrl}/analyses/${encodeURIComponent(analysisId)}/results`,
    { credentials: 'include' },
  );
  if (!res.ok) {
    throw new Error(`Failed to load lesions for analysis ${analysisId}: HTTP ${res.status}`);
  }
  const json = (await res.json()) as AnalysisResultsWithLesions;
  return Array.isArray(json.lesions) ? json.lesions : [];
}

export interface UseLesionsResult {
  lesions: Lesion[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * Subscribe to the lesion list for a given analysis.
 *
 * Cache behaviour:
 *   - `staleTime: 10_000` — lesions are relatively stable after classification
 *     completes; 10s avoids refetch storms while a reviewer scrolls.
 *   - SSE `stage-complete` with `stage: 'classification'` invalidates the key.
 *   - Reviewer prompt / classification-override mutations also invalidate
 *     manually (via `lesionsQueryKey(id)`).
 */
export function useLesions(analysisId: string | null | undefined): UseLesionsResult {
  const queryClient = useQueryClient();
  const enabled = typeof analysisId === 'string' && analysisId.length > 0;

  const query = useQuery<Lesion[], Error>({
    queryKey: enabled ? lesionsQueryKey(analysisId as string) : ['analysis', '__disabled__', 'lesions'],
    queryFn: () => fetchLesions(analysisId as string),
    enabled,
    staleTime: 10_000,
  });

  // SSE side-channel: only invalidate on classification completion so earlier
  // stages (parenchyma, vessels, Couinaud) don't cause the lesion list to
  // refetch empty payloads and flicker.
  useEffect(() => {
    if (!enabled) return;
    const baseUrl = readApiBaseUrl();
    const url = new URL(
      `${baseUrl}/analyses/${encodeURIComponent(analysisId as string)}/stream`,
      window.location.origin,
    );
    const es = new EventSource(url.toString(), { withCredentials: true });

    const onStage = (ev: MessageEvent<string>): void => {
      try {
        const parsed = JSON.parse(ev.data) as { stage?: string };
        if (parsed.stage === 'classification' || parsed.stage === 'lesion_detection') {
          void queryClient.invalidateQueries({
            queryKey: lesionsQueryKey(analysisId as string),
          });
        }
      } catch {
        // Malformed frames are ignored; the next event will retry.
      }
    };

    es.addEventListener('stage-complete', onStage as EventListener);
    return () => {
      es.removeEventListener('stage-complete', onStage as EventListener);
      es.close();
    };
  }, [analysisId, enabled, queryClient]);

  return {
    lesions: query.data ?? [],
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}

/**
 * Look up a single lesion by id within the cached list.
 *
 * Reuses `useLesions` so we don't duplicate network calls — `LesionDetailPanel`
 * and `LesionList` share the same cache entry. Returns `null` when the lesion
 * isn't in the current result set (e.g., deleted via review, or stale route).
 */
export function useLesion(
  analysisId: string | null | undefined,
  lesionId: string | null | undefined,
): Lesion | null {
  const { lesions } = useLesions(analysisId);
  return useMemo(() => {
    if (!lesionId) return null;
    return lesions.find((l) => l.id === lesionId) ?? null;
  }, [lesions, lesionId]);
}
