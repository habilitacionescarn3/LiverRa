// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AnalysisDetailView — T174
 *
 * Mirrors MediMind's `ImagingTabView.tsx` port pattern:
 *   - Lazy-load heavy 3D viewer + FLR panel (chunks only load when needed)
 *   - `LiverErrorBoundary` wrapper (LiverRa rename of MediMind's PACSErrorBoundary)
 *   - Resizable left drawer with tabs (Segments / Lesions / Measurements / Notes)
 *   - Bottom strip placeholder for US2's MultiPlanarViews
 *
 * Consumes `useAnalysis()` (sibling agent) when available, falls back to
 * a lightweight local hook so the view renders in isolation.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge, Box, Group, Stack, Tabs, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import {
  IconActivity,
  IconArrowLeft,
  IconClipboardList,
  IconDownload,
  IconLayoutDashboard,
  IconNotes,
  IconRuler,
  IconStethoscope,
  IconTarget,
} from '@tabler/icons-react';
import {
  EMRAlert,
  EMRBreadcrumbs,
  EMRButton,
  EMREmptyState,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRSkeleton,
} from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';
import { ColdStartIndicator } from '../../components/liver/ColdStartIndicator';
import { RUODisclaimer } from '../../components/ruo/RUODisclaimer';
import { useAnalysis } from '../../hooks/useAnalysis';
import { CascadeStageTimeline } from '../../components/cases/CascadeStageTimeline';
import { SegmentsList } from '../../components/cases/SegmentsList';

/** `LiverErrorBoundary` — LiverRa rename of MediMind's `PACSErrorBoundary`. */
const LiverErrorBoundary = EMRErrorBoundary;

// ── Lazy chunks ───────────────────────────────────────────────────────────
// These components live under the `liver/` directory and pull in Cornerstone3D
// + WebGPU shaders; lazy-loading keeps the initial bundle under budget per
// NFR-001 (TTI target). The bundler will code-split automatically.
const LiverViewer3D = lazy(() => import('../../components/liver/LiverViewer3D'));
const FLRPanel = lazy(() => import('../../components/liver/FLRPanel'));

/**
 * Real backend response shape for `GET /api/v1/analyses/{id}`.
 *
 * Plain-English: this is what the FastAPI app actually sends back —
 * snake_case fields, `status: 'completed' | 'queued' | 'running' | 'failed'`,
 * a `stage_progress` ledger, and (optionally) `study_instance_uid` /
 * `patient_ref` so the page header can render without an extra fetch.
 *
 * Replaces the obsolete `AnalysisSummary` interface that the old
 * `useAnalysisStub` returned with camelCase + `'done'` status.
 */
interface BackendAnalysis {
  id: string;
  study_id: string;
  study_instance_uid?: string;
  patient_ref?: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'partial';
  queued_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  pipeline_version?: string;
  error_slug?: string | null;
  // Some endpoints expose a partial-results bag with the FLR default.
  flr_default?: { remnant_pct_functional?: string | number | null } | null;
  /** Ordered cascade-stage ledger surfaced by the backend `/analyses/{id}` GET. */
  stage_progress?: Array<{
    stage_no: number;
    stage: string;
    output_uri: string | null;
    written_at: string;
    model_version: string | null;
    model_license_hash: string | null;
  }>;
}

/** Props for this view. */
export interface AnalysisDetailViewProps {
  /** Pre-fetched analysis — skips the fetch (tests). */
  initialAnalysis?: BackendAnalysis;
  /** Base URL for API. Defaults to `/api/v1`. */
  apiBaseUrl?: string;
}

function readApiBaseUrl(fallback: string): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? fallback).replace(/\/$/, '');
}

/** Tiny "5m ago" / "2h ago" relative-time formatter — no extra dep. */
function relativeFromIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Sibling fetch for the `/results` payload — gives us `flr_default` so the
 * FLR panel can show a real number instead of an em-dash. Lightweight and
 * cached by react-query under `['analysis', id, 'results']`.
 */
