// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LesionList (T217).
 *
 * Plain-English: a sortable, filterable table of every lesion the AI (or a
 * reviewer) found in this liver. Click any row → the 3D viewer + all slice
 * views recentre on that lesion AND the right-hand detail drawer slides
 * open showing the full lesion card. Beyond 50 rows the list switches to
 * a virtualised scroller (only renders the ~10 rows visible to the user)
 * so the page stays fast per NFR-001. Below a 768 px viewport the grid
 * collapses into stacked cards so it stays usable on a phone.
 *
 * Accessibility (NFR-002):
 *   - `role="grid"` on the container, `role="row"` + `role="gridcell"` on
 *     every descendant — screen readers present it as a spreadsheet the
 *     user can arrow through.
 *   - Each row's `aria-label` reads the full lesion description:
 *     "Lesion 3 of 12, Segment IV, 14 mm, HCC suggested, 82% confidence".
 *   - The abstention ("Uncertain") state is tagged via the LesionBadge
 *     child so screen readers still hear FR-011 guidance.
 *
 * Performance: uses `@tanstack/react-virtual` for row virtualisation
 * (only kicks in above 50 rows per NFR-001). On mobile the virtualiser
 * disables itself since the page scrolls naturally.
 *
 * URL state: `confidence`, `class`, `segment`, `size` filters are kept
 * in the query string so deep links ("share this filtered list with me")
 * survive a reload.
 *
 * Spec refs: FR-010, FR-011, FR-020, NFR-001, NFR-002.
 */

import { Box, Group, Text } from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAccessibility } from '../../contexts/AccessibilityContext';
import { useViewerState, type ViewerCamera } from '../../contexts/ViewerStateContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { EMRButton, EMREmptyState, EMRTableSkeleton } from '../common';
import { EMRSelect } from '../shared/EMRFormFields';

import { LesionBadge } from './LesionBadge';
import styles from './LesionList.module.css';
// SVG asset URL (Vite ?url import) — served as a hashed static asset.
import noLesionsIllustrationUrl from '../../assets/empty-states/no-lesions.svg?url';
import type { BBox3D, CouinaudSegment, LesionClass, LesionUI } from './types';
import { LESION_CLASS_ORDER } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VIRTUALIZE_THRESHOLD = 50;
const MOBILE_BREAKPOINT_PX = 768;
const ROW_HEIGHT_PX = 72;

export type SizeBucket = 'all' | 'sm' | 'md' | 'lg';

export interface LesionListFilters {
  minConfidence: number; // 0..1
  classValue: LesionClass | 'all';
  segment: CouinaudSegment | 'all';
  sizeBucket: SizeBucket;
}

export interface LesionListProps {
  lesions: LesionUI[];
  isLoading?: boolean;
  /** Currently selected lesion id — row is highlighted. */
  selectedId?: string | null;
  /** Called when a row is clicked or Enter/Space pressed. */
  onSelect?: (lesion: LesionUI) => void;
  /** Persist filters to the URL query string. Defaults to `true`. */
  persistFiltersToUrl?: boolean;
  /** Test hook. */
  'data-testid'?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the 3D centroid of a bbox + a camera distance heuristic based on
 * the diagonal length. We aim the camera at the centroid from a z-offset
 * roughly 2.5× the bbox diagonal — close enough to frame the lesion with
 * a little context margin.
 */
function cameraForBbox(bbox: BBox3D): ViewerCamera {
  const [x0, y0, z0, x1, y1, z1] = bbox;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const diag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 50;
  const offset = Math.max(80, diag * 2.5);
  return {
    position: [cx, cy, cz + offset],
    target: [cx, cy, cz],
    up: [0, -1, 0],
    zoom: 1,
  };
}

function bucketForSize(diameterMm: number): Exclude<SizeBucket, 'all'> {
  if (diameterMm < 10) return 'sm';
  if (diameterMm <= 30) return 'md';
  return 'lg';
}

function readFiltersFromURL(): Partial<LesionListFilters> {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const out: Partial<LesionListFilters> = {};
  const conf = params.get('confidence');
  if (conf !== null && !Number.isNaN(Number(conf))) {
    out.minConfidence = Math.max(0, Math.min(1, Number(conf)));
  }
  const cls = params.get('class');
  if (cls) out.classValue = cls as LesionClass | 'all';
  const seg = params.get('segment');
  if (seg) out.segment = seg as CouinaudSegment | 'all';
  const size = params.get('size');
  if (size === 'sm' || size === 'md' || size === 'lg' || size === 'all') {
    out.sizeBucket = size;
  }
  return out;
}

function writeFiltersToURL(filters: LesionListFilters): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (filters.minConfidence > 0) params.set('confidence', filters.minConfidence.toFixed(2));
  else params.delete('confidence');
  if (filters.classValue !== 'all') params.set('class', filters.classValue);
  else params.delete('class');
  if (filters.segment !== 'all') params.set('segment', filters.segment);
  else params.delete('segment');
  if (filters.sizeBucket !== 'all') params.set('size', filters.sizeBucket);
  else params.delete('size');
  const qs = params.toString();
  const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, '', next);
}

