// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useReport (T273).
 *
 * Plain-English: fetches + polls `GET /api/v1/reports/{id}`. While the
 * Report is still in `finalizing` status (builders haven't completed
 * yet) the hook polls every 2 seconds; once it flips to `finalized`,
 * `retracted`, or `superseded` polling stops and the result is cached
 * indefinitely.
 *
 * Consumers: `ReportView.tsx` (landing page) and `PDFPreview.tsx`
 * (iframe + pdf URI).
 */
import { useQuery } from '@tanstack/react-query';

export interface Report {
  id: string;
  analysis_id: string;
  surgeon_review_id: string;
  status: 'draft' | 'finalizing' | 'finalized' | 'superseded' | 'retracted';
  finalized_at?: string | null;
  superseded_by_report_id?: string | null;
  retracted_at?: string | null;
  retraction_reason?: string | null;
  pdf_s3_uri?: string | null;
  seg_sop_instance_uid?: string | null;
  sr_sop_instance_uid?: string | null;
  sample_case_flag: boolean;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

async function fetchReport(reportId: string): Promise<Report> {
  const base = readApiBaseUrl();
  const res = await fetch(`${base}/reports/${encodeURIComponent(reportId)}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`GET /reports/${reportId} failed (HTTP ${res.status})`);
  }
  return (await res.json()) as Report;
}

export interface UseReportOptions {
  /** Override the 2s polling interval while the report is still finalizing. */
  pollIntervalMs?: number;
  /** Disable the query (useful when the reportId is not known yet). */
  enabled?: boolean;
}

export function useReport(
  reportId: string | null | undefined,
  options: UseReportOptions = {},
): ReturnType<typeof useQuery<Report, Error>> {
  const { pollIntervalMs = 2000, enabled = true } = options;
  return useQuery<Report, Error>({
    queryKey: ['reports', reportId],
    queryFn: () => fetchReport(reportId as string),
    enabled: Boolean(reportId) && enabled,
    refetchInterval: (query) => {
      const data = query.state.data as Report | undefined;
      if (!data) return pollIntervalMs;
      return data.status === 'finalizing' ? pollIntervalMs : false;
    },
  });
}
