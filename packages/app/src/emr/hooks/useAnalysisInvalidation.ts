// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useAnalysisInvalidation (T225 companion).
 *
 * Plain-English: the pipeline announces over SSE when each stage finishes —
 * parenchyma, vessels, couinaud, lesion_detection, classification, flr_init,
 * etc. Different stages produce different result slices, and each slice has
 * its own TanStack Query key. Rather than making every slice-hook open its
 * own SSE connection, this hook is a single subscriber that translates
 * `stage-complete` events into the exact query-key invalidations each slice
 * needs.
 *
 * Analogy: one mail clerk at the front desk sorting incoming letters into
 * the right office mailbox (segments vs lesions vs FLR), instead of each
 * office running its own postbox out to the street.
 *
 * Current stage → query-key mapping:
 *   - `couinaud`          → `['analysis', id, 'segments']`
 *                           + `['analysis', id, 'classifications']` (Couinaud
 *                             is a prerequisite for classification lookups by
 *                             segment, so invalidate both to stay coherent)
 *   - `lesion_detection`  → `['analysis', id, 'lesions']`
 *   - `classification`    → `['analysis', id, 'lesions']`
 *                           + `['analysis', id, 'classifications']`
 *   - any stage           → `['analysis', id]` (top-level summary)
 *
 * The us2-couinaud agent owns the "segments" handler contract. If this file
 * already existed when us3-lesions lands, we merely extended it with the
 * lesion_detection + classification cases. If it did not, we are creating
 * it now — the us2 agent can subsequently add a `couinaud` branch.
 *
 * Spec refs: plan.md §Data Fetching Strategy, FR-014a/b.
 */

import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export type PipelineStage =
  | 'anonymization'
  | 'parenchyma'
  | 'vessels'
  | 'couinaud'
  | 'lesion_detection'
  | 'classification'
  | 'flr_init'
  | string;

/**
 * Map a single `stage-complete` event into query-key invalidations. Exported
 * so other code paths (mutation hooks, tests) can reuse the exact same rules.
 */
export function invalidateForStage(
  queryClient: QueryClient,
  analysisId: string,
  stage: PipelineStage,
): void {
  // The top-level analysis summary is always worth refreshing.
  void queryClient.invalidateQueries({ queryKey: ['analysis', analysisId] });

  switch (stage) {
    case 'couinaud':
      void queryClient.invalidateQueries({
        queryKey: ['analysis', analysisId, 'segments'],
      });
      void queryClient.invalidateQueries({
        queryKey: ['analysis', analysisId, 'classifications'],
      });
      return;
    case 'lesion_detection':
      void queryClient.invalidateQueries({
        queryKey: ['analysis', analysisId, 'lesions'],
      });
      return;
    case 'classification':
      void queryClient.invalidateQueries({
        queryKey: ['analysis', analysisId, 'lesions'],
      });
      void queryClient.invalidateQueries({
        queryKey: ['analysis', analysisId, 'classifications'],
      });
      return;
    default:
      // Unknown stages fall through — top-level invalidation above is safe.
      return;
  }
}

/**
 * Subscribe to the per-analysis SSE stream and invalidate the right query
 * keys on every `stage-complete` event.
 *
 * This is intentionally redundant with `useAnalysis`'s own SSE listener —
 * `useAnalysis` invalidates only its own top-level key, while this hook
 * fans out into slice-specific keys. Both coexist because slice-hooks
 * (`useLesions`, `useSegments`, ...) should be usable independently of
 * whether `useAnalysis` is mounted on the same page.
 */
export function useAnalysisInvalidation(analysisId: string | null | undefined): void {
  const queryClient = useQueryClient();
  const enabled = typeof analysisId === 'string' && analysisId.length > 0;

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
        const parsed = JSON.parse(ev.data) as { stage?: PipelineStage };
        if (parsed.stage) {
          invalidateForStage(queryClient, analysisId as string, parsed.stage);
        }
      } catch {
        // Malformed frames are ignored — the next event triggers a retry.
      }
    };

    es.addEventListener('stage-complete', onStage as EventListener);
    return () => {
      es.removeEventListener('stage-complete', onStage as EventListener);
      es.close();
    };
  }, [analysisId, enabled, queryClient]);
}
