// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useAnalysis (T182).
 *
 * Plain-English: the one-stop hook every analysis panel uses to ask
 * "what's the latest state of this case?". It does two things:
 *   1. Fetches `GET /api/v1/analyses/{id}` via TanStack Query so the
 *      result is cached, deduplicated, and shared across every component
 *      that asks for the same analysis id.
 *   2. Opens a side-channel `EventSource` on `/stream` for that same id —
 *      whenever the backend fires `stage-complete`, we invalidate the
 *      query so the panel re-renders with fresh data.
 *
 * Analogy: the query is a snapshot you took with your phone; the SSE
 * listener is a notification that tells you when to re-take the photo.
 *
 * Wiring (T189): end-to-end typing comes from `api-schema.gen.ts` via
 * the `openapi-fetch`-backed `createApiClient()` in `services/api-client.ts`
 * — but since no app-level singleton ships yet, we talk to the endpoint
 * through raw `fetch` here and let `api-client.ts` become the implementation
 * once a provider is wired. Signature is intentionally the same so the
 * swap is a mechanical change.
 *
 * Spec refs: plan.md §Data Fetching Strategy, plan.md §Contexts graph
 * (AnalysisContext + this hook are complementary — context is the SSE
 * session owner, hook is the cache adapter).
 */

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { Analysis } from '../contexts/AnalysisContext';

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

/**
 * Analysis query-key builder. Exported so mutations elsewhere can
 * invalidate with the exact same key and stay consistent with
 * plan.md §Query key hierarchy.
 */
export const analysisQueryKey = (analysisId: string) => ['analysis', analysisId] as const;

async function fetchAnalysis(analysisId: string): Promise<Analysis> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/analyses/${encodeURIComponent(analysisId)}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`Failed to load analysis ${analysisId}: HTTP ${res.status}`);
  }
  return (await res.json()) as Analysis;
}

export interface UseAnalysisResult {
  analysis: Analysis | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

/**
 * Query an analysis by id with SSE-driven invalidation.
 *
 * - Staleness: 5s during `running`, 5min after `completed` (plan §Data
 *   Fetching Strategy). We model this as `staleTime: 5_000` because the
 *   post-complete data is immutable — callers that want to force a refetch
 *   can call `queryClient.refetchQueries(...)` explicitly.
 * - SSE subscription is lifecycled with the component; on `stage-complete`
 *   we invalidate the query so the next render triggers a refetch.
 */
export function useAnalysis(analysisId: string | null | undefined): UseAnalysisResult {
  const queryClient = useQueryClient();

  const enabled = typeof analysisId === 'string' && analysisId.length > 0;

  const query = useQuery<Analysis, Error>({
    queryKey: enabled ? analysisQueryKey(analysisId as string) : ['analysis', '__disabled__'],
    queryFn: () => fetchAnalysis(analysisId as string),
    enabled,
    staleTime: 5_000,
  });

  useEffect(() => {
    if (!enabled) return;
    const baseUrl = readApiBaseUrl();
    const url = new URL(
      `${baseUrl}/analyses/${encodeURIComponent(analysisId as string)}/stream`,
      window.location.origin,
    );
    const es = new EventSource(url.toString(), { withCredentials: true });

    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: analysisQueryKey(analysisId as string) });
    };
    es.addEventListener('stage-complete', invalidate);
    es.addEventListener('analysis-update', invalidate);

    return () => {
      es.removeEventListener('stage-complete', invalidate);
      es.removeEventListener('analysis-update', invalidate);
      es.close();
    };
  }, [analysisId, enabled, queryClient]);

  return {
    analysis: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    refetch: query.refetch,
  };
}
