// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useOpsAnalysis — per-case ops hook with retry / cancel / mark-blocked
 * mutations (T319, US8).
 *
 * Plain-English:
 *   A single hook the stuck-case panel uses to:
 *     - read the one analysis's PHI-free detail (via the ordinary
 *       `GET /api/v1/analyses/{id}` endpoint — same projection, just
 *       surfaced to the ops user),
 *     - trigger `POST /api/v1/ops/analyses/{id}/retry`,
 *     - trigger `POST /api/v1/ops/analyses/{id}/cancel`,
 *     - trigger `POST /api/v1/ops/analyses/{id}/mark-blocked { note }`.
 *
 *   Every mutation invalidates the ops queue on success so the dashboard
 *   refreshes without a full page reload.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { opsQueueQueryKey, type OpsAnalysisSummary } from './useOpsQueue';

function readApiBaseUrl(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export const opsAnalysisQueryKey = (analysisId: string) =>
  ['ops', 'analysis', analysisId] as const;

async function fetchOpsAnalysis(analysisId: string): Promise<OpsAnalysisSummary> {
  // The ops dashboard reuses the same analyses projection; the server
  // strips PHI via the ops AccessPolicy.
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/analyses/${encodeURIComponent(analysisId)}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`Failed to load analysis ${analysisId}: HTTP ${res.status}`);
  }
  return (await res.json()) as OpsAnalysisSummary;
}

async function postOps(
  analysisId: string,
  action: 'retry' | 'cancel' | 'mark-blocked',
  body?: Record<string, unknown>,
): Promise<{ analysis_id: string; status: string; audit_sequence_no: number | null }> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(
    `${baseUrl}/ops/analyses/${encodeURIComponent(analysisId)}/${action}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ops ${action} failed: HTTP ${res.status} ${text}`);
  }
  if (res.status === 204) {
    return { analysis_id: analysisId, status: 'ok', audit_sequence_no: null };
  }
  return (await res.json()) as {
    analysis_id: string;
    status: string;
    audit_sequence_no: number | null;
  };
}

export interface UseOpsAnalysisResult {
  analysis: OpsAnalysisSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  retry: () => Promise<unknown>;
  cancel: () => Promise<unknown>;
  markBlocked: (note?: string) => Promise<unknown>;
  isMutating: boolean;
}

/** Per-case ops hook — detail + three mutations. */
export function useOpsAnalysis(
  analysisId: string | null | undefined,
): UseOpsAnalysisResult {
  const enabled = typeof analysisId === 'string' && analysisId.length > 0;
  const queryClient = useQueryClient();

  const query = useQuery<OpsAnalysisSummary, Error>({
    queryKey: enabled
      ? opsAnalysisQueryKey(analysisId as string)
      : ['ops', 'analysis', '__disabled__'],
    queryFn: () => fetchOpsAnalysis(analysisId as string),
    enabled,
    staleTime: 5_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: opsQueueQueryKey });
    if (enabled) {
      void queryClient.invalidateQueries({
        queryKey: opsAnalysisQueryKey(analysisId as string),
      });
    }
  };

  const retryMutation = useMutation({
    mutationFn: () => postOps(analysisId as string, 'retry'),
    onSuccess: invalidate,
  });

  const cancelMutation = useMutation({
    mutationFn: () => postOps(analysisId as string, 'cancel'),
    onSuccess: invalidate,
  });

  const markBlockedMutation = useMutation({
    mutationFn: (note?: string) =>
      postOps(analysisId as string, 'mark-blocked', note ? { note } : {}),
    onSuccess: invalidate,
  });

  return {
    analysis: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    retry: () => retryMutation.mutateAsync(),
    cancel: () => cancelMutation.mutateAsync(),
    markBlocked: (note?: string) => markBlockedMutation.mutateAsync(note),
    isMutating:
      retryMutation.isPending ||
      cancelMutation.isPending ||
      markBlockedMutation.isPending,
  };
}
