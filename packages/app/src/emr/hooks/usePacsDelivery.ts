// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * usePacsDelivery (T273, T429).
 *
 * Plain-English: reads + polls the array of `ReportDelivery` rows for
 * a given Report (one per (destination × artifact)). Consumers:
 *
 *   - `PACSPushPanel.tsx` — lists deliveries + offers retry buttons.
 *
 * Polling cadence is 3 seconds while anything is still `pending`,
 * `sending`, or `failed` (operator might retry). Once everything is
 * `acknowledged` or `manual_fallback` the poll stops.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type PacsDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'acknowledged'
  | 'failed'
  | 'manual_fallback';

export interface ReportDelivery {
  id: string;
  report_id: string;
  artifact_type: 'seg' | 'sr';
  destination_ae_title: string;
  status: PacsDeliveryStatus;
  retry_count: number;
  next_attempt_at?: string | null;
  last_error?: string | null;
  acknowledged_at?: string | null;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

async function fetchDeliveries(reportId: string): Promise<ReportDelivery[]> {
  const base = readApiBaseUrl();
  // The list projection is served by the same route as POST /pacs-push via
  // a 200 GET until the dedicated listing endpoint lands; as a stopgap
  // we read from `GET /reports/{id}/deliveries` which the backend router
  // will expose (contracts/api-openapi.yaml §export-list follow-up).
  const res = await fetch(
    `${base}/reports/${encodeURIComponent(reportId)}/deliveries`,
    { credentials: 'include' },
  );
  if (res.status === 404) {
    // Endpoint not yet live — return empty list so the UI still renders.
    return [];
  }
  if (!res.ok) {
    throw new Error(`GET /reports/${reportId}/deliveries failed (HTTP ${res.status})`);
  }
  return (await res.json()) as ReportDelivery[];
}

export interface UsePacsDeliveryResult {
  deliveries: ReportDelivery[];
  isLoading: boolean;
  error: Error | null;
  startPush: (reportId: string) => Promise<ReportDelivery[]>;
  retryDelivery: (reportId: string, deliveryId: string) => Promise<void>;
}

export function usePacsDelivery(reportId: string | null | undefined): UsePacsDeliveryResult {
  const qc = useQueryClient();

  const query = useQuery<ReportDelivery[], Error>({
    queryKey: ['reports', reportId, 'deliveries'],
    queryFn: () => fetchDeliveries(reportId as string),
    enabled: Boolean(reportId),
    refetchInterval: (q) => {
      const data = (q.state.data ?? []) as ReportDelivery[];
      if (!data.length) return 3000;
      const stillPolling = data.some(
        (d) => d.status === 'pending' || d.status === 'sending' || d.status === 'failed',
      );
      return stillPolling ? 3000 : false;
    },
  });

  const startMutation = useMutation<ReportDelivery[], Error, string>({
    mutationFn: async (rid) => {
      const base = readApiBaseUrl();
      const res = await fetch(`${base}/reports/${encodeURIComponent(rid)}/pacs-push`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const slug = (body.slug as string | undefined) ?? 'pacs-push-failed';
        const err = new Error(String(body.detail ?? slug)) as Error & { slug?: string };
        err.slug = slug;
        throw err;
      }
      return (await res.json()) as ReportDelivery[];
    },
    onSuccess: (_data, rid) => {
      qc.invalidateQueries({ queryKey: ['reports', rid, 'deliveries'] });
    },
  });

  const retryMutation = useMutation<void, Error, { reportId: string; deliveryId: string }>({
    mutationFn: async ({ reportId: rid, deliveryId }) => {
      const base = readApiBaseUrl();
      const res = await fetch(
        `${base}/reports/${encodeURIComponent(rid)}/pacs-push/${encodeURIComponent(deliveryId)}/retry`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) {
        throw new Error(`retry failed (HTTP ${res.status})`);
      }
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['reports', vars.reportId, 'deliveries'] });
    },
  });

  return {
    deliveries: query.data ?? [],
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    startPush: (rid) => startMutation.mutateAsync(rid),
    retryDelivery: (rid, deliveryId) => retryMutation.mutateAsync({ reportId: rid, deliveryId }),
  };
}
