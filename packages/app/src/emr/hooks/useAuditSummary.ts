// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useAuditSummary (T350).
 *
 * Plain-English: powers the compliance audit-summary view. Given a
 * target tenant + date range, it fetches the server-verified audit
 * chain slice (every event + a chain-valid flag + the S3 Merkle anchor
 * URIs). The UI uses this payload to render the event table AND the
 * `AuditChainVerifier` highlight of the first invalid sequence, if any.
 *
 * The query only runs when all three inputs are present — that avoids
 * a noisy "waiting for user input" spinner while the reviewer is still
 * picking dates.
 *
 * Spec refs: SC-010, research.md §A.3, contracts/api-openapi.yaml
 * §/compliance/audit-summary.
 */

import { useQuery } from '@tanstack/react-query';

export interface AuditSummaryEvent {
  id: string;
  category: string;
  actor: string;
  subject: string;
  timestamp: string;
  outcome: 'success' | 'denied' | 'error';
  chain_sequence_no: number;
}

export interface AuditSummaryResponse {
  events: AuditSummaryEvent[];
  chain_valid: boolean;
  chain_first_invalid_sequence_no: number | null;
  merkle_root_for_window: string;
  s3_anchor_uris: string[];
}

export interface UseAuditSummaryParams {
  tenantId: string | null;
  /** ISO-8601 date-time. */
  from: string | null;
  /** ISO-8601 date-time. */
  to: string | null;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export const auditSummaryQueryKey = (params: UseAuditSummaryParams) =>
  [
    'tenant',
    params.tenantId ?? '__anon__',
    'compliance',
    'audit-summary',
    params.from,
    params.to,
  ] as const;

async function fetchAuditSummary(
  params: UseAuditSummaryParams,
): Promise<AuditSummaryResponse> {
  if (!params.tenantId || !params.from || !params.to) {
    throw new Error('Missing required query parameters');
  }
  const baseUrl = readApiBaseUrl();
  const url = new URL(`${baseUrl}/compliance/audit-summary`, window.location.origin);
  url.searchParams.set('tenant_id', params.tenantId);
  url.searchParams.set('from', params.from);
  url.searchParams.set('to', params.to);

  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load audit summary: HTTP ${res.status}`);
  return (await res.json()) as AuditSummaryResponse;
}

export function useAuditSummary(params: UseAuditSummaryParams) {
  const enabled = Boolean(params.tenantId && params.from && params.to);

  const query = useQuery<AuditSummaryResponse, Error>({
    queryKey: auditSummaryQueryKey(params),
    queryFn: () => fetchAuditSummary(params),
    enabled,
    staleTime: 30_000,
  });

  return {
    summary: query.data ?? null,
    isLoading: query.isLoading && enabled,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    refetch: query.refetch,
    enabled,
  };
}
