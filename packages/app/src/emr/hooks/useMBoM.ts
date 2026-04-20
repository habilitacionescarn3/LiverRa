// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useMBoM (T350).
 *
 * Plain-English: one hook for the compliance MBoM view. Fetches
 * `GET /api/v1/compliance/mbom` and returns the list of integrated
 * models with their commit SHA, license hash, source URL, and
 * approver. Keyed by tenant so switching ComplianceAssignment scope
 * invalidates cleanly.
 *
 * Spec refs: FR-038, contracts/api-openapi.yaml §/compliance/mbom.
 */

import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../services/auth';

export interface MBoMRow {
  model_name: string;
  source_url: string;
  pinned_commit_sha: string;
  license_text_hash_hex: string;
  license_name: string;
  integration_date: string | null;
  approver: string;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export const mbomQueryKey = (tenantId: string | null) =>
  ['tenant', tenantId ?? '__anon__', 'compliance', 'mbom'] as const;

async function fetchMBoM(): Promise<MBoMRow[]> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/compliance/mbom`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load MBoM: HTTP ${res.status}`);
  return (await res.json()) as MBoMRow[];
}

export function useMBoM() {
  const { tenant } = useAuth();
  const tenantId = tenant?.id ?? null;

  const query = useQuery<MBoMRow[], Error>({
    queryKey: mbomQueryKey(tenantId),
    queryFn: fetchMBoM,
    // MBoM rows change at most once per release; 5-minute cache is fine.
    staleTime: 5 * 60 * 1000,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    refetch: query.refetch,
  };
}
