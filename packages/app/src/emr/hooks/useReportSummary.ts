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
  /** TanStack Query result projected onto the report body. */
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

  // M-TYPE-1 fix: previously this hook reshaped a UseQueryResult via
  // ``as unknown as UseQueryResult<ReportSummary, Error>``, which
  // violated TanStack's discriminated union (``status: 'success'``
  // could co-exist with ``data: undefined`` because we'd swapped
  // ``data`` for ``inner.data?.body``). The proper TanStack idiom is
  // ``select``: it runs after caching and projects a typed body out
  // of the wire envelope without violating the union.
  //
  // We also need the raw ``etag`` / ``lastModified`` headers for the
  // clipboard concurrency gate, so we run TWO ``useQuery`` calls with
  // the SAME query key — TanStack deduplicates the underlying fetch,
  // so this is one network request and one cache entry. The first
  // query exposes the envelope, the second projects the body.
  const envelope = useQuery<ReportSummaryWithMeta, Error>({
    queryKey: ['report-summary', analysisId],
    queryFn: () => fetchReportSummaryWithMeta(analysisId),
    enabled,
    staleTime,
  });

  const query = useQuery<ReportSummaryWithMeta, Error, ReportSummary>({
    queryKey: ['report-summary', analysisId],
    queryFn: () => fetchReportSummaryWithMeta(analysisId),
    enabled,
    staleTime,
    select: (e) => e.body,
  });

  return {
    query,
    etag: envelope.data?.etag ?? null,
    lastModified: envelope.data?.lastModified ?? null,
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
