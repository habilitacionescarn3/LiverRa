// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * CasesListView — T173
 *
 * Tenant-scoped list of liver analyses. Renders as a responsive table on
 * ≥ 768 px and a card list on mobile. Supports:
 *   - Filters: date range, status, phase coverage (persisted to URL query)
 *   - Pagination: 25/page default, configurable
 *   - Empty / loading / error states with EMR* components
 *
 * Data source is `useCasesList()` (sibling agent, T183). Until wired, we
 * use a local stub via `window.fetch` so the view renders in isolation.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconFilter,
  IconFolderOpen,
  IconListDetails,
  IconPlayerPlay,
  IconUpload,
} from '@tabler/icons-react';
import {
  EMRAlert as Alert,
  EMRButton,
  EMREmptyState as EmptyState,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableSkeleton as Skeleton,
} from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';
import { useHasPermission } from '../../contexts/PermissionContext';
import { getCurrentAccessToken } from '../../services/auth';

/** Analysis status values mirror the backend enum (T133).
 *
 * Note: backend's Postgres CHECK constraint emits `'completed'`; legacy
 * frontend code paths still reference `'done'`. Both are accepted here
 * until the enum is fully aligned. */
export type AnalysisStatus =
  | 'uploading'
  | 'anonymizing'
  | 'queued'
  | 'running'
  | 'done'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** A single row from the cases list. */
export interface CaseRow {
  analysisId: string;
  studyUidShort: string;
  patientReference: string;
  uploadedAt: string;
  status: AnalysisStatus;
  flrPct?: number;
  thumbnailUrl?: string;
  phaseCoverage?: ('arterial' | 'portal' | 'venous' | 'delayed' | 'native')[];
}

/** Response envelope used by both the hook and the local stub. */
interface CasesListResponse {
  items: CaseRow[];
  total: number;
}

/** Props for this view. */
export interface CasesListViewProps {
  /** Optional pre-fetched data — skips the hook (tests, SSR). */
  initialData?: CasesListResponse;
  /** Base URL for API. Defaults to `/api/v1`. */
  apiBaseUrl?: string;
}

/** Allowed filter keys; kept in sync with URL query params. */
interface Filters {
  status: AnalysisStatus | 'all';
  dateFrom: string;
  dateTo: string;
  phase: 'all' | 'arterial' | 'portal' | 'venous' | 'delayed' | 'native';
  page: number;
  pageSize: number;
}

const DEFAULT_FILTERS: Filters = {
  status: 'all',
  dateFrom: '',
  dateTo: '',
  phase: 'all',
  page: 1,
  pageSize: 25,
};

/** Coerce URL search params into a typed `Filters` object. */
function parseFilters(params: URLSearchParams): Filters {
  const page = Number(params.get('page') ?? '1');
  const pageSize = Number(params.get('pageSize') ?? '25');
  return {
    status: (params.get('status') as Filters['status']) || 'all',
    dateFrom: params.get('dateFrom') ?? '',
    dateTo: params.get('dateTo') ?? '',
    phase: (params.get('phase') as Filters['phase']) || 'all',
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 25,
  };
}

/** Serialise `Filters` back to a URLSearchParams record. */
function filtersToQuery(filters: Filters): Record<string, string> {
  const record: Record<string, string> = {};
  if (filters.status !== 'all') record.status = filters.status;
  if (filters.dateFrom) record.dateFrom = filters.dateFrom;
  if (filters.dateTo) record.dateTo = filters.dateTo;
  if (filters.phase !== 'all') record.phase = filters.phase;
  record.page = String(filters.page);
  record.pageSize = String(filters.pageSize);
  return record;
}

/** Map status → EMR semantic colour token. */
function statusColor(status: AnalysisStatus): string {
  switch (status) {
    case 'done':
    case 'completed':
      return 'var(--emr-success)';
    case 'failed':
    case 'cancelled':
      return 'var(--emr-error)';
    case 'running':
      return 'var(--emr-secondary)';
    case 'queued':
    case 'anonymizing':
    case 'uploading':
      return 'var(--emr-warning)';
    default:
      return 'var(--emr-gray-500)';
  }
}

/**
 * Small status badge honoring flex-shrink + whitespace-nowrap per CLAUDE.md
 * (prevents truncation in narrow table columns).
 */
function StatusBadge({ status, label }: { status: AnalysisStatus; label: string }): React.ReactElement {
  return (
    <Box
      style={{
        flexShrink: 0,
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 999,
        background: `color-mix(in srgb, ${statusColor(status)} 14%, transparent)`,
        color: statusColor(status),
        fontSize: 'var(--emr-font-xs)',
        fontWeight: 600,
        lineHeight: 1.4,
      }}
    >
      <Box
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: statusColor(status),
        }}
        aria-hidden="true"
      />
      {label}
    </Box>
  );
}

