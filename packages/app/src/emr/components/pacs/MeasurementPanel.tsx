// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// MeasurementPanel Component
// ============================================================================
// A sidebar panel that shows all annotations/measurements from the PACS viewer,
// grouped by the practitioner who drew them. Think of it like a "measurements
// clipboard" — each doctor gets their own collapsible section showing length,
// angle, and ROI measurements, with a toggle to show/hide their drawings on
// the images.
//
// Measurement types:
//   - Length: distance between two points (in mm)
//   - Angle: angle between three points (in degrees)
//   - EllipticalROI: oval region with area, mean, min, max pixel values
//
// Dependencies: useAnnotations hook (T042), StoredAnnotations type (T041)
//
// Ported from MediMind. Translation calls updated to LiverRa's `t(key, params?)`
// signature — the second-arg "fallback" form used in MediMind is gone; fallback
// text lives in `translations/*/pacs.json` so missing keys round-trip to en.
// ============================================================================

import { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import {
  Stack,
  Text,
  Group,
  Badge,
  ActionIcon,
  Tooltip,
  Collapse,
} from '@mantine/core';
import {
  IconRulerMeasure,
  IconEye,
  IconEyeOff,
  IconChevronDown,
  IconChevronRight,
  IconLine,
  IconAngle,
  IconOvalVertical,
  IconUser,
  IconLock,
  IconLockOpen,
  IconFocus2,
  IconArrowUp,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import type { StoredAnnotations } from '../../services/pacs/annotationService';
import './MeasurementPanel.css';

// ============================================================================
// Types
// ============================================================================

export interface MeasurementPanelProps {
  /** All annotations loaded for the current study (from all authors) */
  annotations: StoredAnnotations[];
  /** Set of author IDs whose annotations are currently visible */
  visibleAuthors: Set<string>;
  /** Toggle visibility for a specific author's annotations */
  onToggleVisibility: (authorId: string) => void;
  /** Toggle visibility for a single annotation (eye icon per row) */
  onToggleAnnotationVisibility?: (annotationUID: string) => void;
  /** Toggle lock for a single annotation (lock icon per row) */
  onToggleAnnotationLock?: (annotationUID: string) => void;
  /** Current tracking mode: 'tracked' = solid lines (permanent), 'untracked' = dashed lines (temporary) */
  trackingMode?: 'tracked' | 'untracked';
  /** Switch tracking mode for new annotations */
  onTrackingModeChange?: (mode: 'tracked' | 'untracked') => void;
  /** Metadata map for each annotation UID — tracks isTracked status */
  annotationMeta?: Map<string, { isTracked: boolean; trackingId: string; trackingUniqueId: string }>;
  /** Jump to an annotation's location in the viewport */
  onJumpToAnnotation?: (annotationUID: string) => void;
  /** Promote an untracked annotation to tracked */
  onPromoteToTracked?: (annotationUID: string) => void;
}

/** A single parsed measurement extracted from Cornerstone3D annotation JSON */
interface ParsedMeasurement {
  /** Unique identifier from Cornerstone3D */
  id: string;
  /** Type of measurement tool used */
  type:
    | 'Length'
    | 'Angle'
    | 'CobbAngle'
    | 'Bidirectional'
    | 'Probe'
    | 'DragProbe'
    | 'ArrowAnnotate'
    | 'EllipticalROI'
    | 'RectangleROI'
    | 'CircleROI'
    | 'FreehandROI'
    | 'SplineROI'
    | 'Polyline'
    | 'Unknown';
  /** Human-readable label (e.g., "Length #1") */
  label: string;
  /** Key-value pairs of measurement results */
  values: { label: string; value: string }[];
}

/** Annotations grouped by author for display */
interface AuthorGroup {
  authorId: string;
  authorName: string;
  measurements: ParsedMeasurement[];
  lastSaved: string;
}

/** Signature of the translation function (matches `useTranslation().t`). */
type TFn = (key: string, params?: Record<string, unknown>) => string;

// ============================================================================
// Parsing Helpers
// ============================================================================

/**
 * Map a single Cornerstone3D annotation (from any tool) into a ParsedMeasurement.
 * Returns null if the tool is not recognized.
 */
function parseAnnotationByTool(
  toolName: string,
  uid: string,
  annData: unknown,
  inc: (key: string) => number,
  t: TFn,
): ParsedMeasurement | null {
  const d = (annData ?? {}) as Record<string, unknown>;

  // --- Length-like tools (single distance in mm) ---
  if (toolName === 'Length' || toolName === 'LengthTool') {
    const n = inc('Length');
    const length = (d.length as number) ?? (d.cachedStats as Record<string, unknown>)?.length;
    return { id: uid, type: 'Length', label: t('pacs.tools.lengthLabel', { n }), values: [{ label: 'mm', value: formatNumber(length) }] };
  }

  if (toolName === 'Bidirectional' || toolName === 'BidirectionalTool') {
    const n = inc('Bidirectional');
    const major = (d.length as number) ?? (d.cachedStats as Record<string, unknown>)?.length;
    const minor = (d.width as number) ?? (d.cachedStats as Record<string, unknown>)?.width;
    return {
      id: uid, type: 'Bidirectional', label: t('pacs.tools.bidirectionalLabel', { n }),
      values: [{ label: 'long mm', value: formatNumber(major) }, { label: 'short mm', value: formatNumber(minor) }],
    };
  }

  // --- Angle-like tools (single angle in degrees) ---
  if (toolName === 'Angle' || toolName === 'AngleTool') {
    const n = inc('Angle');
    const angle = (d.angle as number) ?? (d.cachedStats as Record<string, unknown>)?.angle;
    return { id: uid, type: 'Angle', label: t('pacs.tools.angleLabel', { n }), values: [{ label: '°', value: formatNumber(angle) }] };
  }

  if (toolName === 'CobbAngle' || toolName === 'CobbAngleTool') {
    const n = inc('CobbAngle');
    const angle = (d.angle as number) ?? (d.cachedStats as Record<string, unknown>)?.angle;
    return { id: uid, type: 'CobbAngle', label: t('pacs.tools.cobbAngleLabel', { n }), values: [{ label: '°', value: formatNumber(angle) }] };
  }

  // --- Probe tools (pixel value at a point) ---
  if (toolName === 'Probe' || toolName === 'ProbeTool') {
    const n = inc('Probe');
    const val = (d.value as number) ?? (d.cachedStats as Record<string, unknown>)?.value;
    return { id: uid, type: 'Probe', label: t('pacs.tools.probeLabel', { n }), values: [{ label: 'HU', value: formatNumber(val) }] };
  }

  if (toolName === 'DragProbe' || toolName === 'DragProbeTool') {
    const n = inc('DragProbe');
    const val = (d.value as number) ?? (d.cachedStats as Record<string, unknown>)?.value;
    return { id: uid, type: 'DragProbe', label: t('pacs.tools.dragProbeLabel', { n }), values: [{ label: 'HU', value: formatNumber(val) }] };
  }

  // --- Annotation tools (text label, no numeric value) ---
  if (toolName === 'ArrowAnnotate' || toolName === 'ArrowAnnotateTool') {
    const n = inc('ArrowAnnotate');
    const text = (d.text as string) || '';
    return { id: uid, type: 'ArrowAnnotate', label: t('pacs.tools.arrowLabel', { n }), values: [{ label: 'note', value: text || '—' }] };
  }

  // --- ROI tools (area/mean/min/max from cachedStats) ---
  if (toolName === 'EllipticalROI' || toolName === 'EllipticalROITool') {
    const n = inc('ROI');
    const stats = d.cachedStats;
    return { id: uid, type: 'EllipticalROI', label: t('pacs.tools.roiLabel', { n }), values: extractROIStats(stats) };
  }

  if (toolName === 'RectangleROI' || toolName === 'RectangleROITool') {
    const n = inc('ROI');
    const stats = d.cachedStats;
    return { id: uid, type: 'RectangleROI', label: t('pacs.tools.rectRoiLabel', { n }), values: extractROIStats(stats) };
  }

  if (toolName === 'CircleROI' || toolName === 'CircleROITool') {
    const n = inc('ROI');
    const stats = d.cachedStats;
    return { id: uid, type: 'CircleROI', label: t('pacs.tools.circleRoiLabel', { n }), values: extractROIStats(stats) };
  }

  if (toolName === 'FreehandROI' || toolName === 'FreehandROITool') {
    const n = inc('ROI');
    const stats = d.cachedStats;
    return { id: uid, type: 'FreehandROI', label: t('pacs.tools.freehandRoiLabel', { n }), values: extractROIStats(stats) };
  }

  if (toolName === 'SplineROI' || toolName === 'SplineROITool') {
    const n = inc('ROI');
    const stats = d.cachedStats;
    return { id: uid, type: 'SplineROI', label: t('pacs.tools.splineRoiLabel', { n }), values: extractROIStats(stats) };
  }

  // --- Polyline (perimeter in mm) ---
  if (toolName === 'Polyline' || toolName === 'PolylineTool') {
    const n = inc('Polyline');
    const perimeter = (d.length as number) ?? (d.cachedStats as Record<string, unknown>)?.length;
    return { id: uid, type: 'Polyline', label: t('pacs.tools.polylineLabel', { n }), values: [{ label: 'mm', value: formatNumber(perimeter) }] };
  }

  return null;
}

/**
 * Parse the JSON string from a StoredAnnotations record into individual
 * measurements. Cornerstone3D stores annotations as a JSON object with
 * tool-specific arrays.
 */
function parseMeasurements(dataJson: string, t: TFn): ParsedMeasurement[] {
  if (!dataJson) {
    return [];
  }

  try {
    const data = JSON.parse(dataJson);
    const measurements: ParsedMeasurement[] = [];

    // Handle array format (list of annotations with metadata.toolName)
    if (Array.isArray(data)) {
      const counters: Record<string, number> = {};
      const inc = (key: string): number => {
        counters[key] = (counters[key] || 0) + 1;
        return counters[key];
      };

      for (const ann of data) {
        const toolName = ann?.metadata?.toolName || ann?.toolName || '';
        const uid = ann?.annotationUID || ann?.id || `ann-${measurements.length}`;
        const parsed = parseAnnotationByTool(toolName, uid, ann?.data, inc, t);
        if (parsed) {
          measurements.push(parsed);
        }
      }
    }

    // Handle object format { "Length": [...], "Angle": [...] }
    if (!Array.isArray(data) && typeof data === 'object') {
      const counters: Record<string, number> = {};
      const inc = (key: string): number => {
        counters[key] = (counters[key] || 0) + 1;
        return counters[key];
      };

      for (const [toolName, annList] of Object.entries(data)) {
        if (!Array.isArray(annList)) {
          continue;
        }

        for (const ann of annList as Record<string, unknown>[]) {
          const uid =
            (ann?.annotationUID as string) ||
            (ann?.id as string) ||
            `${toolName}-${inc('_fallback')}`;

          const parsed = parseAnnotationByTool(toolName, uid, ann?.data, inc, t);
          if (parsed) {
            measurements.push(parsed);
          }
        }
      }
    }

    return measurements;
  } catch (err) {
    console.warn('[MeasurementPanel] Failed to parse measurement JSON (corrupt data?):', err);
    return [];
  }
}

/** Extract area/mean/min/max from ROI stats (handles nested volume/viewport keys) */
function extractROIStats(stats: unknown): { label: string; value: string }[] {
  if (!stats || typeof stats !== 'object') {
    return [{ label: 'status', value: 'Calculating...' }];
  }

  const record = stats as Record<string, unknown>;

  // Direct stats: { area, mean, stdDev, min, max }
  if ('area' in record || 'mean' in record) {
    return [
      { label: 'area', value: `${formatNumber(record.area as number)} mm²` },
      { label: 'mean', value: formatNumber(record.mean as number) },
      { label: 'min', value: formatNumber(record.min as number) },
      { label: 'max', value: formatNumber(record.max as number) },
    ];
  }

  // Nested under volume/viewport key: { "vol-id": { area, mean, ... } }
  const firstKey = Object.keys(record)[0];
  if (firstKey && typeof record[firstKey] === 'object') {
    return extractROIStats(record[firstKey]);
  }

  return [{ label: 'area', value: '—' }];
}

/** Format a number to 1 decimal place, or "—" if not a valid number */
function formatNumber(val: unknown): string {
  if (val === undefined || val === null) {
    return '—';
  }
  const num = Number(val);
  if (isNaN(num)) {
    return '—';
  }
  return num.toFixed(1);
}

// ============================================================================
// Component
// ============================================================================

export function MeasurementPanel({
  annotations,
  visibleAuthors,
  onToggleVisibility,
  onToggleAnnotationVisibility,
  onToggleAnnotationLock,
  trackingMode,
  onTrackingModeChange,
  annotationMeta,
  onJumpToAnnotation,
  onPromoteToTracked,
}: MeasurementPanelProps): JSX.Element {
  const { t } = useTranslation();

  // Parse cache — avoids re-parsing JSON for annotations that haven't changed.
  // Keyed by authorId, stores the lastSaved timestamp and parsed result.
  // Think of it like a smart bookshelf: only re-read books whose cover date changed.
  const parseCacheRef = useRef<Map<string, { lastSaved: string; parsed: ParsedMeasurement[] }>>(new Map());

  // Parse annotations into grouped author sections (with caching)
  const authorGroups: AuthorGroup[] = useMemo(() => {
    const cache = parseCacheRef.current;
    const currentAuthorIds = new Set<string>();
    let anyChanged = false;

    const groups = annotations
      .map((ann) => {
        currentAuthorIds.add(ann.authorId);
        const cached = cache.get(ann.authorId);

        let measurements: ParsedMeasurement[];
        if (cached && cached.lastSaved === ann.lastSaved) {
          // Cache hit — reuse previously parsed measurements
          measurements = cached.parsed;
        } else {
          // Cache miss — parse and store
          measurements = parseMeasurements(ann.data, t);
          cache.set(ann.authorId, { lastSaved: ann.lastSaved, parsed: measurements });
          anyChanged = true;
        }

        return {
          authorId: ann.authorId,
          authorName: ann.authorName || t('pacs.measurements.unknownAuthor'),
          measurements,
          lastSaved: ann.lastSaved,
        };
      })
      .filter((group) => group.measurements.length > 0);

    // Clean up stale cache entries (deleted annotations)
    for (const key of cache.keys()) {
      if (!currentAuthorIds.has(key)) {
        cache.delete(key);
        anyChanged = true;
      }
    }

    // Keep reference stability if nothing actually changed
    return anyChanged || groups.length !== parseCacheRef.current.size ? groups : groups;
  }, [annotations, t]);

  // Total measurement count across all authors
  const totalCount = useMemo(
    () => authorGroups.reduce((sum, g) => sum + g.measurements.length, 0),
    [authorGroups]
  );

  return (
    <div className="measurement-panel" data-testid="measurement-panel">
      {/* Header */}
      <Group className="measurement-panel-header" justify="space-between">
        <Group gap="xs">
          <IconRulerMeasure size={16} style={{ color: 'var(--emr-accent)' }} />
          <Text fw="var(--emr-font-semibold)" size="sm">
            {t('pacs.measurements.title')}
          </Text>
          {totalCount > 0 && (
            <Badge
              size="sm"
              variant="filled"
              className="measurement-count-badge"
            >
              {totalCount}
            </Badge>
          )}
        </Group>
      </Group>

      {/* T034 — Tracked/Untracked toggle: like pen vs pencil mode */}
      {onTrackingModeChange && (
        <div className="measurement-tracking-toggle" data-testid="tracking-toggle">
          <Group gap={0} className="tracking-toggle-group">
            <button
              type="button"
              className={`tracking-toggle-btn ${trackingMode === 'tracked' ? 'tracking-toggle-active' : ''}`}
              onClick={() => onTrackingModeChange('tracked')}
              aria-pressed={trackingMode === 'tracked'}
            >
              {t('pacs.measurements.tracked')}
            </button>
            <button
              type="button"
              className={`tracking-toggle-btn ${trackingMode === 'untracked' ? 'tracking-toggle-active' : ''}`}
              onClick={() => onTrackingModeChange('untracked')}
              aria-pressed={trackingMode === 'untracked'}
            >
              {t('pacs.measurements.untracked')}
            </button>
          </Group>
          <Text size="xs" c="dimmed" className="tracking-hint">
            {trackingMode === 'tracked'
              ? t('pacs.measurements.trackedHint')
              : t('pacs.measurements.untrackedHint')}
          </Text>
        </div>
      )}

      {/* Empty state */}
      {authorGroups.length === 0 && (
        <div className="measurement-panel-empty">
          <IconRulerMeasure
            size={32}
            style={{ color: 'var(--emr-text-secondary)', opacity: 0.5 }}
          />
          <Text size="xs" c="dimmed" ta="center">
            {t('pacs.measurements.empty')}
          </Text>
          <Text size="xs" c="dimmed" ta="center">
            {t('pacs.measurements.hint')}
          </Text>
        </div>
      )}

      {/* Author groups */}
      {authorGroups.length > 0 && (
        <Stack gap="xs" className="measurement-panel-groups">
          {authorGroups.map((group) => (
            <AuthorSection
              key={group.authorId}
              group={group}
              isVisible={visibleAuthors.has(group.authorId)}
              onToggleVisibility={onToggleVisibility}
              onToggleAnnotationVisibility={onToggleAnnotationVisibility}
              onToggleAnnotationLock={onToggleAnnotationLock}
              annotationMeta={annotationMeta}
              onJumpToAnnotation={onJumpToAnnotation}
              onPromoteToTracked={onPromoteToTracked}
            />
          ))}
        </Stack>
      )}
    </div>
  );
}

// ============================================================================
// AuthorSection — Collapsible section for one author's measurements
// ============================================================================

interface AuthorSectionProps {
  group: AuthorGroup;
  isVisible: boolean;
  onToggleVisibility: (authorId: string) => void;
  onToggleAnnotationVisibility?: (annotationUID: string) => void;
  onToggleAnnotationLock?: (annotationUID: string) => void;
  annotationMeta?: Map<string, { isTracked: boolean; trackingId: string; trackingUniqueId: string }>;
  onJumpToAnnotation?: (annotationUID: string) => void;
  onPromoteToTracked?: (annotationUID: string) => void;
}

function AuthorSection({
  group,
  isVisible,
  onToggleVisibility,
  onToggleAnnotationVisibility,
  onToggleAnnotationLock,
  annotationMeta,
  onJumpToAnnotation,
  onPromoteToTracked,
}: AuthorSectionProps): JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);

  const handleToggleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleToggleVisibility = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleVisibility(group.authorId);
    },
    [onToggleVisibility, group.authorId]
  );

  const savedDate = group.lastSaved
    ? new Date(group.lastSaved).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  return (
    <div
      className="measurement-author-section"
      data-testid={`measurement-author-${group.authorId}`}
    >
      {/* Author header — click to expand/collapse */}
      <Group
        className="measurement-author-header"
        justify="space-between"
        onClick={handleToggleExpand}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            handleToggleExpand();
          }
        }}
        aria-expanded={expanded}
        aria-label={`${group.authorName} - ${group.measurements.length} ${t('pacs.measurements.title')}`}
      >
        <Group gap="xs" style={{ minWidth: 0 }}>
          {expanded ? (
            <IconChevronDown size={14} style={{ flexShrink: 0 }} />
          ) : (
            <IconChevronRight size={14} style={{ flexShrink: 0 }} />
          )}
          <IconUser size={14} style={{ flexShrink: 0, color: 'var(--emr-text-secondary)' }} />
          <Text size="xs" fw="var(--emr-font-semibold)" lineClamp={1} style={{ minWidth: 0 }}>
            {group.authorName}
          </Text>
          <Badge size="xs" variant="light" style={{ flexShrink: 0 }}>
            {group.measurements.length}
          </Badge>
        </Group>

        {/* Visibility toggle */}
        <Tooltip
          label={
            isVisible
              ? t('pacs.measurements.hide')
              : t('pacs.measurements.show')
          }
        >
          <ActionIcon
            variant="subtle"
            size="xs"
            onClick={handleToggleVisibility}
            aria-label={
              isVisible
                ? t('pacs.measurements.hide')
                : t('pacs.measurements.show')
            }
          >
            {isVisible ? (
              <IconEye size={14} style={{ color: 'var(--emr-accent)' }} />
            ) : (
              <IconEyeOff size={14} style={{ color: 'var(--emr-text-secondary)' }} />
            )}
          </ActionIcon>
        </Tooltip>
      </Group>

      {/* Collapsible measurement list */}
      <Collapse in={expanded}>
        <Stack gap={4} className="measurement-list">
          {group.measurements.map((m) => (
            <MeasurementRow
              key={m.id}
              measurement={m}
              onToggleVisibility={onToggleAnnotationVisibility}
              onToggleLock={onToggleAnnotationLock}
              isTracked={annotationMeta?.get(m.id)?.isTracked}
              onJumpToAnnotation={onJumpToAnnotation}
              onPromoteToTracked={onPromoteToTracked}
            />
          ))}
          {savedDate && (
            <Text
              size="xs"
              c="dimmed"
              ta="right"
              style={{ fontSize: 'var(--emr-font-xs)', padding: '2px 4px' }}
            >
              {t('pacs.measurements.saved')}: {savedDate}
            </Text>
          )}
        </Stack>
      </Collapse>
    </div>
  );
}

