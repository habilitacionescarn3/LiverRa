// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useOpsQueue — cross-tenant queue snapshot hook (T319, US8).
 *
 * Plain-English:
 *   The ops engineer's radar. Polls `GET /api/v1/ops/queue` every 5 seconds
 *   and returns the raw queue view (queued, running, stuck, GPU, cold-start
 *   rate). Everything comes from a PHI-scrubbed backend projection — no
 *   study instance UIDs, no patient names, no MRNs.
 *
 * Query key: `['ops', 'queue']` — the single source of truth so mutations
 *   (retry/cancel/mark-blocked) can invalidate from anywhere.
 *
 * Polling cadence: 5 s matches plan.md §Data Fetching Strategy for
 *   realtime operator dashboards; disabled when the tab is hidden to
 *   avoid wasted GPU-util refreshes.
 */

import { useQuery } from '@tanstack/react-query';

export interface OpsAnalysisSummary {
  analysis_id: string;
  study_id: string;
  tenant_id: string;
  status: string;
  queued_at: string;
  started_at: string | null;
  pipeline_version: string;
  model_versions: Record<string, unknown>;
  error_slug: string | null;
  last_stage: string | null;
  last_stage_at: string | null;
  stuck_minutes: number | null;
}

export interface OpsQueueView {
  queued: OpsAnalysisSummary[];
  running: OpsAnalysisSummary[];
  stuck_over_15min: OpsAnalysisSummary[];
  gpu_utilization_pct: number;
  cold_start_rate_last_hour: number;
}

export const opsQueueQueryKey = ['ops', 'queue'] as const;

function readApiBaseUrl(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

async function fetchOpsQueue(): Promise<OpsQueueView> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/ops/queue`, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Failed to load ops queue: HTTP ${res.status}`);
  }
  return (await res.json()) as OpsQueueView;
}

export interface UseOpsQueueResult {
  view: OpsQueueView | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

/**
 * Poll the ops queue every 5s. Caller can opt out of polling by passing
 * `{ refetchIntervalMs: 0 }` — useful in detail views that already have
 * a more targeted subscription.
 */
export function useOpsQueue(options?: {
  refetchIntervalMs?: number;
  enabled?: boolean;
}): UseOpsQueueResult {
  const { refetchIntervalMs = 5_000, enabled = true } = options ?? {};

  const query = useQuery<OpsQueueView, Error>({
    queryKey: opsQueueQueryKey,
    queryFn: fetchOpsQueue,
    enabled,
    refetchInterval: refetchIntervalMs > 0 ? refetchIntervalMs : false,
    refetchIntervalInBackground: false,
    staleTime: 2_500,
  });

  return {
    view: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    refetch: query.refetch,
  };
}
