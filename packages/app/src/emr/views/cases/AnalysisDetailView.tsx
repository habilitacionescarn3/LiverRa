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
import { Box, Group, Stack, Tabs, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconActivity,
  IconArrowLeft,
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
  EMRErrorBoundary,
  EMRPageHeader,
  EMRSkeleton,
} from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';
import { ColdStartIndicator } from '../../components/liver/ColdStartIndicator';
import { RUODisclaimer } from '../../components/ruo/RUODisclaimer';

/** `LiverErrorBoundary` — LiverRa rename of MediMind's `PACSErrorBoundary`. */
const LiverErrorBoundary = EMRErrorBoundary;

// ── Lazy chunks ───────────────────────────────────────────────────────────
// These components live under the `liver/` directory and pull in Cornerstone3D
// + WebGPU shaders; lazy-loading keeps the initial bundle under budget per
// NFR-001 (TTI target). The bundler will code-split automatically.
const LiverViewer3D = lazy(() => import('../../components/liver/LiverViewer3D'));
const FLRPanel = lazy(() => import('../../components/liver/FLRPanel'));

/** Minimal shape read from the analysis API. */
interface AnalysisSummary {
  id: string;
  status:
    | 'uploading'
    | 'anonymizing'
    | 'queued'
    | 'running'
    | 'done'
    | 'failed'
    | 'cancelled';
  studyUidShort: string;
  patientReference?: string;
  createdAt: string;
  flrPct?: number;
  reportUrl?: string;
}

/** Props for this view. */
export interface AnalysisDetailViewProps {
  /** Pre-fetched analysis — skips the fetch (tests). */
  initialAnalysis?: AnalysisSummary;
  /** Base URL for API. Defaults to `/api/v1`. */
  apiBaseUrl?: string;
}

/**
 * Fallback hook until `useAnalysis()` (sibling agent, T184) is wired.
 */
function useAnalysisStub(
  id: string | undefined,
  apiBaseUrl: string,
  seed?: AnalysisSummary,
): { data: AnalysisSummary | undefined; loading: boolean; error: Error | null } {
  const [data, setData] = useState<AnalysisSummary | undefined>(seed);
  const [loading, setLoading] = useState(!seed);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!id || seed) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${apiBaseUrl}/analyses/${id}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`GET /analyses/${id} → ${r.status}`);
        return r.json() as Promise<AnalysisSummary>;
      })
      .then((p) => {
        if (!cancelled) setData(p);
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
  }, [apiBaseUrl, id, seed]);

  return { data, loading, error };
}

/** Drawer tab keys. */
type DrawerTab = 'segments' | 'lesions' | 'measurements' | 'notes';

const DEFAULT_DRAWER_WIDTH = 320;
const MIN_DRAWER_WIDTH = 220;
const MAX_DRAWER_WIDTH = 560;

/**
 * The actual detail view (unwrapped).
 */
