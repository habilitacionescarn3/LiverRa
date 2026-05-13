// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useReportSummary — TanStack Query wrapper over fetchReportSummaryWithMeta.
 *
 * Consumed by BOTH `ACRStructuredReadout` (002-acr-structured-readout)
 * and `ReportInlineView`. Single source of truth for the report-summary
 * wire shape + caching policy.
 *
 * 60s staleTime matches the prior inline `useQuery` call so cascade
 * re-renders don't thrash the network. ETag is surfaced separately so
 * the clipboard concurrency gate can capture it at panel-open time
 * (contracts/readout-api.md §2).
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import {
  fetchReportSummaryWithMeta,
  type ReportSummary,
  type ReportSummaryWithMeta,
} from '../services/report/reportSummary';

export interface UseReportSummaryResult {
  /** TanStack Query result for the body (typed as ReportSummary for back-compat with callers). */
  query: UseQueryResult<ReportSummary, Error>;
  /** Latest ETag seen on a GET. `null` until first successful fetch. */
  etag: string | null;
  /** Latest Last-Modified header (or null). */
  lastModified: string | null;
  /** Convenience accessor for the underlying body. */
  data: ReportSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: UseQueryResult<ReportSummary, Error>['refetch'];
}

/**
 * @param analysisId — UUID of the analysis. Empty string disables the
 *   query (matches the original behaviour in ReportInlineView).
 * @param options.staleTime — override the default 60s if a host needs
 *   tighter freshness (e.g. running-cascade poll).
 */
export function useReportSummary(
  analysisId: string,
  options: { staleTime?: number; enabled?: boolean } = {},
): UseReportSummaryResult {
  const staleTime = options.staleTime ?? 60_000;
  const enabled = options.enabled ?? !!analysisId;

  const inner = useQuery<ReportSummaryWithMeta, Error>({
    queryKey: ['report-summary', analysisId],
    queryFn: () => fetchReportSummaryWithMeta(analysisId),
    enabled,
    staleTime,
  });

  // Adapter — surface body as `data` so callers can keep their old shape.
  const data = inner.data?.body;
  const query: UseQueryResult<ReportSummary, Error> = {
    ...inner,
    data,
  } as unknown as UseQueryResult<ReportSummary, Error>;

  return {
    query,
    etag: inner.data?.etag ?? null,
    lastModified: inner.data?.lastModified ?? null,
    data,
    isLoading: inner.isLoading,
    isError: inner.isError,
    refetch: query.refetch,
  };
}
