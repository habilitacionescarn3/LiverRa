// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AnalysisDetailView — viewer-as-hero workspace.
 *
 * Plain-English: this is the "open a case" page. The DICOM viewer is the
 * star — left rail (Segments / Lesions / Measurements / Notes) and right
 * rail (Future Liver Remnant) are wingmen that can each be collapsed to
 * give the viewer more room. Press F (or click the focus button) to enter
 * theater mode, which hides both rails entirely.
 *
 * Layout-only refactor — business logic (useAnalysis, useAnalysisResults,
 * the cascade timeline, viewer pipeline) is unchanged.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconActivity,
  IconArrowLeft,
  IconChevronLeft,
  IconChevronRight,
  IconClipboardList,
  IconDownload,
  IconLayoutDashboard,
  IconMaximize,
  IconMinimize,
  IconNotes,
  IconRuler,
  IconStethoscope,
  IconTarget,
} from '@tabler/icons-react';
import {
  EMRAlert,
  EMRBadge,
  EMRBottomSheet,
  EMRButton,
  EMREmptyState,
  EMRErrorBoundary,
  EMRIconButton,
  EMRSkeleton,
  EMRTabs,
  EMRToast,
  emrTabPanelProps,
} from '../../components/common';
import type { EMRBadgeVariant } from '../../components/common';
import { PermissionButton } from '../../components/access-control/PermissionButton';
import { useTranslation } from '../../contexts/TranslationContext';
import { ColdStartIndicator } from '../../components/liver/ColdStartIndicator';
import { RUODisclaimer } from '../../components/ruo/RUODisclaimer';
import { useAnalysis } from '../../hooks/useAnalysis';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useReviewSeat } from '../../hooks/useReviewSeat';
import { useFinalize } from '../../hooks/useFinalize';
import { useAuth } from '../../services/auth';
import { buildPath, LIVERRA_ROUTES } from '../../constants/routes';
import { CascadeStageTimeline } from '../../components/cases/CascadeStageTimeline';
import { SegmentsList } from '../../components/cases/SegmentsList';
import styles from './AnalysisDetailView.module.css';

/** `LiverErrorBoundary` — LiverRa rename of MediMind's `PACSErrorBoundary`. */
const LiverErrorBoundary = EMRErrorBoundary;

// ── Lazy chunks ───────────────────────────────────────────────────────────
const LiverViewer3D = lazy(() => import('../../components/liver/LiverViewer3D'));
const FLRPanel = lazy(() => import('../../components/liver/FLRPanel'));

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
  flr_default?: { remnant_pct_functional?: string | number | null } | null;
  stage_progress?: Array<{
    stage_no: number;
    stage: string;
    output_uri: string | null;
    written_at: string;
    model_version: string | null;
    model_license_hash: string | null;
  }>;
}

export interface AnalysisDetailViewProps {
  initialAnalysis?: BackendAnalysis;
  apiBaseUrl?: string;
}

function readApiBaseUrl(fallback: string): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? fallback).replace(/\/$/, '');
}

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

function useAnalysisResults(
  analysisId: string | null | undefined,
  apiBaseUrl: string,
  status?: string,
) {
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
    refetchInterval: status === 'running' || status === 'queued' ? 3_000 : false,
  });
}

/** Drawer tab keys. */
type DrawerTab = 'segments' | 'lesions' | 'measurements' | 'notes';