/**
 * Local fallback data loader. Replaced by `useCasesList()` once T183 lands.
 */
function useCasesListStub(
  filters: Filters,
  apiBaseUrl: string,
  seed?: CasesListResponse,
): { data: CasesListResponse | undefined; loading: boolean; error: Error | null; refetch: () => void } {
  const [data, setData] = useState<CasesListResponse | undefined>(seed);
  const [loading, setLoading] = useState(!seed);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    if (seed) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = new URLSearchParams(filtersToQuery(filters));
    // H-SEC-5: real access token from AuthContext (was hardcoded
    // 'dev-access-token' which forced operators to keep LIVERRA_AUTH_BYPASS=true
    // on the backend; that in turn enabled B-AUTH-3). When unauthenticated,
    // omit the header entirely and let the backend's 401 path reply.
    const accessToken = getCurrentAccessToken();
    const authHeaders: Record<string, string> = accessToken
      ? { Authorization: `Bearer ${accessToken}` }
      : {};
    fetch(`${apiBaseUrl}/analyses?${query.toString()}`, {
      credentials: 'include',
      headers: authHeaders,
    })
      .then((r) => {
        if (!r.ok) throw new Error(`GET /analyses failed: ${r.status}`);
        return r.json() as Promise<{
          items?: Array<{
            id: string;
            study_id: string;
            study_instance_uid?: string | null;
            patient_ref?: string | null;
            status: string;
            queued_at: string;
            completed_at?: string | null;
            pipeline_version?: string;
            flr_pct?: number | null;
          }>;
          next_page_token?: string | null;
          total?: number;
        }>;
      })
      .then((payload) => {
        if (cancelled) return;
        const apiItems = payload.items ?? [];
        const rows: CaseRow[] = apiItems.map((api) => ({
          analysisId: api.id,
          studyUidShort:
            (api.study_instance_uid ?? '').slice(-12) || api.study_id.slice(0, 8),
          patientReference: api.patient_ref ?? '—',
          uploadedAt: api.queued_at,
          status: api.status as AnalysisStatus,
          flrPct: api.flr_pct ?? undefined,
          thumbnailUrl: undefined,
          phaseCoverage: undefined,
        }));
        setData({ items: rows, total: payload.total ?? rows.length });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, filters, reloadKey, seed]);

  return { data, loading, error, refetch };
}

/**
 * Format an ISO datetime into a locale-aware short string.
 */
function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Responsive card tile used on mobile instead of the desktop table.
 */
function CaseCard({
  row,
  onClick,
  locale,
  t,
}: {
  row: CaseRow;
  onClick: () => void;
  locale: string;
  t: (k: string, p?: Record<string, string | number>) => string;
}): React.ReactElement {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        display: 'flex',
        gap: 12,
        padding: 16,
        borderRadius: 'var(--emr-border-radius-lg)',
        background: 'var(--emr-bg-card)',
        border: '1px solid var(--emr-border-color)',
        cursor: 'pointer',
        minHeight: 88,
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
      }}
    >
      <Box
        style={{
          width: 64,
          height: 64,
          borderRadius: 'var(--emr-border-radius)',
          background: 'var(--emr-bg-hover)',
          backgroundImage: row.thumbnailUrl ? `url(${row.thumbnailUrl})` : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Group justify="space-between" wrap="wrap" gap={4}>
          <Text
            fz="var(--emr-font-md)"
            fw={600}
            c="var(--emr-text-primary)"
            style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {row.studyUidShort}
          </Text>
          <StatusBadge status={row.status} label={t(`analysis:status.${row.status}`)} />
        </Group>
        <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
          {row.patientReference}
        </Text>
        <Group justify="space-between" wrap="wrap" gap={4}>
          <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)">
            {formatDate(row.uploadedAt, locale)}
          </Text>
          {row.flrPct !== undefined && (
            <Text
              fz="var(--emr-font-xs)"
              fw={600}
              c="var(--emr-text-primary)"
              style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              FLR&nbsp;{row.flrPct.toFixed(1)}%
            </Text>
          )}
        </Group>
      </Stack>
    </Box>
  );
}

/**
 * CasesListView — list + filter + pagination of analyses.
 */