interface ResultsBundle {
  flr_default?: {
    remnant_pct_functional?: string | number | null;
    plane_normal?: { x: number; y: number; z: number } | null;
    plane_offset_mm?: string | number | null;
    plane_pose?: {
      axis?: string;
      z_index?: number;
      bbox_z?: [number, number];
      heuristic?: string;
    } | null;
  } | null;
  segmentations?: Array<{
    id: string;
    anatomy_category?: string | null;
    anatomy_detail?: string | null;
    volume_ml?: string | number | null;
    mask_url?: string | null;
  }>;
  lesions?: Array<{
    id: string;
    bbox3d?: {
      x?: number;
      y?: number;
      z?: number;
      dx?: number;
      dy?: number;
      dz?: number;
      x_min?: number;
      y_min?: number;
      z_min?: number;
      x_max?: number;
      y_max?: number;
      z_max?: number;
    } | null;
    couinaud_location?: number | null;
    longest_diameter_mm?: string | number | null;
    classification?: string | null;
  }>;
}

function useAnalysisResults(analysisId: string | null | undefined, apiBaseUrl: string, status?: string) {
  return useQuery<ResultsBundle, Error>({
    queryKey: ['analysis', analysisId, 'results'],
    queryFn: async () => {
      const r = await fetch(`${apiBaseUrl}/analyses/${encodeURIComponent(analysisId!)}/results`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`GET /analyses/${analysisId}/results -> ${r.status}`);
      return r.json();
    },
    enabled: typeof analysisId === 'string' && analysisId.length > 0,
    staleTime: 30_000,
    // While the cascade is running we want the FLR + lesion list to fill in
    // as soon as the relevant stages complete, even if SSE stalls under the
    // Vite dev proxy. Poll every 3s during running/queued; stop after.
    refetchInterval: status === 'running' || status === 'queued' ? 3_000 : false,
  });
}

/** Drawer tab keys. */
type DrawerTab = 'segments' | 'lesions' | 'measurements' | 'notes';

/**
 * Compact lesion list inside the drawer. Fetches `/results` and renders
 * a one-line summary per lesion. Empty/loading/error states are deliberately
 * minimal — the full lesion workflow lives at `/cases/:id/lesions`.
 */
function LesionsTabContent({
  analysisId,
  apiBaseUrl,
}: {
  analysisId: string;
  apiBaseUrl: string;
}): React.ReactElement {
  const { data, isLoading, error } = useQuery<
    {
      lesions?: Array<{
        id: string;
        couinaud_location?: number | null;
        longest_diameter_mm?: string | number | null;
        classification?: string | null;
      }>;
    },
    Error
  >({
    queryKey: ['analysis', analysisId, 'results'],
    queryFn: async () => {
      const r = await fetch(`${apiBaseUrl}/analyses/${encodeURIComponent(analysisId)}/results`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30_000,
  });
  const lesions = data?.lesions ?? [];

  if (isLoading) {
    return (
      <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
        Loading lesions…
      </Text>
    );
  }
  if (error) {
    return (
      <Text fz="var(--emr-font-sm)" c="var(--emr-danger)">
        {error.message}
      </Text>
    );
  }
  if (lesions.length === 0) {
    return (
      <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)" data-testid="lesions-empty">
        No lesions detected.
      </Text>
    );
  }
  return (
    <Stack gap="xs" data-testid="lesions-list">
      <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)" data-testid="lesions-count">
        {lesions.length} lesion{lesions.length === 1 ? '' : 's'}
      </Text>
      {lesions.map((les) => {
        let label = '—';
        let confidence: string | undefined;
        try {
          const parsed = JSON.parse((les.classification as string) ?? '{}') as {
            label?: string;
            confidence?: number;
          };
          if (parsed.label) label = parsed.label;
          if (typeof parsed.confidence === 'number') {
            confidence = `${Math.round(parsed.confidence * 100)}%`;
          }
        } catch {
          /* ignore */
        }
        const diameter =
          les.longest_diameter_mm !== null && les.longest_diameter_mm !== undefined
            ? `${les.longest_diameter_mm} mm`
            : '—';
        return (
          <Box
            key={les.id}
            data-testid={`lesion-row-${les.id}`}
            style={{
              padding: 8,
              borderRadius: 'var(--emr-border-radius-sm, 6px)',
              background: 'var(--emr-bg-card)',
              border: '1px solid var(--emr-gray-200)',
            }}
          >
            <Text fz="var(--emr-font-sm)" fw={600} c="var(--emr-text-primary)">
              {label.toUpperCase()}
              {confidence ? ` · ${confidence}` : ''}
            </Text>
            <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
              Segment {les.couinaud_location ?? '—'} · {diameter}
            </Text>
          </Box>
        );
      })}
    </Stack>
  );
}