/** Lesions tab content. Logic unchanged from the previous version. */
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

  if (isLoading) return <p className={styles.helperText}>Loading lesions…</p>;
  if (error)
    return (
      <p className={`${styles.helperText} ${styles.helperError}`}>
        {error.message}
      </p>
    );
  if (lesions.length === 0)
    return (
      <p className={styles.helperText} data-testid="lesions-empty">
        No lesions detected.
      </p>
    );

  return (
    <div className={styles.stack} data-testid="lesions-list">
      <p className={styles.lesionsCount} data-testid="lesions-count">
        {lesions.length} lesion{lesions.length === 1 ? '' : 's'}
      </p>
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
          <div
            key={les.id}
            data-testid={`lesion-row-${les.id}`}
            className={styles.lesionRow}
          >
            <span className={styles.lesionRowTitle}>
              {label.toUpperCase()}
              {confidence ? ` · ${confidence}` : ''}
            </span>
            <span className={styles.lesionRowMeta}>
              Segment {les.couinaud_location ?? '—'} · {diameter}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Local helpers ────────────────────────────────────────────────────────

const RAIL_STORAGE_KEYS = {
  left: 'liverra.case.rail.left.collapsed',
  right: 'liverra.case.rail.right.collapsed',
} as const;

function readBoolFromStorage(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeBoolToStorage(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* storage may be blocked (private mode) — silently ignore */
  }
}

function statusVariant(status: BackendAnalysis['status']): EMRBadgeVariant {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'running':
    case 'partial':
      return 'info';
    default:
      return 'neutral';
  }
}

// ── View ─────────────────────────────────────────────────────────────────

