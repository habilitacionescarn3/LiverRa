// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useCasesList (T183).
 *
 * Plain-English: powers the `/cases` list view. It pages through a
 * tenant's analyses, supports filters (date range, status, which stages
 * have completed), and pre-fetches the next page as the user scrolls
 * near the end — so the grid feels "infinite" without hammering the API.
 *
 * Analogy: a book with chapters. You're reading chapter 3; the library
 * silently fetches chapter 4 so when you flip the page it's already
 * there.
 *
 * Query-key shape is `['tenant', tenantId, 'analyses', filters]` per
 * plan.md §Query key hierarchy. Pagination uses cursor-based
 * `page_token` from the backend (API contract `contracts/api-openapi.yaml`).
 *
 * Spec refs: plan.md §Data Fetching Strategy.
 */

import { useEffect } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../services/auth';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface DateRangeFilter {
  from?: string; // ISO-8601
  to?: string;
}

export type AnalysisStatusFilter = 'queued' | 'running' | 'completed' | 'failed' | 'partial';

export type PhaseCoverage =
  | 'parenchyma'
  | 'vessels'
  | 'couinaud'
  | 'lesion_detection'
  | 'classification'
  | 'flr_init';

export interface CasesListFilters {
  dateRange?: DateRangeFilter;
  status?: AnalysisStatusFilter[];
  phaseCoverage?: PhaseCoverage[];
  /** Free-text patient or study id search. */
  search?: string;
}

export interface CasesListItem {
  id: string;
  studyId: string;
  status: AnalysisStatusFilter;
  createdAt: string;
  updatedAt: string;
  stage?: string;
}

export interface CasesListPage {
  items: CasesListItem[];
  /** Opaque cursor for the next page; `null` = last page. */
  nextPageToken: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export const casesListQueryKey = (tenantId: string | null, filters: CasesListFilters) =>
  ['tenant', tenantId ?? '__anon__', 'analyses', filters] as const;

async function fetchCasesPage(
  filters: CasesListFilters,
  pageToken: string | undefined,
): Promise<CasesListPage> {
  const baseUrl = readApiBaseUrl();
  const url = new URL(`${baseUrl}/analyses`, window.location.origin);
  if (pageToken) url.searchParams.set('page_token', pageToken);
  if (filters.dateRange?.from) url.searchParams.set('from', filters.dateRange.from);
  if (filters.dateRange?.to) url.searchParams.set('to', filters.dateRange.to);
  if (filters.status?.length) url.searchParams.set('status', filters.status.join(','));
  if (filters.phaseCoverage?.length)
    url.searchParams.set('phase_coverage', filters.phaseCoverage.join(','));
  if (filters.search) url.searchParams.set('q', filters.search);

  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load cases list: HTTP ${res.status}`);
  return (await res.json()) as CasesListPage;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseCasesListOptions {
  filters?: CasesListFilters;
  /**
   * Enable automatic prefetch of the next page whenever `fetchNextPage`
   * is not already in flight. Defaults to `true`. Callers that
   * implement virtualised scrolling can trigger prefetch manually
   * instead by calling `fetchNextPage()` near the viewport bottom.
   */
  prefetchNext?: boolean;
}

export function useCasesList(options: UseCasesListOptions = {}) {
  const { filters = {}, prefetchNext = true } = options;
  const { tenant } = useAuth();
  const tenantId = tenant?.id ?? null;
  const queryClient = useQueryClient();

  const query = useInfiniteQuery<CasesListPage, Error>({
    queryKey: casesListQueryKey(tenantId ?? null, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchCasesPage(filters, pageParam as string | undefined),
    getNextPageParam: (lastPage) => lastPage.nextPageToken ?? undefined,
    staleTime: 30_000,
  });

  // Background prefetch: as soon as page N resolves and has a next token,
  // kick off page N+1. Consumers that already render a virtual list near
  // the bottom will call `fetchNextPage()` explicitly — this is the gentle
  // "idle prefetch" for fast-scroll UX.
  useEffect(() => {
    if (!prefetchNext) return;
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    const t = setTimeout(() => {
      void query.fetchNextPage();
    }, 250);
    return () => clearTimeout(t);
  }, [
    prefetchNext,
    query.hasNextPage,
    query.isFetchingNextPage,
    // Re-arm the prefetch whenever a new page lands.
    query.data?.pages.length,
    query.fetchNextPage,
  ]);

  // Expose an explicit invalidator so list-scoped mutations (upload,
  // retract, erasure) can force a refresh with the correct key shape.
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: casesListQueryKey(tenantId ?? null, filters) });

  return {
    pages: query.data?.pages ?? [],
    items: (query.data?.pages ?? []).flatMap((p) => p.items),
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    hasNextPage: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
    invalidate,
  };
}