const DEFAULT_DRAWER_WIDTH = 320;
const MIN_DRAWER_WIDTH = 220;
const MAX_DRAWER_WIDTH = 560;

/**
 * The actual detail view (unwrapped).
 */
function AnalysisDetailViewInner({
  initialAnalysis,
  apiBaseUrl,
}: AnalysisDetailViewProps): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const baseUrl = readApiBaseUrl(apiBaseUrl ?? '/api/v1');

  // Real backend hook (TanStack Query + SSE invalidation + 3s poll fallback).
  const { analysis: liveAnalysis, isLoading, error } = useAnalysis(id);
  // Sibling /results fetch so we can populate FLR + flag completion.
  const { data: results } = useAnalysisResults(id, baseUrl, liveAnalysis?.status);

  // Coalesce: tests can pass `initialAnalysis`; runtime uses the live query.
  const analysis = (initialAnalysis ?? (liveAnalysis as unknown as BackendAnalysis | undefined)) as
    | BackendAnalysis
    | undefined;

  // Derive the short study label (used in title + breadcrumbs). Prefer the
  // DICOM StudyInstanceUID if the backend surfaces it; otherwise truncate the
  // Postgres study_id UUID. Falls back to the route id when neither is loaded.
  const studyUidShort = useMemo<string>(() => {
    if (!analysis) return (id ?? '').slice(0, 8);
    const uid = analysis.study_instance_uid;
    if (uid && uid.length > 0) {
      return uid.length > 24 ? `…${uid.slice(-12)}` : uid;
    }
    return analysis.study_id ? analysis.study_id.slice(0, 8) : (id ?? '').slice(0, 8);
  }, [analysis, id]);

  const patientReference = analysis?.patient_ref ?? undefined;

  // FLR percentage, parsed from `flr_default.remnant_pct_functional` (string
  // numeric on the wire). Pipes into the FLR panel so it shows a real value.
  const flrPct = useMemo<number | undefined>(() => {
    const raw = results?.flr_default?.remnant_pct_functional ?? null;
    if (raw === null || raw === undefined) return undefined;
    const n = typeof raw === 'string' ? Number.parseFloat(raw) : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }, [results]);

  // Drawer tab badge counts — pulled from the same /results query.
  const segmentsCount = results?.segmentations?.length ?? 0;
  const lesionsCount = results?.lesions?.length ?? 0;
  // "Last updated" timestamp for the viewer card status bar.
  const lastUpdatedIso =
    analysis?.completed_at ?? analysis?.started_at ?? analysis?.queued_at ?? null;

  // Document title — keep the analysis study UID visible in the browser tab.
  useEffect(() => {
    const base = t('analysis:detail.crumbs.cases') ?? 'Analysis';
    const studyShort = studyUidShort || id || '';
    document.title = studyShort
      ? `${base}: ${studyShort} · LiverRa`
      : `${base} · LiverRa`;
  }, [studyUidShort, id, t]);

  // Resizable drawer state — collapses to a sheet on mobile.
  const [drawerWidth, setDrawerWidth] = useState<number>(DEFAULT_DRAWER_WIDTH);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('segments');
  const [resizing, setResizing] = useState(false);

  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startW = drawerWidth;
    const onMove = (ev: PointerEvent): void => {
      const next = Math.min(
        MAX_DRAWER_WIDTH,
        Math.max(MIN_DRAWER_WIDTH, startW + (ev.clientX - startX)),
      );
      setDrawerWidth(next);
    };
    const onUp = (): void => {
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [drawerWidth]);

  const analysisReady = analysis?.status === 'completed';

  const breadcrumbs = useMemo(
    () => [
      { label: t('analysis:detail.crumbs.cases'), href: '/cases' },
      { label: studyUidShort || id || '—' },
    ],
    [studyUidShort, id, t],
  );

  if (error) {
    return (
      <Box p="lg">
        <EMRAlert
          variant="error"
          title={t('analysis:detail.error.title')}
          withCloseButton={false}
        >
          {error.message}
        </EMRAlert>
      </Box>
    );
  }

  if (isLoading || !analysis) {
    return (
      <Stack p="lg" gap="md">
        <EMRSkeleton height={40} width="40%" />
        <EMRSkeleton height={480} />
      </Stack>
    );
  }

  return (
    <Box
      data-testid="analysis-detail-root"
      data-analysis-id={analysis.id}
      data-analysis-status={analysis.status}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 'calc(100vh - 64px)',
        background: 'var(--emr-bg-page)',
      }}
    >
      {/* Header */}
      <Box p={{ base: 'sm', md: 'lg' } as unknown as string}>
        <EMRBreadcrumbs items={breadcrumbs} />
        <EMRPageHeader
          icon={IconStethoscope}
          title={t('analysis:detail.title', { studyUid: studyUidShort })}
          subtitle={patientReference}
          actions={
            <Group wrap="wrap" gap="xs">
              <EMRButton
                variant="ghost"
                icon={IconArrowLeft}
                onClick={() => navigate('/cases')}
              >
                {t('analysis:detail.back')}
              </EMRButton>
              {analysisReady && (
                <EMRButton
                  variant="primary"
                  icon={IconDownload}
                  onClick={() => navigate(`/cases/${analysis.id}/finalize`)}
                  data-testid="analysis-finalize-btn"
                >
                  {t('analysis:detail.openFinalize')}
                </EMRButton>
              )}
            </Group>
          }
        />
      </Box>

      {/* Cold-start banner (auto-hides when predicted_warm_s === 0) */}
      {id && <ColdStartIndicator analysisId={id} status={analysis.status} />}

      {/* Cascade stage timeline — surfaces the pipeline_checkpoint ledger so
          a clinician can see what the AI has already produced + per-stage
          stats (parenchyma volume, lesion count, FLR%). Auto-hides when
          stage_progress is empty (analysis still queued). */}
      <CascadeStageTimeline
        analysisId={analysis.id}
        stageProgress={analysis.stage_progress}
        apiBaseUrl={baseUrl}
        analysisStatus={analysis.status}
      />

      {/* Main workspace: drawer | viewer | FLR */}
      <Box
        style={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          flex: 1,
          minHeight: 0,
          padding: isMobile ? 8 : 16,
          gap: 12,
        }}
      >
        {/* Left drawer */}
        <Box
          style={{
            width: isMobile ? '100%' : drawerWidth,
            minWidth: isMobile ? 0 : MIN_DRAWER_WIDTH,
            flexShrink: 0,
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-gray-200)',
            borderRadius: 'var(--emr-border-radius-lg)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
          aria-label={t('analysis:detail.drawerAria')}
        >
          {/* Sticky drawer header — gives the panel an identity */}
          <Box
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--emr-gray-200)',
              background: 'var(--emr-bg-card)',
              flexShrink: 0,
            }}
          >
            <Group gap={8} wrap="nowrap" align="center">
              <IconClipboardList
                size={16}
                style={{ color: 'var(--emr-text-secondary)', flexShrink: 0 }}
              />
              <Stack gap={0} style={{ minWidth: 0 }}>
                <Text
                  fz="var(--emr-font-sm)"
                  fw={600}
                  c="var(--emr-text-primary)"
                  truncate
                >
                  {t('analysis:detail.workspace.title')}
                </Text>
                <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)" truncate>
                  {t('analysis:detail.workspace.subtitle')}
                </Text>
              </Stack>
            </Group>
          </Box>

          <Tabs
            value={drawerTab}
            onChange={(v) => v && setDrawerTab(v as DrawerTab)}
            variant="pills"
            radius="md"
            styles={{
              list: {
                padding: 8,
                background: 'transparent',
                borderBottom: '1px solid var(--emr-gray-200)',
                flexWrap: 'wrap',
              },
              tab: {
                fontSize: 'var(--emr-font-xs)',
                fontWeight: 600,
                flexShrink: 0,
                whiteSpace: 'nowrap',
              },
            }}
          >
            <Tabs.List>
              <Tabs.Tab
                value="segments"
                leftSection={<IconLayoutDashboard size={14} />}
                rightSection={
                  segmentsCount > 0 ? (
                    <Badge
                      size="xs"
                      variant="light"
                      color="gray"
                      radius="sm"
                      data-testid="drawer-tab-segments-count"
                    >
                      {segmentsCount}
                    </Badge>
                  ) : undefined
                }
              >
                {t('analysis:detail.tabs.segments')}
              </Tabs.Tab>
              <Tabs.Tab
                value="lesions"
                leftSection={<IconTarget size={14} />}
                rightSection={
                  lesionsCount > 0 ? (
                    <Badge
                      size="xs"
                      variant="light"
                      color="gray"
                      radius="sm"
                      data-testid="drawer-tab-lesions-count"
                    >
                      {lesionsCount}
                    </Badge>
                  ) : undefined
                }
              >
                {t('analysis:detail.tabs.lesions')}
              </Tabs.Tab>
              <Tabs.Tab value="measurements" leftSection={<IconRuler size={14} />}>
                {t('analysis:detail.tabs.measurements')}
              </Tabs.Tab>
              <Tabs.Tab value="notes" leftSection={<IconNotes size={14} />}>
                {t('analysis:detail.tabs.notes')}
              </Tabs.Tab>
            </Tabs.List>

            <Box style={{ padding: 12, overflowY: 'auto', flex: 1 }}>
              <Tabs.Panel value="segments">
                <SegmentsList analysisId={analysis.id} apiBaseUrl={baseUrl} />
              </Tabs.Panel>
              <Tabs.Panel value="lesions">
                <LesionsTabContent analysisId={analysis.id} apiBaseUrl={baseUrl} />
              </Tabs.Panel>
              <Tabs.Panel value="measurements">
                <EMREmptyState
                  icon={IconRuler}
                  title={t('analysis:detail.drawer.measurementsEmpty.title')}
                  description={t('analysis:detail.drawer.measurementsEmpty.description')}
                  size="sm"
                  action={{
                    label: t('analysis:detail.drawer.openRefinement'),
                    onClick: () => navigate(`/cases/${analysis.id}/refine`),
                  }}
                />
              </Tabs.Panel>
              <Tabs.Panel value="notes">
                <EMREmptyState
                  icon={IconNotes}
                  title={t('analysis:detail.drawer.notesEmpty.title')}
                  description={t('analysis:detail.drawer.notesEmpty.description')}
                  size="sm"
                  action={{
                    label: t('analysis:detail.drawer.openRefinement'),
                    onClick: () => navigate(`/cases/${analysis.id}/refine`),
                  }}
                />
              </Tabs.Panel>
            </Box>
          </Tabs>
        </Box>

        {/* Resizer handle */}
        {!isMobile && (
          <Box
            role="separator"
            aria-orientation="vertical"
            aria-label={t('analysis:detail.resizeAria')}
            onPointerDown={startResize}
            style={{
              width: 6,
              cursor: 'col-resize',
              background: resizing
                ? 'var(--emr-accent-alpha-20)'
                : 'transparent',
              borderRadius: 3,
              flexShrink: 0,
              alignSelf: 'stretch',
            }}
          />
        )}

        {/* Centre: viewer (the hero) */}
        <Box
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 'var(--emr-border-radius-lg)',
            overflow: 'hidden',
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-gray-200)',
            minHeight: isMobile ? 360 : 560,
          }}
        >
          {/* Internal toolbar / status bar */}
          <Box
            style={{
              minHeight: 40,
              padding: '6px 12px',
              borderBottom: '1px solid var(--emr-gray-200)',
              background: 'var(--emr-bg-card)',
              flexShrink: 0,
            }}
          >
            <Group justify="space-between" wrap="wrap" gap="xs" align="center">
              <Group gap={10} wrap="wrap" align="center" style={{ minWidth: 0 }}>
                <Text
                  fz="var(--emr-font-xs)"
                  fw={600}
                  c="var(--emr-text-secondary)"
                  truncate
                  data-testid="viewer-card-study-label"
                >
                  {t('analysis:detail.viewerCard.studyLabel', { uid: studyUidShort })}
                </Text>
                <Badge
                  size="xs"
                  variant="light"
                  color={
                    analysis.status === 'completed'
                      ? 'green'
                      : analysis.status === 'failed'
                        ? 'red'
                        : analysis.status === 'running' || analysis.status === 'partial'
                          ? 'blue'
                          : 'gray'
                  }
                  radius="sm"
                  styles={{ root: { textTransform: 'none', fontWeight: 600 } }}
                >
                  {t(`analysis:status.${analysis.status}`) || analysis.status}
                </Badge>
                <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)">
                  {t('analysis:detail.viewerCard.lastUpdated', {
                    when: relativeFromIso(lastUpdatedIso),
                  })}
                </Text>
              </Group>
              {patientReference && (
                <Badge
                  size="xs"
                  variant="light"
                  color="gray"
                  radius="sm"
                  styles={{ root: { textTransform: 'none', fontWeight: 600 } }}
                >
                  {patientReference}
                </Badge>
              )}
            </Group>
          </Box>

          <Box style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <LiverErrorBoundary>
              <Suspense
                fallback={
                  <Stack p="lg" gap="md" align="center" justify="center" style={{ height: '100%' }}>
                    <EMRSkeleton height={48} width="60%" />
                    <EMRSkeleton height={240} />
                    <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)">
                      {t('analysis:detail.viewer.loading')}
                    </Text>
                  </Stack>
                }
              >
                <LiverViewer3D
                  analysisId={analysis.id}
                  ready={analysisReady}
                  studyInstanceUid={analysis.study_instance_uid}
                  parenchymaMaskUri={
                    results?.segmentations?.find(
                      (s) => s.anatomy_category === 'liver',
                    )?.mask_url ?? undefined
                  }
                  segmentations={results?.segmentations ?? []}
                  lesionCount={results?.lesions?.length ?? 0}
                  lesions={results?.lesions ?? []}
                  flrDefault={results?.flr_default ?? null}
                />
              </Suspense>
            </LiverErrorBoundary>
          </Box>
        </Box>

        {/* Right: FLR panel — money-number card */}
        <Box
          style={{
            width: isMobile ? '100%' : 320,
            flexShrink: 0,
            borderRadius: 'var(--emr-border-radius-lg)',
            overflow: 'hidden',
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-gray-200)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* FLR card header strip */}
          <Box
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--emr-gray-200)',
              background: 'var(--emr-bg-card)',
              flexShrink: 0,
            }}
          >
            <Group gap={8} wrap="nowrap" align="center">
              <IconActivity
                size={16}
                style={{ color: 'var(--emr-text-secondary)', flexShrink: 0 }}
              />
              <Stack gap={0} style={{ minWidth: 0 }}>
                <Text
                  fz="var(--emr-font-sm)"
                  fw={600}
                  c="var(--emr-text-primary)"
                  truncate
                >
                  {t('analysis:flr.title')}
                </Text>
                <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)" truncate>
                  {t('analysis:detail.flr.subtitle')}
                </Text>
              </Stack>
            </Group>
          </Box>
          <LiverErrorBoundary>
            <Suspense
              fallback={
                <Stack p="md" gap="sm">
                  <EMRSkeleton height={24} width="50%" />
                  <EMRSkeleton height={120} />
                </Stack>
              }
            >
              <FLRPanel analysisId={analysis.id} initialFlrPct={flrPct} />
            </Suspense>
          </LiverErrorBoundary>
        </Box>
      </Box>

      {/* Bottom status / disclaimer footer — replaces the old dashed placeholder */}
      <Box
        style={{
          margin: isMobile ? 8 : 16,
          marginTop: 0,
          padding: '10px 16px',
          borderRadius: 'var(--emr-border-radius-lg)',
          background: 'var(--emr-bg-card)',
          borderTop: '1px solid var(--emr-gray-200)',
          border: '1px solid var(--emr-gray-200)',
        }}
        aria-label={t('analysis:detail.mprAria')}
      >
        <Group justify="space-between" gap="sm" wrap="wrap" align="center">
          <Group gap={8} wrap="nowrap" align="center" style={{ minWidth: 0 }}>
            <IconActivity
              size={14}
              style={{ color: 'var(--emr-text-tertiary)', flexShrink: 0 }}
            />
            <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)" truncate>
              {t('analysis:detail.mprPlaceholder')}
            </Text>
          </Group>
          <Badge
            size="sm"
            variant="light"
            color="orange"
            radius="sm"
            styles={{ root: { textTransform: 'none', fontWeight: 600 } }}
          >
            {t('analysis:detail.ruoBadge')}
          </Badge>
        </Group>
      </Box>

      {/* RUO disclaimer — always rendered whenever AI output is on screen */}
      <RUODisclaimer />
    </Box>
  );
}

/**
 * Default export. Wraps the view in `LiverErrorBoundary` so runtime errors
 * (WebGPU init, Cornerstone init, SSE failures) render a recovery UI instead
 * of crashing the whole SPA shell.
 */
export default function AnalysisDetailView(
  props: AnalysisDetailViewProps,
): React.ReactElement {
  return (
    <LiverErrorBoundary>
      <AnalysisDetailViewInner {...props} />
    </LiverErrorBoundary>
  );
}
