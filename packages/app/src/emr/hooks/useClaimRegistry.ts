// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useClaimRegistry (T350, T449).
 *
 * Plain-English: reads + writes the 7-row RegulatoryClaimRegistry for
 * the current tenant. The `update(claimKey, status, reference)` call
 * is the toggle behind `<PermissionButton stepUp>` in the claim-
 * registry view — flipping a row from `ruo` → `cleared` narrows the
 * disclaimer scope on every future export (FR-028b).
 *
 * The backend PUT is step-up-guarded (server-side). If the user's MFA
 * is stale, the server returns `401 step-up-required`, the global
 * `errorClient` dispatches `liverra:step-up-required`, the
 * `StepUpAuthModal` prompts for re-auth, and the user retries. This
 * hook itself is un-aware of step-up — it just surfaces the raw error.
 *
 * Query invalidation: a successful PUT refetches this query AND the
 * global `claim-registry` cache used by `RUOClaimRegistryContext` so
 * the disclaimer updates immediately.
 *
 * Spec refs: FR-028b, data-model.md §17, contracts/api-openapi.yaml
 * §/compliance/claim-registry.
 */

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../services/auth';

export type ClaimKey =
  | 'parenchyma_volumetry'
  | 'flr'
  | 'couinaud_segmentation'
  | 'vessel_identification'
  | 'lesion_detection'
  | 'lesion_classification'
  | 'surgical_planning';

export type ClaimStatus = 'ruo' | 'under_conformity_assessment' | 'cleared';

export interface ClaimRegistryEntry {
  claim_key: ClaimKey;
  status: ClaimStatus;
  effective_from: string;
  regulatory_reference: string | null;
}

export interface ClaimRegistryUpdateInput {
  claim_key: ClaimKey;
  status: ClaimStatus;
  regulatory_reference?: string | null;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export const claimRegistryQueryKey = (tenantId: string | null) =>
  ['tenant', tenantId ?? '__anon__', 'compliance', 'claim-registry'] as const;

async function fetchRegistry(): Promise<ClaimRegistryEntry[]> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/compliance/claim-registry`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to load claim registry: HTTP ${res.status}`);
  return (await res.json()) as ClaimRegistryEntry[];
}

async function putRegistry(body: ClaimRegistryUpdateInput): Promise<ClaimRegistryEntry> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/compliance/claim-registry`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // 401 step-up-required is handled globally by errorClient — just
    // propagate so react-query surfaces it to the caller.
    throw new Error(`Claim registry update failed: HTTP ${res.status}`);
  }
  return (await res.json()) as ClaimRegistryEntry;
}

export function useClaimRegistry() {
  const { tenant } = useAuth();
  const tenantId = tenant?.id ?? null;
  const queryClient = useQueryClient();

  const query = useQuery<ClaimRegistryEntry[], Error>({
    queryKey: claimRegistryQueryKey(tenantId),
    queryFn: fetchRegistry,
    staleTime: 30_000,
  });

  const mutation = useMutation<ClaimRegistryEntry, Error, ClaimRegistryUpdateInput>({
    mutationFn: putRegistry,
    onSuccess: () => {
      // Refresh the compliance view AND the global disclaimer registry.
      void queryClient.invalidateQueries({
        queryKey: claimRegistryQueryKey(tenantId),
      });
      // `RUOClaimRegistryContext` uses a non-React-Query cache, so we
      // cross-invalidate by dispatching a DOM event it listens for.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('liverra:claim-registry-updated'));
      }
    },
  });

  const update = useCallback(
    (input: ClaimRegistryUpdateInput) => mutation.mutateAsync(input),
    [mutation],
  );

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    refetch: query.refetch,
    update,
    isUpdating: mutation.isPending,
    updateError: (mutation.error as Error | null) ?? null,
  };
}