function CasesListViewInner({
  initialData,
  apiBaseUrl = '/api/v1',
}: CasesListViewProps): React.ReactElement {
  const { t, locale } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useMediaQuery('(max-width: 767px)');

  // M-CASE-1: defense-in-depth — route already gates on `analysis.view`,
  // but if a misconfigured route or stale RBAC payload slips through,
  // we don't want the stub fetch hook below to leak case rows.
  const canViewAnalysis = useHasPermission('analysis.view');

  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  // Document title for the browser tab.
  useEffect(() => {
    const base = t('analysis:cases.title') ?? 'Cases';
    document.title = `${base} · LiverRa`;
  }, [t]);

  const { data, loading, error, refetch } = useCasesListStub(filters, apiBaseUrl, initialData);

  const setFilter = useCallback(
    (patch: Partial<Filters>) => {
      const next = { ...filters, ...patch };
      // Reset to page 1 whenever a non-pagination filter changes.
      if (
        patch.status !== undefined ||
        patch.phase !== undefined ||
        patch.dateFrom !== undefined ||
        patch.dateTo !== undefined
      ) {
        next.page = 1;
      }
      setSearchParams(filtersToQuery(next));
    },
    [filters, setSearchParams],
  );

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / filters.pageSize));

  const statusOptions = [
    { label: t('analysis:status.all'), value: 'all' },
    { label: t('analysis:status.running'), value: 'running' },
    { label: t('analysis:status.queued'), value: 'queued' },
    { label: t('analysis:status.done'), value: 'done' },
    { label: t('analysis:status.failed'), value: 'failed' },
  ];

  if (!canViewAnalysis) {
    return (
      <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string}>
        <Alert variant="error" title={t('common:permissionDenied.title')}>
          {t('common:permissionDenied.body')}
        </Alert>
      </Stack>
    );
  }

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string}>
      <EMRPageHeader
        icon={IconListDetails}
        title={t('analysis:cases.title')}
        subtitle={t('analysis:cases.subtitle')}
        badge={data ? { count: data.total, variant: 'primary' } : undefined}
        actions={
          <Group gap="xs" wrap="wrap">
            <EMRButton
              variant="ghost"
              icon={IconPlayerPlay}
              onClick={() => navigate('/demo-case')}
            >
              {t('nav:try_demo')}
            </EMRButton>
            <EMRButton
              variant="primary"
              icon={IconUpload}
              onClick={() => navigate('/pacs/studies')}
            >
              {t('analysis:cases.newUpload')}
            </EMRButton>
          </Group>
        }
      />

      {/* Filters */}
      <Box
        style={{
          padding: 12,
          borderRadius: 'var(--emr-border-radius-lg)',
          background: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-border-color)',
        }}
      >
        <Group wrap="wrap" gap="sm" align="flex-end">
          <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
            <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
              {t('analysis:cases.filters.status')}
            </Text>
            <SegmentedControl
              size="xs"
              data={statusOptions}
              value={filters.status}
              onChange={(v) => setFilter({ status: v as Filters['status'] })}
            />
          </Stack>
          <Stack gap={4}>
            <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
              {t('analysis:cases.filters.dateFrom')}
            </Text>
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setFilter({ dateFrom: e.target.value })}
              style={{
                height: 32,
                padding: '4px 8px',
                fontSize: 'var(--emr-font-sm)',
                border: '1px solid var(--emr-border-color)',
                borderRadius: 'var(--emr-border-radius-sm)',
                background: 'var(--emr-bg-input)',
                color: 'var(--emr-text-primary)',
              }}
              aria-label={t('analysis:cases.filters.dateFrom')}
            />
          </Stack>
          <Stack gap={4}>
            <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
              {t('analysis:cases.filters.dateTo')}
            </Text>
            <input
              type="date"
              value={filters.dateTo}
              onChange={(e) => setFilter({ dateTo: e.target.value })}
              style={{
                height: 32,
                padding: '4px 8px',
                fontSize: 'var(--emr-font-sm)',
                border: '1px solid var(--emr-border-color)',
                borderRadius: 'var(--emr-border-radius-sm)',
                background: 'var(--emr-bg-input)',
                color: 'var(--emr-text-primary)',
              }}
              aria-label={t('analysis:cases.filters.dateTo')}
            />
          </Stack>
          <EMRButton
            variant="ghost"
            icon={IconFilter}
            onClick={() => setSearchParams({})}
          >
            {t('analysis:cases.filters.reset')}
          </EMRButton>
        </Group>
      </Box>

      {/* Error banner */}
      {error && (
        <Alert
          variant="error"
          title={t('analysis:cases.error.title')}
          icon={IconAlertCircle}
        >
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Text fz="var(--emr-font-sm)" style={{ minWidth: 0, flex: 1 }}>
              {error.message}
            </Text>
            <EMRButton variant="secondary" size="sm" onClick={refetch}>
              {t('analysis:cases.error.retry')}
            </EMRButton>
          </Group>
        </Alert>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <Skeleton rows={10} columns={isMobile ? 2 : 6} />
      )}

      {/* Empty state — point users to the PACS list, where AI runs are
          actually triggered (see PacsStudiesView's RunAIButton). */}
      {!loading && !error && data && data.items.length === 0 && (
        <EmptyState
          icon={IconFolderOpen}
          title={t('analysis:cases.empty.title')}
          description={t('analysis:cases.empty.description')}
          action={{
            label: t('analysis:cases.empty.fromPacs') ?? 'Browse PACS studies',
            onClick: () => navigate('/pacs/studies'),
            icon: IconFolderOpen,
          }}
          secondaryAction={{
            label: t('nav:try_demo'),
            onClick: () => navigate('/demo-case'),
          }}
        />
      )}

      {/* Data — mobile cards */}
      {!loading && !error && rows.length > 0 && isMobile && (
        <SimpleGrid cols={1} spacing="sm">
          {rows.map((row) => (
            <CaseCard
              key={row.analysisId}
              row={row}
              locale={locale}
              t={t}
              onClick={() => navigate(`/cases/${row.analysisId}`)}
            />
          ))}
        </SimpleGrid>
      )}

      {/* Data — desktop table */}
      {!loading && !error && rows.length > 0 && !isMobile && (
        <Box
          style={{
            borderRadius: 'var(--emr-border-radius-lg)',
            border: '1px solid var(--emr-border-color)',
            overflow: 'hidden',
            background: 'var(--emr-bg-card)',
          }}
        >
          <Table
            striped
            highlightOnHover
            verticalSpacing="sm"
            horizontalSpacing="md"
            aria-label={t('analysis:cases.tableAria')}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 80 }}>{t('analysis:cases.col.thumb')}</Table.Th>
                <Table.Th>{t('analysis:cases.col.studyUid')}</Table.Th>
                <Table.Th>{t('analysis:cases.col.patient')}</Table.Th>
                <Table.Th>{t('analysis:cases.col.uploadedAt')}</Table.Th>
                <Table.Th>{t('analysis:cases.col.status')}</Table.Th>
                <Table.Th>{t('analysis:cases.col.flr')}</Table.Th>
                <Table.Th style={{ width: 120 }}>{t('analysis:cases.col.actions')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr
                  key={row.analysisId}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/cases/${row.analysisId}`)}
                >
                  <Table.Td>
                    <Box
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 'var(--emr-border-radius-sm)',
                        background: 'var(--emr-bg-hover)',
                        backgroundImage: row.thumbnailUrl
                          ? `url(${row.thumbnailUrl})`
                          : undefined,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                      }}
                      aria-hidden="true"
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text
                      fz="var(--emr-font-sm)"
                      fw={500}
                      style={{ fontFamily: 'var(--emr-font-mono)' }}
                    >
                      {row.studyUidShort}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text fz="var(--emr-font-sm)">{row.patientReference}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
                      {formatDate(row.uploadedAt, locale)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={row.status} label={t(`analysis:status.${row.status}`)} />
                  </Table.Td>
                  <Table.Td>
                    {row.flrPct !== undefined ? (
                      <Text fz="var(--emr-font-sm)" fw={600}>
                        {row.flrPct.toFixed(1)}%
                      </Text>
                    ) : (
                      <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <EMRButton
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/cases/${row.analysisId}`)}
                    >
                      {t('analysis:cases.open')}
                    </EMRButton>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      )}

      {/* Pagination */}
      {!loading && !error && (data?.total ?? 0) > filters.pageSize && (
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
            {t('analysis:cases.pagination.summary', {
              from: (filters.page - 1) * filters.pageSize + 1,
              to: Math.min(filters.page * filters.pageSize, data?.total ?? 0),
              total: data?.total ?? 0,
            })}
          </Text>
          <Group gap="xs" wrap="wrap">
            <EMRButton
              variant="secondary"
              size="sm"
              disabled={filters.page <= 1}
              onClick={() => setFilter({ page: filters.page - 1 })}
            >
              {t('analysis:cases.pagination.prev')}
            </EMRButton>
            <Text
              fz="var(--emr-font-sm)"
              style={{ flexShrink: 0, whiteSpace: 'nowrap', alignSelf: 'center' }}
            >
              {t('analysis:cases.pagination.pageOf', {
                page: filters.page,
                total: totalPages,
              })}
            </Text>
            <EMRButton
              variant="secondary"
              size="sm"
              disabled={filters.page >= totalPages}
              onClick={() => setFilter({ page: filters.page + 1 })}
            >
              {t('analysis:cases.pagination.next')}
            </EMRButton>
          </Group>
        </Group>
      )}
    </Stack>
  );
}

/**
 * Default export wraps the inner view in `EMRErrorBoundary` + `Suspense`.
 */
export default function CasesListView(props: CasesListViewProps): React.ReactElement {
  return (
    <EMRErrorBoundary>
      <Suspense fallback={<Skeleton rows={10} columns={6} />}>
        <CasesListViewInner {...props} />
      </Suspense>
    </EMRErrorBoundary>
  );
}