function AnalysisDetailViewInner({
  initialAnalysis,
  apiBaseUrl = '/api/v1',
}: AnalysisDetailViewProps): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 767px)');

  const { data: analysis, loading, error } = useAnalysisStub(id, apiBaseUrl, initialAnalysis);

  // Document title — keep the analysis study UID visible in the browser tab.
  useEffect(() => {
    const base = t('analysis:detail.crumbs.cases') ?? 'Analysis';
    const studyShort = analysis?.studyUidShort ?? id ?? '';
    document.title = studyShort
      ? `${base}: ${studyShort} · LiverRa`
      : `${base} · LiverRa`;
  }, [analysis?.studyUidShort, id, t]);

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

  const analysisReady = analysis?.status === 'done';

  const breadcrumbs = useMemo(
    () => [
      { label: t('analysis:detail.crumbs.cases'), href: '/emr/cases' },
      { label: analysis?.studyUidShort ?? id ?? '—' },
    ],
    [analysis?.studyUidShort, id, t],
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

  if (loading || !analysis) {
    return (
      <Stack p="lg" gap="md">
        <EMRSkeleton height={40} width="40%" />
        <EMRSkeleton height={480} />
      </Stack>
    );
  }

  return (
    <Box
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
          title={t('analysis:detail.title', { studyUid: analysis.studyUidShort })}
          subtitle={analysis.patientReference}
          actions={
            <Group wrap="wrap" gap="xs">
              <EMRButton
                variant="ghost"
                icon={IconArrowLeft}
                onClick={() => navigate('/emr/cases')}
              >
                {t('analysis:detail.back')}
              </EMRButton>
              {analysis.reportUrl && (
                <EMRButton
                  variant="primary"
                  icon={IconDownload}
                  onClick={() => window.open(analysis.reportUrl, '_blank', 'noopener')}
                >
                  {t('analysis:detail.downloadReport')}
                </EMRButton>
              )}
            </Group>
          }
        />
      </Box>

      {/* Cold-start banner (auto-hides when predicted_warm_s === 0) */}
      {id && <ColdStartIndicator analysisId={id} status={analysis.status} />}

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
          <Tabs
            value={drawerTab}
            onChange={(v) => v && setDrawerTab(v as DrawerTab)}
            variant="pills"
            radius="md"
            styles={{
              list: {
                padding: 8,
                background: 'var(--emr-gray-50)',
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
              <Tabs.Tab value="segments" leftSection={<IconLayoutDashboard size={14} />}>
                {t('analysis:detail.tabs.segments')}
              </Tabs.Tab>
              <Tabs.Tab value="lesions" leftSection={<IconTarget size={14} />}>
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
                <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
                  {t('analysis:detail.drawer.segmentsPlaceholder')}
                </Text>
              </Tabs.Panel>
              <Tabs.Panel value="lesions">
                <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
                  {t('analysis:detail.drawer.lesionsPlaceholder')}
                </Text>
              </Tabs.Panel>
              <Tabs.Panel value="measurements">
                <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
                  {t('analysis:detail.drawer.measurementsPlaceholder')}
                </Text>
              </Tabs.Panel>
              <Tabs.Panel value="notes">
                <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
                  {t('analysis:detail.drawer.notesPlaceholder')}
                </Text>
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

        {/* Centre: viewer */}
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
            minHeight: isMobile ? 360 : 480,
          }}
        >
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
              <LiverViewer3D analysisId={analysis.id} ready={analysisReady} />
            </Suspense>
          </LiverErrorBoundary>
        </Box>

        {/* Right: FLR panel */}
        <Box
          style={{
            width: isMobile ? '100%' : 320,
            flexShrink: 0,
            borderRadius: 'var(--emr-border-radius-lg)',
            overflow: 'hidden',
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-gray-200)',
          }}
        >
          <LiverErrorBoundary>
            <Suspense
              fallback={
                <Stack p="md" gap="sm">
                  <EMRSkeleton height={24} width="50%" />
                  <EMRSkeleton height={120} />
                </Stack>
              }
            >
              <FLRPanel analysisId={analysis.id} initialFlrPct={analysis.flrPct} />
            </Suspense>
          </LiverErrorBoundary>
        </Box>
      </Box>

      {/* Bottom strip — placeholder until US2 MultiPlanarViews lands */}
      <Box
        style={{
          margin: isMobile ? 8 : 16,
          marginTop: 0,
          padding: 12,
          borderRadius: 'var(--emr-border-radius-lg)',
          background: 'var(--emr-gray-50)',
          border: '1px dashed var(--emr-gray-300)',
        }}
        aria-label={t('analysis:detail.mprAria')}
      >
        <Group gap="xs" wrap="wrap">
          <IconActivity
            size={16}
            style={{ color: 'var(--emr-text-tertiary)', flexShrink: 0 }}
          />
          <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)">
            {t('analysis:detail.mprPlaceholder')}
          </Text>
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