// ============================================================================
// MeasurementRow — Single measurement display
// ============================================================================

interface MeasurementRowProps {
  measurement: ParsedMeasurement;
  /** Toggle visibility for this annotation (eye icon) */
  onToggleVisibility?: (annotationUID: string) => void;
  /** Toggle lock for this annotation (lock icon) */
  onToggleLock?: (annotationUID: string) => void;
  /** Whether this annotation is tracked (solid line) — undefined means unknown */
  isTracked?: boolean;
  /** T035: Jump viewport to this annotation's location */
  onJumpToAnnotation?: (annotationUID: string) => void;
  /** T036: Promote untracked annotation to tracked */
  onPromoteToTracked?: (annotationUID: string) => void;
}

function MeasurementRow({
  measurement,
  onToggleVisibility,
  onToggleLock,
  isTracked,
  onJumpToAnnotation,
  onPromoteToTracked,
}: MeasurementRowProps): JSX.Element {
  const { t } = useTranslation();
  const icon = getMeasurementIcon(measurement.type);

  // Local state for visibility and lock — driven by CS3D responses via callbacks
  const [isVisible, setIsVisible] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  // T036: Context menu open state
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });

  const handleToggleVisibility = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsVisible((prev) => !prev);
    onToggleVisibility?.(measurement.id);
  }, [onToggleVisibility, measurement.id]);

  const handleToggleLock = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLocked((prev) => !prev);
    onToggleLock?.(measurement.id);
  }, [onToggleLock, measurement.id]);

  // T035: Click row to jump to annotation in viewport
  const handleRowClick = useCallback(() => {
    onJumpToAnnotation?.(measurement.id);
  }, [onJumpToAnnotation, measurement.id]);

  // T036: Right-click to show context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onPromoteToTracked) {
      return;
    }
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setContextMenuOpen(true);
  }, [onPromoteToTracked]);

  // T036: Promote to tracked from context menu
  const handlePromote = useCallback(() => {
    onPromoteToTracked?.(measurement.id);
    setContextMenuOpen(false);
  }, [onPromoteToTracked, measurement.id]);

  // Close context menu when clicking elsewhere
  useEffect(() => {
    if (!contextMenuOpen) {
      return;
    }
    const handleClose = (): void => setContextMenuOpen(false);
    document.addEventListener('click', handleClose);
    return () => document.removeEventListener('click', handleClose);
  }, [contextMenuOpen]);

  // T034: Visual distinction — untracked rows get dashed left border and muted style
  const rowClassName = `measurement-row${onJumpToAnnotation ? ' measurement-row-clickable' : ''}${isTracked === false ? ' measurement-row-untracked' : ''}`;

  return (
    <div
      className={rowClassName}
      data-testid={`measurement-${measurement.id}`}
      style={{ opacity: isVisible ? 1 : 0.5 }}
      onClick={handleRowClick}
      onContextMenu={handleContextMenu}
      role={onJumpToAnnotation ? 'button' : undefined}
      tabIndex={onJumpToAnnotation ? 0 : undefined}
      onKeyDown={onJumpToAnnotation ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleRowClick();
        }
      } : undefined}
      title={onJumpToAnnotation ? t('pacs.measurements.jumpTo') : undefined}
    >
      <Group gap="xs" wrap="nowrap" align="center" style={{ minWidth: 0 }}>
        <span className="measurement-icon" style={{ flexShrink: 0 }}>
          {icon}
        </span>
        <Text size="xs" fw="var(--emr-font-medium)" lineClamp={1} style={{ minWidth: 0 }}>
          {measurement.label}
        </Text>
      </Group>

      <Group gap={2} wrap="nowrap" align="center" style={{ flexShrink: 0 }}>
        <div className="measurement-values">
          {measurement.values.map((v, idx) => (
            <span key={idx} className="measurement-value-pair">
              <span className="measurement-value-label">{v.label}:</span>
              <span className="measurement-value-number">{v.value}</span>
            </span>
          ))}
        </div>

        {/* T035: Jump-to icon — visual affordance for clickable rows */}
        {onJumpToAnnotation && (
          <Tooltip label={t('pacs.measurements.jumpTo')}>
            <ActionIcon
              variant="subtle"
              size="xs"
              onClick={(e) => { e.stopPropagation(); handleRowClick(); }}
              aria-label={t('pacs.measurements.jumpTo')}
              className="measurement-row-action"
            >
              <IconFocus2 size={12} style={{ color: 'var(--emr-accent)' }} />
            </ActionIcon>
          </Tooltip>
        )}

        {/* Per-row visibility toggle */}
        <Tooltip label={isVisible
          ? t('pacs.measurements.hideAnnotation')
          : t('pacs.measurements.showAnnotation')
        }>
          <ActionIcon
            variant="subtle"
            size="xs"
            onClick={handleToggleVisibility}
            aria-label={isVisible
              ? t('pacs.measurements.hideAnnotation')
              : t('pacs.measurements.showAnnotation')
            }
            className="measurement-row-action"
          >
            {isVisible ? (
              <IconEye size={12} style={{ color: 'var(--emr-text-secondary)' }} />
            ) : (
              <IconEyeOff size={12} style={{ color: 'var(--emr-text-secondary)' }} />
            )}
          </ActionIcon>
        </Tooltip>

        {/* Per-row lock toggle */}
        <Tooltip label={isLocked
          ? t('pacs.measurements.unlockAnnotation')
          : t('pacs.measurements.lockAnnotation')
        }>
          <ActionIcon
            variant="subtle"
            size="xs"
            onClick={handleToggleLock}
            aria-label={isLocked
              ? t('pacs.measurements.unlockAnnotation')
              : t('pacs.measurements.lockAnnotation')
            }
            className="measurement-row-action"
          >
            {isLocked ? (
              <IconLock size={12} style={{ color: 'var(--emr-warning)' }} />
            ) : (
              <IconLockOpen size={12} style={{ color: 'var(--emr-text-secondary)' }} />
            )}
          </ActionIcon>
        </Tooltip>
      </Group>

      {/* T036: Context menu for promote-to-tracked */}
      {contextMenuOpen && isTracked === false && (
        <div
          className="measurement-context-menu"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
          data-testid="promote-context-menu"
        >
          <button
            type="button"
            className="measurement-context-menu-item"
            onClick={(e) => { e.stopPropagation(); handlePromote(); }}
          >
            <IconArrowUp size={14} style={{ color: 'var(--emr-accent)', flexShrink: 0 }} />
            <span>{t('pacs.measurements.promoteToTracked')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Get the icon for a measurement type */
function getMeasurementIcon(type: ParsedMeasurement['type']): JSX.Element {
  switch (type) {
    case 'Length':
    case 'Bidirectional':
    case 'Polyline':
      return <IconLine size={14} style={{ color: 'var(--emr-success)' }} />;
    case 'Angle':
    case 'CobbAngle':
      return <IconAngle size={14} style={{ color: 'var(--emr-warning)' }} />;
    case 'Probe':
    case 'DragProbe':
      return <IconRulerMeasure size={14} style={{ color: 'var(--emr-accent)' }} />;
    case 'ArrowAnnotate':
      return <IconRulerMeasure size={14} style={{ color: 'var(--emr-text-secondary)' }} />;
    case 'EllipticalROI':
    case 'RectangleROI':
    case 'CircleROI':
    case 'FreehandROI':
    case 'SplineROI':
      return <IconOvalVertical size={14} style={{ color: 'var(--emr-info)' }} />;
    default:
      return <IconRulerMeasure size={14} style={{ color: 'var(--emr-text-secondary)' }} />;
  }
}
