// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useFinalize (T273, T274, T429).
 *
 * Plain-English: the single hook the FinalizeWizard uses to POST
 * `/api/v1/reviews/{review_id}/finalize`. On success it invalidates
 * the analysis + report + audit query keys so the surrounding UI
 * refetches and shows the new Report row without a full page reload.
 *
 * Analogy: think of finalize as mailing a letter. This hook stuffs
 * the envelope (mutation), drops it in the mailbox (POST), and
 * tells the mailroom (TanStack Query cache) that anything still
 * sitting in the outbox is now stale.
 *
 * Spec refs: plan.md §Data Fetching Strategy; T429 wires this into
 * FinalizeWizard.tsx submit handler.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

export interface FinalizeResponse {
  report_id: string;
  status: 'draft' | 'finalizing' | 'finalized';
  polling_url: string;
}

export interface FinalizeVariables {
  reviewId: string;
  analysisId?: string;
  tenantId?: string;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

async function postFinalize({ reviewId }: FinalizeVariables): Promise<FinalizeResponse> {
  const base = readApiBaseUrl();
  const res = await fetch(`${base}/reviews/${encodeURIComponent(reviewId)}/finalize`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const slug = (body.slug as string | undefined) ?? 'finalize-failed';
    const message = (body.detail as string | undefined) ?? `finalize failed (HTTP ${res.status})`;
    const err = new Error(message) as Error & { slug?: string; status?: number };
    err.slug = slug;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as FinalizeResponse;
}

/**
 * Mutation hook that enqueues finalize + invalidates every cache key
 * that depends on the finalized report. T274 invalidation matrix:
 *   - ['analysis', analysisId]
 *   - ['analysis', analysisId, 'report']
 *   - ['reports', reportId]
 *   - ['audit', tenantId, '*']  (predicate invalidation)
 */
export function useFinalize(): ReturnType<typeof useMutation<FinalizeResponse, Error, FinalizeVariables>> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postFinalize,
    onSuccess: (data, vars) => {
      const { analysisId, tenantId } = vars;
      if (analysisId) {
        qc.invalidateQueries({ queryKey: ['analysis', analysisId] });
        qc.invalidateQueries({ queryKey: ['analysis', analysisId, 'report'] });
      }
      qc.invalidateQueries({ queryKey: ['reports', data.report_id] });
      if (tenantId) {
        qc.invalidateQueries({
          predicate: (q) => {
            const key = q.queryKey as unknown[];
            return key[0] === 'audit' && key[1] === tenantId;
          },
        });
      }
    },
  });
}