function AnalysisDetailViewInner({
  initialAnalysis,
  apiBaseUrl,
}: AnalysisDetailViewProps): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const isTablet = useMediaQuery('(max-width: 1199px)');
  const baseUrl = readApiBaseUrl(apiBaseUrl ?? '/api/v1');

  const { analysis: liveAnalysis, isLoading, error } = useAnalysis(id);
  const { data: results } = useAnalysisResults(id, baseUrl, liveAnalysis?.status);

  const analysis = (initialAnalysis ?? (liveAnalysis as unknown as BackendAnalysis | undefined)) as
    | BackendAnalysis
    | undefined;

  const studyUidShort = useMemo<string>(() => {
    if (!analysis) return (id ?? '').slice(0, 8);
    const uid = analysis.study_instance_uid;
    if (uid && uid.length > 0) {
      return uid.length > 24 ? `…${uid.slice(-12)}` : uid;
    }
    return analysis.study_id ? analysis.study_id.slice(0, 8) : (id ?? '').slice(0, 8);
  }, [analysis, id]);

  const patientReference = analysis?.patient_ref ?? undefined;

  const flrPct = useMemo<number | undefined>(() => {
    const raw = results?.flr_default?.remnant_pct_functional ?? null;
    if (raw === null || raw === undefined) return undefined;
    const n = typeof raw === 'string' ? Number.parseFloat(raw) : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }, [results]);

  const segmentsCount = results?.segmentations?.length ?? 0;
  const lesionsCount = results?.lesions?.length ?? 0;

  // Liver volume metric (from parenchyma segmentation if present).
  const liverVolumeMl = useMemo<string | undefined>(() => {
    const liver = results?.segmentations?.find((s) => s.anatomy_category === 'liver');
    const v = liver?.volume_ml;
    if (v === null || v === undefined) return undefined;
    const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.round(n).toLocaleString();
  }, [results]);

  const lastUpdatedIso =
    analysis?.completed_at ?? analysis?.started_at ?? analysis?.queued_at ?? null;

  useEffect(() => {
    const base = t('analysis:detail.crumbs.cases') ?? 'Analysis';
    const studyShort = studyUidShort || id || '';
    document.title = studyShort ? `${base}: ${studyShort} · LiverRa` : `${base} · LiverRa`;
  }, [studyUidShort, id, t]);

  // Rail collapse state — persisted per-rail in localStorage.
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(() =>
    readBoolFromStorage(RAIL_STORAGE_KEYS.left),
  );
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(() =>
    readBoolFromStorage(RAIL_STORAGE_KEYS.right),
  );
  useEffect(() => {
    writeBoolToStorage(RAIL_STORAGE_KEYS.left, leftCollapsed);
  }, [leftCollapsed]);
  useEffect(() => {
    writeBoolToStorage(RAIL_STORAGE_KEYS.right, rightCollapsed);
  }, [rightCollapsed]);

  // Theater mode (F to toggle, Esc to exit).
  const [theater, setTheater] = useState<boolean>(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Don't hijack the key when the user is typing.
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(input|textarea|select)$/i.test(tgt.tagName)) return;
      if (tgt?.isContentEditable) return;
      if (e.key === 'f' || e.key === 'F') {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        setTheater((t) => !t);
        e.preventDefault();
      } else if (e.key === 'Escape' && theater) {
        setTheater(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [theater]);

  // Mobile bottom-sheets for the workspace + FLR rails.
  const [mobileSheet, setMobileSheet] = useState<'workspace' | 'flr' | null>(null);

  // Drawer tab state.
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('segments');

  // Mirror theater state to a body class so we can hide chrome elements
  // rendered outside our tree (the fixed-position RUODisclaimer, the
  // cascade timeline that lives on its own row, etc.).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const cls = 'is-theater-mode';
    if (theater) document.body.classList.add(cls);
    else document.body.classList.remove(cls);
    return () => document.body.classList.remove(cls);
  }, [theater]);

  const analysisReady = analysis?.status === 'completed';

  // One-click finalize: acquire review seat → POST finalize → land on report.
  // Replaces the former 5-step wizard at /cases/:id/finalize.
  const seat = useReviewSeat();
  const { tenant } = useAuth();
  const finalize = useFinalize();
  const [finalizing, setFinalizing] = useState(false);
  const queryClient = useQueryClient();

  // Warm the report-render S3 cache while the user is still on this page.
  // First render per (analysis, stage) is the slow one (~2s of matplotlib);
  // the API caches the PNG to MinIO so every subsequent fetch is <50 ms.
  // Firing these in the background here means by the time the user clicks
  // Finalize and navigates to /reports/:id, the stage PNGs are already in
  // S3 and the inline report lands fully-loaded.
  useEffect(() => {
    if (!analysisReady || !analysis?.id) return;
    const aid = analysis.id;
    const stages = ['parenchyma', 'vessels', 'flr', 'four-phase', 'mesh3d'] as const;
    stages.forEach((stage) => {
      fetch(
        `${baseUrl}/analyses/${encodeURIComponent(aid)}/report/render/${stage}`,
        { credentials: 'include' },
      ).catch(() => undefined);
    });
    void queryClient.prefetchQuery({
      queryKey: ['report-summary', aid],
      queryFn: async () => {
        const r = await fetch(
          `${baseUrl}/analyses/${encodeURIComponent(aid)}/report/summary`,
          { credentials: 'include' },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      },
      staleTime: 60_000,
    });
  }, [analysisReady, analysis?.id, baseUrl, queryClient]);

  const handleFinalize = useCallback(async (): Promise<void> => {
    if (!analysis) return;
    setFinalizing(true);
    try {
      const reviewId =
        seat.hasSeat && seat.reviewId
          ? seat.reviewId
          : (await seat.acquire(analysis.id)).reviewId;
      const res = await finalize.mutateAsync({
        reviewId,
        analysisId: analysis.id,
        tenantId: tenant?.id,
      });
      navigate(buildPath(LIVERRA_ROUTES.REPORT_VIEW, { id: res.report_id }));
    } catch (err) {
      const e = err as Error & { slug?: string };
      const slug = e.slug ?? 'generic';
      const translated = t(`errors:finalize.${slug}`);
      const message =
        translated && !translated.startsWith('errors:finalize.')
          ? translated
          : e.message || t('errors:finalize.generic');
      EMRToast.error(message);
    } finally {
      setFinalizing(false);
    }
  }, [analysis, seat, finalize, tenant?.id, t, navigate]);

  const tabItems = useMemo(
    () => [
      {
        value: 'segments' as const,
        label: t('analysis:detail.tabs.segments'),
        icon: IconLayoutDashboard,
        right:
          segmentsCount > 0 ? (
            <EMRBadge size="sm" variant="neutral" data-testid="drawer-tab-segments-count">
              {segmentsCount}
            </EMRBadge>
          ) : undefined,
      },
      {
        value: 'lesions' as const,
        label: t('analysis:detail.tabs.lesions'),
        icon: IconTarget,
        right:
          lesionsCount > 0 ? (
            <EMRBadge size="sm" variant="primary" data-testid="drawer-tab-lesions-count">
              {lesionsCount}
            </EMRBadge>
          ) : undefined,
      },
      {
        value: 'measurements' as const,
        label: t('analysis:detail.tabs.measurements'),
        icon: IconRuler,
      },
      {
        value: 'notes' as const,
        label: t('analysis:detail.tabs.notes'),
        icon: IconNotes,
      },
    ],
    [segmentsCount, lesionsCount, t],
  );

  if (error) {
    return (
      <div style={{ padding: 20 }}>
        <EMRAlert variant="error" title={t('analysis:detail.error.title')} withCloseButton={false}>
          {error.message}
        </EMRAlert>
      </div>
    );
  }

  if (isLoading || !analysis) {
    return (
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <EMRSkeleton height={40} width="40%" />
        <EMRSkeleton height={480} />
      </div>
    );
  }

  // ── Reusable fragments ──────────────────────────────────────────────

  const renderTabPanel = (): React.ReactNode => {
    switch (drawerTab) {
      case 'segments':
        return <SegmentsList analysisId={analysis.id} apiBaseUrl={baseUrl} />;
      case 'lesions':
        return <LesionsTabContent analysisId={analysis.id} apiBaseUrl={baseUrl} />;
      case 'measurements':
        return (
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
        );
      case 'notes':
        return (
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
        );
    }
  };

  const workspaceRail = (
    <aside
      className={`${styles.rail} ${leftCollapsed && !isMobile ? styles.railCollapsed : ''}`}
      aria-label={t('analysis:detail.drawerAria')}
    >
      <div className={styles.railHeader}>
        {!leftCollapsed && (
          <>
            <span className={styles.railHeaderIcon} aria-hidden="true">
              <IconClipboardList size={16} stroke={2} />
            </span>
            <div className={styles.railHeaderText}>
              <p className={styles.railHeaderTitle}>{t('analysis:detail.workspace.title')}</p>
              <p className={styles.railHeaderSubtitle}>
                {t('analysis:detail.workspace.subtitle')}
              </p>
            </div>
          </>
        )}
        {!isMobile && !isTablet && (
          <div className={styles.railToggle}>
            <EMRIconButton
              size="sm"
              icon={leftCollapsed ? IconChevronRight : IconChevronLeft}
              aria-label={
                leftCollapsed
                  ? t('analysis:detail.rails.expandLeft')
                  : t('analysis:detail.rails.collapseLeft')
              }
              onClick={() => setLeftCollapsed((v) => !v)}
              data-testid="rail-left-toggle"
            />
          </div>
        )}
      </div>

      {/* Collapsed icon strip — quick re-expand by clicking any tab icon. */}
      {leftCollapsed && (
        <div className={styles.railCollapsedIcons}>
          {tabItems.map((it) => (
            <EMRIconButton
              key={it.value}
              size="sm"
              icon={it.icon!}
              aria-label={typeof it.label === 'string' ? it.label : it.value}
              onClick={() => {
                setLeftCollapsed(false);
                setDrawerTab(it.value);
              }}
              data-testid={`rail-left-icon-${it.value}`}
            />
          ))}
        </div>
      )}

      {!leftCollapsed && (
        <>
          {/* Pipeline activity block — surfaces the cascade timeline
              inside the workspace rail when the analysis has settled
              (completed / failed). Keeps it visible to the radiologist
              without consuming horizontal viewport above the viewer. */}
          {(analysis.status === 'completed' || analysis.status === 'failed') && (
            <div className={styles.railStatusBlock}>
              <CascadeStageTimeline
                analysisId={analysis.id}
                stageProgress={analysis.stage_progress}
                apiBaseUrl={baseUrl}
                analysisStatus={analysis.status}
              />
            </div>
          )}
          <div className={styles.railTabs}>
            <EMRTabs
              value={drawerTab}
              onChange={(v) => setDrawerTab(v as DrawerTab)}
              items={tabItems}
              variant="pills"
              aria-label={t('analysis:detail.drawerAria')}
            />
          </div>
          <div className={styles.railBody} {...emrTabPanelProps('case-drawer', drawerTab)}>
            {renderTabPanel()}
          </div>
        </>
      )}
    </aside>
  );

  const flrRail = (
    <aside
      className={`${styles.railRight} ${rightCollapsed && !isMobile ? styles.railCollapsed : ''}`}
      aria-label={t('analysis:flr.title')}
    >
      <div className={styles.railHeader}>
        {!rightCollapsed && (
          <>
            <span className={styles.railHeaderIcon} aria-hidden="true">
              <IconActivity size={16} stroke={2} />
            </span>
            <div className={styles.railHeaderText}>
              <p className={styles.railHeaderTitle}>{t('analysis:flr.title')}</p>
              <p className={styles.railHeaderSubtitle}>{t('analysis:detail.flr.subtitle')}</p>
            </div>
          </>
        )}
        {!isMobile && !isTablet && (
          <div className={styles.railToggle}>
            <EMRIconButton
              size="sm"
              icon={rightCollapsed ? IconChevronLeft : IconChevronRight}
              aria-label={
                rightCollapsed
                  ? t('analysis:detail.rails.expandRight')
                  : t('analysis:detail.rails.collapseRight')
              }
              onClick={() => setRightCollapsed((v) => !v)}
              data-testid="rail-right-toggle"
            />
          </div>
        )}
      </div>
      {rightCollapsed ? (
        <div className={styles.railCollapsedIcons}>
          <EMRIconButton
            size="sm"
            icon={IconActivity}
            aria-label={t('analysis:detail.rails.expandRight')}
            onClick={() => setRightCollapsed(false)}
            data-testid="rail-right-icon"
          />
        </div>
      ) : (
        <div className={styles.flrBody}>
          <LiverErrorBoundary>
            <Suspense
              fallback={
                <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <EMRSkeleton height={24} width="50%" />
                  <EMRSkeleton height={120} />
                </div>
              }
            >
              <FLRPanel analysisId={analysis.id} initialFlrPct={flrPct} />
            </Suspense>
          </LiverErrorBoundary>
        </div>
      )}
    </aside>
  );

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div
      data-testid="analysis-detail-root"
      data-analysis-id={analysis.id}
      data-analysis-status={analysis.status}
      className={styles.root}
    >
      {/* Compact hero header — single row, ~52px tall. */}
      <header className={styles.hero}>
        <div className={styles.heroBack}>
          <EMRIconButton
            size="sm"
            icon={IconArrowLeft}
            aria-label={t('analysis:detail.back')}
            onClick={() => navigate('/cases')}
            data-testid="hero-back-btn"
          />
        </div>
        <span className={styles.heroIcon} aria-hidden="true">
          <IconStethoscope size={18} stroke={1.8} />
        </span>
        <div className={styles.heroTitleBlock}>
          <h1 className={styles.heroTitle} data-testid="emr-page-header-title">
            {t('analysis:detail.title', { studyUid: studyUidShort })}
          </h1>
          <EMRBadge variant={statusVariant(analysis.status)} size="sm">
            {t(`analysis:status.${analysis.status}`) || analysis.status}
          </EMRBadge>
          {patientReference && (
            <span className={styles.heroPatientRef} title={patientReference}>
              {patientReference}
            </span>
          )}
        </div>

        {/* Inline metric pills — same row as title. */}
        <div className={styles.metrics} aria-label="Case metrics">
          {liverVolumeMl !== undefined && (
            <span className={styles.metric} data-testid="metric-liver-volume">
              <span className={styles.metricLabel}>{t('analysis:detail.metrics.liverVolume')}</span>
              <span className={styles.metricValue}>
                {liverVolumeMl}
                {t('analysis:detail.metrics.volumeUnit')}
              </span>
            </span>
          )}
          {lesionsCount > 0 && (
            <span className={styles.metric} data-testid="metric-lesions">
              <span className={styles.metricLabel}>{t('analysis:detail.metrics.lesions')}</span>
              <span className={styles.metricValue}>{lesionsCount}</span>
            </span>
          )}
          {flrPct !== undefined && (
            <span className={styles.metric} data-testid="metric-flr">
              <span className={styles.metricLabel}>{t('analysis:detail.metrics.flr')}</span>
              <span className={styles.metricValue}>
                {flrPct.toFixed(1)}
                {t('analysis:detail.metrics.flrUnit')}
              </span>
            </span>
          )}
        </div>

        <div className={styles.heroActions}>
          {analysisReady && (
            <PermissionButton
              permission="report.finalize"
              hiddenIfDenied
              variant="primary"
              size="sm"
              icon={IconDownload}
              loading={finalizing}
              onClick={() => void handleFinalize()}
              data-testid="analysis-finalize-btn"
            >
              {t('analysis:detail.openFinalize')}
            </PermissionButton>
          )}
        </div>
      </header>

      {/* Cold-start banner (auto-hides when warm) — wrapped so theater
          mode can hide it via the `data-testid` attribute. */}
      {id && (
        <div data-testid="cold-start-indicator">
          <ColdStartIndicator analysisId={id} status={analysis.status} />
        </div>
      )}

      {/* Cascade stage timeline — only shown above the viewer while the
          pipeline is actively progressing. Once status is `completed` or
          `failed`, the timeline lives inside the workspace rail to free
          up vertical real estate for the viewer. */}
      {analysis.status !== 'completed' && analysis.status !== 'failed' && (
        <CascadeStageTimeline
          analysisId={analysis.id}
          stageProgress={analysis.stage_progress}
          apiBaseUrl={baseUrl}
          analysisStatus={analysis.status}
        />
      )}

      {/* Mobile sheet triggers (only visible <768px). */}
      <div className={styles.mobileSheetTriggers}>
        <EMRButton
          variant="secondary"
          icon={IconClipboardList}
          onClick={() => setMobileSheet('workspace')}
        >
          {t('analysis:detail.workspace.title')}
        </EMRButton>
        <EMRButton
          variant="secondary"
          icon={IconActivity}
          onClick={() => setMobileSheet('flr')}
        >
          {t('analysis:flr.title')}
        </EMRButton>
      </div>

      {/* 3-zone workspace */}
      <main
        className={[
          styles.workspace,
          theater ? styles.workspaceTheater : null,
          leftCollapsed && !theater ? styles.workspaceLeftCollapsed : null,
          rightCollapsed && !theater ? styles.workspaceRightCollapsed : null,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/* Left rail */}
        {!isMobile && workspaceRail}

        {/* Centre: viewer (the hero) */}
        <section
          className={styles.viewerCard}
          aria-label={t('analysis:viewer.ariaLabel')}
        >
          <div className={styles.viewerToolbar}>
            <div className={styles.viewerToolbarLeft}>
              <span className={styles.viewerStudyLabel} data-testid="viewer-card-study-label">
                {t('analysis:detail.viewerCard.studyLabel', { uid: studyUidShort })}
              </span>
              <EMRBadge variant={statusVariant(analysis.status)} size="sm">
                {t(`analysis:status.${analysis.status}`) || analysis.status}
              </EMRBadge>
              <span className={styles.viewerLastUpdated}>
                {t('analysis:detail.viewerCard.lastUpdated', {
                  when: relativeFromIso(lastUpdatedIso),
                })}
              </span>
            </div>
            <div className={styles.viewerToolbarRight}>
              <EMRBadge variant="solidWarning" size="sm">
                {t('analysis:detail.ruoBadge')}
              </EMRBadge>
              {theater && (
                <span className={styles.viewerKbdHint} aria-hidden="true">
                  ESC
                </span>
              )}
              <EMRIconButton
                variant="solid"
                icon={theater ? IconMinimize : IconMaximize}
                aria-label={
                  theater
                    ? t('analysis:detail.theater.exit')
                    : t('analysis:detail.theater.enter')
                }
                active={theater}
                onClick={() => setTheater((v) => !v)}
                data-testid="viewer-theater-toggle"
              />
            </div>
          </div>

          <div className={styles.viewerCanvas}>
            <LiverErrorBoundary>
              <Suspense
                fallback={
                  <div className={styles.viewerLoading}>
                    <EMRSkeleton height={48} width="60%" />
                    <EMRSkeleton height={240} />
                    <span style={{ fontSize: 'var(--emr-font-xs)' }}>
                      {t('analysis:detail.viewer.loading')}
                    </span>
                  </div>
                }
              >
                <LiverViewer3D
                  analysisId={analysis.id}
                  ready={analysisReady}
                  studyInstanceUid={analysis.study_instance_uid}
                  parenchymaMaskUri={
                    results?.segmentations?.find((s) => s.anatomy_category === 'liver')?.mask_url ??
                    undefined
                  }
                  segmentations={results?.segmentations ?? []}
                  lesionCount={results?.lesions?.length ?? 0}
                  lesions={results?.lesions ?? []}
                  flrDefault={results?.flr_default ?? null}
                />
              </Suspense>
            </LiverErrorBoundary>
          </div>
        </section>

        {/* Right rail */}
        {!isMobile && !isTablet && flrRail}
      </main>

      {/* Bottom status / RUO footer */}
      <div className={styles.footer} aria-label={t('analysis:detail.mprAria')}>
        <div className={styles.footerLeft}>
          <IconActivity size={14} stroke={2} />
          <span>{t('analysis:detail.mprPlaceholder')}</span>
        </div>
        <EMRBadge variant="warning" size="md">
          {t('analysis:detail.ruoBadge')}
        </EMRBadge>
      </div>

      {/* RUO disclaimer (always rendered while AI output is on screen) */}
      <RUODisclaimer />

      {/* Mobile bottom sheets */}
      {isMobile && (
        <>
          <EMRBottomSheet
            opened={mobileSheet === 'workspace'}
            onClose={() => setMobileSheet(null)}
            title={t('analysis:detail.workspace.title')}
            snapPoint="half"
          >
            <div className={styles.sheetBody}>
              <EMRTabs
                value={drawerTab}
                onChange={(v) => setDrawerTab(v as DrawerTab)}
                items={tabItems}
                variant="pills"
                grow
                aria-label={t('analysis:detail.drawerAria')}
              />
              <div {...emrTabPanelProps('case-drawer-mobile', drawerTab)}>{renderTabPanel()}</div>
            </div>
          </EMRBottomSheet>

          <EMRBottomSheet
            opened={mobileSheet === 'flr'}
            onClose={() => setMobileSheet(null)}
            title={t('analysis:flr.title')}
            snapPoint="half"
          >
            <div className={styles.sheetBody}>
              <LiverErrorBoundary>
                <Suspense
                  fallback={
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <EMRSkeleton height={24} width="50%" />
                      <EMRSkeleton height={120} />
                    </div>
                  }
                >
                  <FLRPanel analysisId={analysis.id} initialFlrPct={flrPct} />
                </Suspense>
              </LiverErrorBoundary>
            </div>
          </EMRBottomSheet>
        </>
      )}
    </div>
  );
}

export default function AnalysisDetailView(
  props: AnalysisDetailViewProps,
): React.ReactElement {
  return (
    <LiverErrorBoundary>
      <AnalysisDetailViewInner {...props} />
    </LiverErrorBoundary>
  );
}