const DEFAULT_FILTERS: LesionListFilters = {
  minConfidence: 0,
  classValue: 'all',
  segment: 'all',
  sizeBucket: 'all',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LesionList({
  lesions,
  isLoading = false,
  selectedId,
  onSelect,
  persistFiltersToUrl = true,
  'data-testid': testId = 'lesion-list',
}: LesionListProps): JSX.Element {
  const { t } = useTranslation();
  const { announceToSR } = useAccessibility();
  const { setCamera } = useViewerState();

  // ── Filters (URL-persisted) ──
  const [filters, setFilters] = useState<LesionListFilters>(() => ({
    ...DEFAULT_FILTERS,
    ...readFiltersFromURL(),
  }));

  useEffect(() => {
    if (persistFiltersToUrl) writeFiltersToURL(filters);
  }, [filters, persistFiltersToUrl]);

  const updateFilter = useCallback(<K extends keyof LesionListFilters>(
    key: K,
    value: LesionListFilters[K],
  ) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => setFilters(DEFAULT_FILTERS), []);

  // ── Filtering ──
  const filtered = useMemo(() => {
    return lesions.filter((l) => {
      if (
        filters.minConfidence > 0 &&
        (l.confidence === null || l.confidence < filters.minConfidence)
      ) {
        return false;
      }
      if (filters.classValue !== 'all' && l.suggestedClass !== filters.classValue) {
        return false;
      }
      if (filters.segment !== 'all' && l.couinaudLocation !== filters.segment) {
        return false;
      }
      if (filters.sizeBucket !== 'all' && bucketForSize(l.longestDiameterMm) !== filters.sizeBucket) {
        return false;
      }
      return true;
    });
  }, [lesions, filters]);

  // Announce result counts so SR users hear filter effects.
  const resultCountLabel = t('lesions:list.filters.resultCount', {
    count: filtered.length,
    total: lesions.length,
  });
  useEffect(() => {
    if (!isLoading) announceToSR(resultCountLabel, 'polite');
  }, [resultCountLabel, isLoading, announceToSR]);

  // ── Mobile detection (card layout below 768 px) ──
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
    const handler = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // ── Virtualizer ──
  const viewportRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = !isMobile && filtered.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 6,
    enabled: shouldVirtualize,
  });

  // ── Row interaction ──
  const handleSelect = useCallback(
    (lesion: LesionUI) => {
      setCamera(cameraForBbox(lesion.bbox3d));
      onSelect?.(lesion);
    },
    [setCamera, onSelect],
  );

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, lesion: LesionUI) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelect(lesion);
      }
    },
    [handleSelect],
  );

  // ── Filter option lists ──
  const classOptions = useMemo(
    () => [
      { value: 'all', label: t('lesions:list.filters.classAll') },
      ...LESION_CLASS_ORDER.map((c) => ({
        value: c,
        label: t(`lesions:classes.${c}.long`),
      })),
    ],
    [t],
  );

  const segmentOptions = useMemo(
    () => [
      { value: 'all', label: t('lesions:list.filters.segmentAll') },
      ...(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] as CouinaudSegment[]).map((s) => ({
        value: s,
        label: `Segment ${s}`,
      })),
    ],
    [t],
  );

  const sizeOptions = useMemo(
    () => [
      { value: 'all', label: t('lesions:list.filters.sizeAll') },
      { value: 'sm', label: t('lesions:list.filters.sizeSmall') },
      { value: 'md', label: t('lesions:list.filters.sizeMedium') },
      { value: 'lg', label: t('lesions:list.filters.sizeLarge') },
    ],
    [t],
  );

  const confidenceOptions = useMemo(
    () => [
      { value: '0', label: t('lesions:list.filters.confidenceValue', { value: 0 }) },
      { value: '0.5', label: t('lesions:list.filters.confidenceValue', { value: 50 }) },
      { value: '0.7', label: t('lesions:list.filters.confidenceValue', { value: 70 }) },
      { value: '0.85', label: t('lesions:list.filters.confidenceValue', { value: 85 }) },
      { value: '0.95', label: t('lesions:list.filters.confidenceValue', { value: 95 }) },
    ],
    [t],
  );

  // ── Render: loading ──
  if (isLoading) {
    return (
      <Box className={styles.root} data-testid={`${testId}-loading`}>
        <EMRTableSkeleton rows={6} columns={6} />
      </Box>
    );
  }

  // ── Render: empty ──
  if (lesions.length === 0) {
    return (
      <Box className={styles.root} data-testid={`${testId}-empty`}>
        <EMREmptyState
          illustration={noLesionsIllustrationUrl}
          title={t('lesions:list.emptyState.title')}
          description={t('lesions:list.emptyState.body')}
          size="md"
        />
      </Box>
    );
  }

  // ── Render: filters + grid ──
  return (
    <Box className={styles.root} data-testid={testId}>
      <Box className={styles.filters} role="region" aria-label={t('lesions:list.filters.heading')}>
        <Box className={styles.filterField}>
          <EMRSelect
            label={t('lesions:list.filters.confidence')}
            value={String(filters.minConfidence)}
            onChange={(v) => updateFilter('minConfidence', Number(v ?? 0))}
            data={confidenceOptions}
            allowDeselect={false}
          />
        </Box>
        <Box className={styles.filterField}>
          <EMRSelect
            label={t('lesions:list.filters.class')}
            value={filters.classValue}
            onChange={(v) => updateFilter('classValue', (v ?? 'all') as LesionClass | 'all')}
            data={classOptions}
            allowDeselect={false}
          />
        </Box>
        <Box className={styles.filterField}>
          <EMRSelect
            label={t('lesions:list.filters.segment')}
            value={filters.segment}
            onChange={(v) =>
              updateFilter('segment', (v ?? 'all') as CouinaudSegment | 'all')
            }
            data={segmentOptions}
            allowDeselect={false}
          />
        </Box>
        <Box className={styles.filterField}>
          <EMRSelect
            label={t('lesions:list.filters.size')}
            value={filters.sizeBucket}
            onChange={(v) => updateFilter('sizeBucket', (v ?? 'all') as SizeBucket)}
            data={sizeOptions}
            allowDeselect={false}
          />
        </Box>
        <Box className={styles.clearBtn}>
          <EMRButton variant="ghost" onClick={clearFilters} size="sm">
            {t('lesions:list.filters.clear')}
          </EMRButton>
        </Box>
        <Text className={styles.resultCount} aria-live="polite">
          {resultCountLabel}
        </Text>
      </Box>

      {filtered.length === 0 ? (
        <EMREmptyState
          title={t('lesions:list.emptyState.title')}
          description={t('lesions:list.emptyState.body')}
          size="sm"
          variant="filtered"
          action={{
            label: t('lesions:list.filters.clear'),
            onClick: clearFilters,
          }}
        />
      ) : (
        <Box
          className={styles.gridWrap}
          role="grid"
          aria-label={t('lesions:list.heading')}
          aria-rowcount={filtered.length + 1}
          aria-colcount={6}
        >
          {/* Header row — not virtualized, not mobile-visible */}
          <Box className={styles.headerRow} role="row" aria-rowindex={1}>
            <span role="columnheader" aria-colindex={1}>
              {t('lesions:list.columns.thumbnail')}
            </span>
            <span role="columnheader" aria-colindex={2}>
              {t('lesions:list.columns.location')}
            </span>
            <span role="columnheader" aria-colindex={3}>
              {t('lesions:list.columns.diameter')}
            </span>
            <span role="columnheader" aria-colindex={4}>
              {t('lesions:list.columns.class')}
            </span>
            <span role="columnheader" aria-colindex={5}>
              {t('lesions:list.columns.confidence')}
            </span>
            <span role="columnheader" aria-colindex={6}>
              {t('lesions:list.columns.source')}
            </span>
          </Box>

          <Box ref={viewportRef} className={styles.virtualViewport}>
            <Box
              className={styles.virtualInner}
              style={{
                height: shouldVirtualize ? `${virtualizer.getTotalSize()}px` : undefined,
              }}
            >
              {(shouldVirtualize
                ? virtualizer.getVirtualItems().map((v) => ({
                    idx: v.index,
                    transform: `translateY(${v.start}px)`,
                    key: v.key,
                  }))
                : filtered.map((_, idx) => ({ idx, transform: undefined, key: idx }))
              ).map(({ idx, transform, key }) => {
                const lesion = filtered[idx];
                if (!lesion) return null;
                const selected = selectedId === lesion.id;
                const className = lesion.suggestedClass
                  ? t(`lesions:classes.${lesion.suggestedClass}.name`)
                  : t('lesions:abstention.label');
                const confidencePct =
                  lesion.confidence === null ? 0 : Math.round(lesion.confidence * 100);
                const segmentLabel =
                  lesion.couinaudLocation === 'multi_segment'
                    ? t('lesions:detail.location.multiSegment')
                    : lesion.locationLabel;
                const rowAria = t('lesions:list.rowAria', {
                  index: lesion.index,
                  total: filtered.length,
                  segment: segmentLabel,
                  diameter: lesion.longestDiameterMm.toFixed(1),
                  className,
                  confidence: confidencePct,
                });
                const sourceLabel = t(`lesions:list.source.${lesion.discoverySource}`);
                const sourceCls =
                  lesion.discoverySource === 'ai_detected'
                    ? styles.sourceBadgeAI
                    : styles.sourceBadgeReviewer;

                return (
                  <Box
                    key={key}
                    role="row"
                    aria-rowindex={idx + 2}
                    aria-selected={selected}
                    aria-label={rowAria}
                    tabIndex={0}
                    onClick={() => handleSelect(lesion)}
                    onKeyDown={(e) => handleRowKeyDown(e, lesion)}
                    className={[styles.row, selected ? styles.rowSelected : '']
                      .filter(Boolean)
                      .join(' ')}
                    style={
                      transform
                        ? {
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            transform,
                            height: `${ROW_HEIGHT_PX}px`,
                          }
                        : undefined
                    }
                    data-testid={`lesion-row-${lesion.id}`}
                  >
                    <Box role="gridcell" aria-colindex={1} className={styles.thumb}>
                      {lesion.thumbnailUrl ? (
                        <img src={lesion.thumbnailUrl} alt="" aria-hidden="true" />
                      ) : (
                        <span className={styles.thumbFallback}>{lesion.index}</span>
                      )}
                    </Box>
                    <Box role="gridcell" aria-colindex={2} className={styles.cellText}>
                      {segmentLabel}
                    </Box>
                    <Box role="gridcell" aria-colindex={3} className={styles.cellText}>
                      {lesion.longestDiameterMm.toFixed(1)}{' '}
                      <span className={styles.cellMuted}>{t('lesions:detail.size.mm')}</span>
                    </Box>
                    <Box role="gridcell" aria-colindex={4}>
                      <LesionBadge
                        classValue={lesion.suggestedClass}
                        confidence={lesion.confidence}
                        override={lesion.reviewerOverride}
                        compact
                        data-testid={`lesion-class-${lesion.id}`}
                      />
                    </Box>
                    <Box role="gridcell" aria-colindex={5}>
                      <Group gap={4} wrap="wrap">
                        <Text fz="sm" fw={600} style={{ flexShrink: 0 }}>
                          {lesion.confidence === null ? '—' : `${confidencePct}%`}
                        </Text>
                      </Group>
                    </Box>
                    <Box role="gridcell" aria-colindex={6}>
                      <span
                        className={[styles.sourceBadge, sourceCls].join(' ')}
                        aria-label={sourceLabel}
                      >
                        {sourceLabel}
                      </span>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}

export default LesionList;
