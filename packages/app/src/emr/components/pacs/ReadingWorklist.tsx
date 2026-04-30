// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// ReadingWorklist (LiverRa)
// ============================================================================
// The radiology triage board. Unread imaging studies, sorted by priority
// (STAT first) then wait time. Priority badge, patient name, modality,
// description, date, wait time + SLA bar, ordering doctor, overdue pulse,
// filter controls, 30-second auto-refresh.
//
// Ported from MediMind. Adaptations:
//   - `EMRTable` → local `LiverraPacsTable` shim.
//   - `UseReadingWorklistReturn` imported from the ported LiverRa hook.
//   - `EMRButton` usage preserved — LiverRa already has `../common/EMRButton`.
//   - `EMRSwitch` is LiverRa-native under `../shared/EMRFormFields`.
// ============================================================================

import React, {
  memo,
  useMemo,
  useCallback,
  useState,
  useEffect,
  useRef,
} from 'react';
import { Box, Group, Text, Stack, Skeleton } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconListDetails,
  IconCalendar,
  IconClock,
  IconStethoscope,
  IconRefresh,
  IconAlertTriangle,
  IconCircleCheck,
  IconSearch,
  IconHistory,
  IconRadar,
  IconClockHour4,
  IconUrgent,
} from '@tabler/icons-react';
import { EMRTable, type EMRTableColumn } from './LiverraPacsTable';
import { EMRButton } from '../common/EMRButton';
import {
  EMRTextInput,
  EMRSelect,
  EMRMultiSelect,
  EMRSwitch,
} from '../shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';
import type { ReadingWorklistItem, ImagingPriority } from '../../types/pacs';
import type { UseReadingWorklistReturn } from '../../hooks/pacs/useReadingWorklist';
import styles from './ReadingWorklist.module.css';

// ============================================================================
// Props
// ============================================================================

export interface ReadingWorklistProps {
  /** Return value of `useReadingWorklist()`. */
  worklist: UseReadingWorklistReturn;
  /** Row click handler — usually routes to the viewer. */
  onStudyClick?: (item: ReadingWorklistItem) => void;
  /** Auto-advance flag (controlled externally when present). */
  autoAdvance?: boolean;
  /** Called when the auto-advance switch flips. */
  onAutoAdvanceChange?: (enabled: boolean) => void;
}

// ============================================================================
// Priority badge
// ============================================================================

const PRIORITY_STYLE_MAP: Record<ImagingPriority, string> = {
  stat: styles.priorityStat,
  urgent: styles.priorityUrgent,
  routine: styles.priorityRoutine,
};

const PRIORITY_DOT_MAP: Record<ImagingPriority, string> = {
  stat: styles.priorityDotStat,
  urgent: styles.priorityDotUrgent,
  routine: styles.priorityDotRoutine,
};

function PriorityBadge({
  priority,
  t,
}: {
  priority: ImagingPriority;
  t: (key: string) => string;
}): React.ReactElement {
  const className = PRIORITY_STYLE_MAP[priority] || styles.priorityRoutine;
  const dotClass = PRIORITY_DOT_MAP[priority] || styles.priorityDotRoutine;
  const labelKey = `pacs.priority.${priority}`;
  return (
    <span
      className={`${styles.priorityBadge} ${className}`}
      data-testid={`priority-badge-${priority}`}
    >
      <span className={`${styles.priorityDot} ${dotClass}`} />
      {t(labelKey)}
    </span>
  );
}

// ============================================================================
// Wait-time helpers
// ============================================================================

function formatWaitTime(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}

function getSLAColor(priority: ImagingPriority, waitMinutes: number): string {
  if (priority === 'stat') {
    if (waitMinutes < 30) return 'var(--emr-success)';
    if (waitMinutes < 60) return 'var(--emr-warning)';
    return 'var(--emr-error)';
  }
  if (priority === 'urgent') {
    if (waitMinutes < 120) return 'var(--emr-success)';
    if (waitMinutes < 240) return 'var(--emr-warning)';
    return 'var(--emr-error)';
  }
  if (waitMinutes < 720) return 'var(--emr-success)';
  if (waitMinutes < 1440) return 'var(--emr-warning)';
  return 'var(--emr-error)';
}

function getSLAProgress(priority: ImagingPriority, waitMinutes: number): number {
  if (priority === 'stat') {
    return Math.min(100, (waitMinutes / 60) * 100);
  }
  if (priority === 'urgent') {
    return Math.min(100, (waitMinutes / 240) * 100);
  }
  return Math.min(100, (waitMinutes / 1440) * 100);
}

function getSLAStatusKey(
  priority: ImagingPriority,
  waitMinutes: number
): string {
  if (priority === 'stat') {
    if (waitMinutes < 30) return 'pacs.sla.withinSLA';
    if (waitMinutes < 60) return 'pacs.sla.approachingSLA';
    return 'pacs.sla.breached';
  }
  if (priority === 'urgent') {
    if (waitMinutes < 120) return 'pacs.sla.withinSLA';
    if (waitMinutes < 240) return 'pacs.sla.approachingSLA';
    return 'pacs.sla.breached';
  }
  if (waitMinutes < 720) return 'pacs.sla.withinSLA';
  if (waitMinutes < 1440) return 'pacs.sla.approachingSLA';
  return 'pacs.sla.breached';
}

function WaitTimeCell({
  item,
}: {
  item: ReadingWorklistItem;
}): React.ReactElement {
  const { t } = useTranslation();
  const slaColor = getSLAColor(item.priority, item.waitTime);
  const slaProgress = getSLAProgress(item.priority, item.waitTime);

  if (item.isOverdue) {
    return (
      <div className={styles.slaBar} data-testid="overdue-indicator">
        <span className={styles.overdueIndicator}>
          <span
            className={styles.overdueDot}
            aria-label={t('pacs.sla.breached')}
          />
          <span>{formatWaitTime(item.waitTime)}</span>
        </span>
        <div className={styles.slaBarTrack}>
          <div
            className={styles.slaBarFill}
            style={{ width: '100%', background: 'var(--emr-error)' }}
          />
        </div>
      </div>
    );
  }
  return (
    <div className={styles.slaBar}>
      <span className={styles.waitTimeNormal}>
        <span
          className={styles.slaDot}
          style={{ background: slaColor }}
          aria-label={t(getSLAStatusKey(item.priority, item.waitTime))}
        />
        {formatWaitTime(item.waitTime)}
      </span>
      <div className={styles.slaBarTrack}>
        <div
          className={styles.slaBarFill}
          style={{ width: `${slaProgress}%`, background: slaColor }}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Modality chips with per-modality coloring
// ============================================================================

const MODALITY_CLASS_MAP: Record<string, string> = {
  CT: styles.modalityCT,
  MR: styles.modalityMR,
  XR: styles.modalityXR,
  US: styles.modalityUS,
  MG: styles.modalityMG,
  NM: styles.modalityNM,
};

function ModalityChips({
  modalities,
  bodyPart,
}: {
  modalities: string[];
  bodyPart?: string;
}): React.ReactElement {
  if (modalities.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        --
      </Text>
    );
  }
  return (
    <Group gap={4} wrap="wrap" align="center">
      {modalities.map((mod) => (
        <span
          key={mod}
          className={`${styles.modalityChip} ${
            MODALITY_CLASS_MAP[mod] || styles.modalityDefault
          }`}
        >
          {mod}
        </span>
      ))}
      {bodyPart && (
        <Text
          size="xs"
          c="dimmed"
          fs="italic"
          style={{ whiteSpace: 'nowrap' }}
        >
          {bodyPart}
        </Text>
      )}
    </Group>
  );
}

// ============================================================================
// Auto-refresh indicator
// ============================================================================

function RefreshIndicator({
  lastUpdated,
  t,
}: {
  lastUpdated: Date | null;
  t: (key: string) => string;
}): React.ReactElement {
  const timeStr = lastUpdated
    ? lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--';

  return (
    <span className={styles.refreshIndicator}>
      <span className={styles.refreshDot} />
      {t('pacs.worklist.autoRefresh')} · {timeStr}
    </span>
  );
}

// ============================================================================
// Loading skeleton
// ============================================================================

function WorklistSkeleton(): React.ReactElement {
  return (
    <Stack gap="sm">
      <Group gap="md" wrap="wrap">
        <Skeleton height={56} radius="md" style={{ flex: 1, minWidth: 130 }} />
        <Skeleton height={56} radius="md" style={{ flex: 1, minWidth: 130 }} />
        <Skeleton height={56} radius="md" style={{ flex: 1, minWidth: 130 }} />
      </Group>
      <Skeleton height={44} radius="md" />
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} height={48} radius="sm" />
      ))}
    </Stack>
  );
}

// ============================================================================
// Empty states
// ============================================================================

function EmptyState({
  hasFilters,
  t,
}: {
  hasFilters: boolean;
  t: (key: string) => string;
}): React.ReactElement {
  return (
    <Box className={styles.emptyState}>
      <Box className={styles.emptyIcon}>
        <IconListDetails
          size={30}
          style={{ color: 'var(--emr-text-secondary)' }}
        />
      </Box>
      <Text size="md" fw={600} style={{ color: 'var(--emr-text-primary)' }}>
        {t(
          hasFilters ? 'pacs.worklist.emptyFiltered' : 'pacs.worklist.empty'
        )}
      </Text>
      <Text size="sm" c="dimmed" mt={6}>
        {t('pacs.worklist.emptyDescription')}
      </Text>
    </Box>
  );
}

function WorklistComplete({
  t,
}: {
  t: (key: string) => string;
}): React.ReactElement {
  return (
    <Box className={styles.emptyState}>
      <Box className={styles.completeIcon}>
        <IconCircleCheck
          size={30}
          style={{ color: 'var(--emr-success)' }}
        />
      </Box>
      <Text size="md" fw={600} style={{ color: 'var(--emr-text-primary)' }}>
        {t('pacs.worklist.complete')}
      </Text>
      <Text size="sm" c="dimmed" mt={6}>
        {t('pacs.worklist.completeDescription')}
      </Text>
    </Box>
  );
}

// ============================================================================
// Filter constants
// ============================================================================

const PRIORITY_VALUES = ['', 'stat', 'urgent', 'routine'];

const MODALITY_OPTIONS = [
  { value: '', i18nKey: '' },
  { value: 'CT', i18nKey: 'imaging.modality.ct' },
  { value: 'MR', i18nKey: 'imaging.modality.mri' },
  { value: 'XR', i18nKey: 'imaging.modality.xray' },
  { value: 'US', i18nKey: 'imaging.modality.ultrasound' },
  { value: 'MG', i18nKey: 'imaging.modality.mammography' },
  { value: 'NM', i18nKey: 'imaging.modality.nuclearMedicine' },
];

// ============================================================================
// Mobile card
// ============================================================================

interface MobileCardProps {
  item: ReadingWorklistItem;
  onClick?: () => void;
  t: (key: string) => string;
}

const MobileCard = memo(function MobileCard({
  item,
  onClick,
  t,
}: MobileCardProps): React.ReactElement {
  const priorityClass =
    item.priority === 'stat'
      ? styles.mobileCardStat
      : item.priority === 'urgent'
        ? styles.mobileCardUrgent
        : '';

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick?.();
      }
    },
    [onClick]
  );

  return (
    <Box
      className={`${styles.mobileCard} ${priorityClass}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`${item.patientName} - ${
        item.description || t('pacs.worklist.study')
      }`}
      data-testid={`worklist-row-${item.id}`}
    >
      <Group justify="space-between" wrap="wrap" gap="xs" mb="xs">
        <PriorityBadge priority={item.priority} t={t} />
        <Text
          size="sm"
          fw={600}
          style={{
            whiteSpace: 'nowrap',
            flexShrink: 0,
            color: 'var(--emr-text-primary)',
          }}
        >
          {item.patientName || '--'}
        </Text>
      </Group>

      <Group gap="xs" mb="xs" wrap="wrap">
        <ModalityChips modalities={item.modalities} bodyPart={item.bodyPart} />
        {item.description && (
          <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
            {item.description}
          </Text>
        )}
      </Group>

      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="xs" wrap="nowrap">
          <IconCalendar
            size={12}
            style={{ color: 'var(--emr-text-secondary)', flexShrink: 0 }}
          />
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {item.date ? new Date(item.date).toLocaleDateString() : '--'}
          </Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <IconClock
            size={12}
            style={{
              color: item.isOverdue
                ? 'var(--emr-error)'
                : 'var(--emr-text-secondary)',
              flexShrink: 0,
            }}
          />
          <WaitTimeCell item={item} />
        </Group>
      </Group>

      {item.orderingDoctor.name && (
        <Group gap="xs" mt="xs" wrap="nowrap">
          <IconStethoscope
            size={12}
            style={{ color: 'var(--emr-text-secondary)', flexShrink: 0 }}
          />
          <Text size="xs" c="dimmed" lineClamp={1}>
            {item.orderingDoctor.name}
          </Text>
        </Group>
      )}
    </Box>
  );
});

// ============================================================================
// Stats bar
// ============================================================================

interface StatsBarProps {
  items: ReadingWorklistItem[];
  avgWaitTime: number;
  overdueCount: number;
  t: (key: string) => string;
}

function StatsBar({
  items,
  avgWaitTime,
  overdueCount,
  t,
}: StatsBarProps): React.ReactElement | null {
  if (items.length === 0) return null;

  return (
    <div className={styles.statsBar}>
      <div className={styles.statCard}>
        <div className={`${styles.statCardIcon} ${styles.statCardIconPending}`}>
          <IconRadar size={18} />
        </div>
        <div className={styles.statCardContent}>
          <span className={styles.statCardValue}>{items.length}</span>
          <span className={styles.statCardLabel}>
            {t('pacs.worklist.stats.pending')}
          </span>
        </div>
      </div>

      <div className={styles.statCard}>
        <div className={`${styles.statCardIcon} ${styles.statCardIconTAT}`}>
          <IconClockHour4 size={18} />
        </div>
        <div className={styles.statCardContent}>
          <span className={styles.statCardValue}>
            {formatWaitTime(avgWaitTime)}
          </span>
          <span className={styles.statCardLabel}>
            {t('pacs.worklist.stats.avgTAT')}
          </span>
        </div>
      </div>

      {overdueCount > 0 && (
        <div className={`${styles.statCard} ${styles.statCardAlert}`}>
          <div className={`${styles.statCardIcon} ${styles.statCardIconOverdue}`}>
            <IconUrgent size={18} />
          </div>
          <div className={styles.statCardContent}>
            <span className={styles.statCardValue}>{overdueCount}</span>
            <span className={styles.statCardLabel}>
              {t('pacs.worklist.stats.overdue')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main
// ============================================================================

export const ReadingWorklist = memo(function ReadingWorklist({
  worklist,
  onStudyClick,
  autoAdvance: autoAdvanceProp,
  onAutoAdvanceChange,
}: ReadingWorklistProps): React.ReactElement {
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 768px)');

  // Auto-advance state — localStorage-backed fallback when uncontrolled.
  const [localAutoAdvance, setLocalAutoAdvance] = useState(
    () => localStorage.getItem('pacs-auto-advance') !== 'false'
  );
  const autoAdvance =
    autoAdvanceProp !== undefined ? autoAdvanceProp : localAutoAdvance;

  // Cross-tab sync for the auto-advance toggle.
  useEffect(() => {
    const handleStorage = (e: StorageEvent): void => {
      if (e.key === 'pacs-auto-advance' && e.newValue !== null) {
        setLocalAutoAdvance(e.newValue !== 'false');
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const handleAutoAdvanceChange = useCallback(
    (checked: boolean) => {
      setLocalAutoAdvance(checked);
      localStorage.setItem('pacs-auto-advance', String(checked));
      onAutoAdvanceChange?.(checked);
    },
    [onAutoAdvanceChange]
  );

  const {
    items,
    isLoading,
    error,
    filters,
    setFilters,
    clearFilters,
    overdueCount,
    lastUpdated,
    hasMore,
    loadMore,
    isLoadingMore,
  } = worklist;

  const [searchText, setSearchText] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const filteredItems = useMemo(() => {
    let result = items;
    if (filters.overdue) {
      result = result.filter((item) => item.isOverdue);
    }
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      result = result.filter(
        (item) =>
          (item.patientName || '').toLowerCase().includes(q) ||
          (item.accessionNumber || '').toLowerCase().includes(q) ||
          (item.description || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [items, searchText, filters.overdue]);

  const hasActiveFilters = !!(
    filters.priority?.length ||
    filters.modality?.length ||
    filters.bodyPart?.length ||
    filters.overdue ||
    searchText.trim()
  );

  const bodyPartOptions = useMemo(() => {
    const parts = new Set<string>();
    items.forEach((item) => {
      if (item.bodyPart) parts.add(item.bodyPart);
    });
    return Array.from(parts)
      .sort()
      .map((p) => ({ value: p, label: p }));
  }, [items]);

  const avgWaitTime = useMemo(() => {
    if (items.length === 0) return 0;
    const total = items.reduce((sum, item) => sum + item.waitTime, 0);
    return Math.round(total / items.length);
  }, [items]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Keyboard shortcuts — R to refresh, / to focus search.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'r' || e.key === 'R') {
        if (!containerRef.current?.contains(e.target as Node)) return;
        e.preventDefault();
        worklist.refetch();
      }
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [worklist.refetch, worklist]);

  const columns: EMRTableColumn<ReadingWorklistItem>[] = useMemo(
    () => [
      {
        key: 'priority',
        title: t('pacs.worklist.column.priority'),
        width: '110px',
        sortable: true,
        render: (row) => <PriorityBadge priority={row.priority} t={t} />,
      },
      {
        key: 'patient',
        title: t('pacs.worklist.column.patient'),
        width: '160px',
        render: (row) => (
          <Text
            size="sm"
            fw={500}
            lineClamp={1}
            style={{ minWidth: 0, color: 'var(--emr-text-primary)' }}
          >
            {row.patientName || '--'}
          </Text>
        ),
      },
      {
        key: 'accession',
        title: t('pacs.worklist.column.accession'),
        width: '130px',
        hideOnMobile: true,
        render: (row) => (
          <Text
            size="xs"
            ff="monospace"
            c="dimmed"
            lineClamp={1}
            style={{ minWidth: 0 }}
          >
            {row.accessionNumber || '--'}
          </Text>
        ),
      },
      {
        key: 'modality',
        title: t('pacs.worklist.column.studyType'),
        width: '150px',
        render: (row) => (
          <ModalityChips
            modalities={row.modalities}
            bodyPart={row.bodyPart}
          />
        ),
      },
      {
        key: 'description',
        title: t('pacs.worklist.column.description'),
        hideOnMobile: true,
        render: (row) => (
          <Text size="sm" lineClamp={1} style={{ minWidth: 0 }}>
            {row.description || '--'}
          </Text>
        ),
      },
      {
        key: 'studySize',
        title: t('pacs.worklist.column.studySize'),
        width: '80px',
        hideOnTablet: true,
        render: (row) => (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {row.seriesCount}s / {row.instanceCount}i
          </Text>
        ),
      },
      {
        key: 'date',
        title: t('pacs.worklist.column.date'),
        width: '100px',
        sortable: true,
        hideOnTablet: true,
        render: (row) => (
          <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
            {row.date ? new Date(row.date).toLocaleDateString() : '--'}
          </Text>
        ),
      },
      {
        key: 'waitTime',
        title: t('pacs.worklist.column.waitTime'),
        width: '100px',
        sortable: true,
        render: (row) => <WaitTimeCell item={row} />,
      },
      {
        key: 'orderingDoctor',
        title: t('pacs.worklist.column.orderingDoctor'),
        width: '150px',
        hideOnMobile: true,
        render: (row) => (
          <Text size="sm" lineClamp={1} style={{ minWidth: 0 }}>
            {row.orderingDoctor.name || '--'}
          </Text>
        ),
      },
      {
        key: 'priors',
        title: '',
        width: '36px',
        hideOnMobile: true,
        render: (row) =>
          row.hasPriors ? (
            <IconHistory size={14} style={{ color: 'var(--emr-accent)' }} />
          ) : null,
      },
    ],
    [t]
  );

  const handleRowClick = useCallback(
    (row: ReadingWorklistItem) => {
      onStudyClick?.(row);
    },
    [onStudyClick]
  );

  const rowLeftBorder = useCallback(
    (row: ReadingWorklistItem): string | false => {
      if (row.isOverdue) return 'var(--emr-error)';
      if (row.priority === 'stat') return 'var(--emr-error)';
      if (row.priority === 'urgent') return 'var(--emr-warning)';
      return false;
    },
    []
  );

  if (error) {
    return (
      <Box className={styles.emptyState} data-testid="reading-worklist">
        <Box className={styles.emptyIcon}>
          <IconAlertTriangle
            size={28}
            style={{ color: 'var(--emr-error)' }}
          />
        </Box>
        <Text size="md" fw={500} style={{ color: 'var(--emr-text-primary)' }}>
          {t('pacs.worklist.loadError')}
        </Text>
        <EMRButton
          variant="secondary"
          size="sm"
          onClick={worklist.refetch}
          style={{ marginTop: 12 }}
        >
          {t('common.tryAgain')}
        </EMRButton>
      </Box>
    );
  }

  return (
    <Stack gap="md" data-testid="reading-worklist" ref={containerRef}>
      <div className={styles.pageHeader}>
        <div className={styles.titleGroup}>
          <div className={styles.titleIcon}>
            <IconListDetails size={20} />
          </div>
          <span className={styles.titleText}>{t('pacs.worklist.title')}</span>
          {items.length > 0 && (
            <span className={styles.titleCount}>({items.length})</span>
          )}
          {overdueCount > 0 && (
            <span className={styles.overdueBadge}>{overdueCount}</span>
          )}
        </div>

        <div className={styles.headerRight}>
          <RefreshIndicator lastUpdated={lastUpdated} t={t} />
          <button
            className={styles.refreshButton}
            onClick={worklist.refetch}
            aria-label={t('pacs.worklist.refresh')}
            title={`${t('pacs.worklist.refresh')} (R)`}
          >
            <IconRefresh size={16} />
          </button>
        </div>
      </div>

      <StatsBar
        items={items}
        avgWaitTime={avgWaitTime}
        overdueCount={overdueCount}
        t={t}
      />

      <div className={styles.searchFilterBar}>
        <EMRTextInput
          ref={searchRef}
          size="sm"
          placeholder={`${t('pacs.worklist.search')} (/)`}
          leftSection={<IconSearch size={15} />}
          value={searchText}
          onChange={setSearchText}
          style={{ flex: 1, minWidth: 180, maxWidth: 360 }}
          fullWidth={false}
          aria-label={t('pacs.worklist.search')}
          data-testid="worklist-search"
        />

        <div className={styles.filterBar}>
          <EMRSelect
            size="xs"
            data={PRIORITY_VALUES.map((v) => ({
              value: v,
              label: v
                ? t(`pacs.priority.${v}`)
                : t('pacs.worklist.allPriorities'),
            }))}
            value={filters.priority?.[0] || ''}
            onChange={(value) =>
              setFilters({
                priority: value ? [value as ImagingPriority] : undefined,
              })
            }
            placeholder={t('pacs.worklist.filterPriority')}
            clearable={false}
            fullWidth={false}
            style={{ width: 140 }}
            aria-label={t('pacs.worklist.filterPriority')}
            data-testid="worklist-filter-priority"
          />
          <EMRSelect
            size="xs"
            data={MODALITY_OPTIONS.map((opt) => ({
              value: opt.value,
              label: opt.value
                ? t(opt.i18nKey)
                : t('pacs.worklist.allModalities'),
            }))}
            value={filters.modality?.[0] || ''}
            onChange={(value) =>
              setFilters({ modality: value ? [value] : undefined })
            }
            placeholder={t('pacs.worklist.filterModality')}
            clearable={false}
            fullWidth={false}
            style={{ width: 140 }}
            aria-label={t('pacs.worklist.filterModality')}
            data-testid="worklist-filter-modality"
          />
          {bodyPartOptions.length > 0 && (
            <EMRMultiSelect
              size="xs"
              data={bodyPartOptions}
              value={filters.bodyPart || []}
              onChange={(value) =>
                setFilters({
                  bodyPart: value.length > 0 ? value : undefined,
                })
              }
              placeholder={t('pacs.worklist.allBodyParts')}
              fullWidth={false}
              style={{ width: 160 }}
              clearable
              aria-label={t('pacs.worklist.allBodyParts')}
              data-testid="worklist-filter-bodypart"
            />
          )}

          <span
            className={`${styles.quickFilterChip} ${
              filters.priority?.[0] === 'stat'
                ? styles.quickFilterChipActive
                : ''
            }`}
            onClick={() =>
              setFilters({
                priority:
                  filters.priority?.[0] === 'stat' ? undefined : ['stat'],
              })
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setFilters({
                  priority:
                    filters.priority?.[0] === 'stat' ? undefined : ['stat'],
                });
              }
            }}
            role="button"
            tabIndex={0}
          >
            {t('pacs.worklist.stat')}
          </span>
          {overdueCount > 0 && (
            <span
              className={`${styles.quickFilterChip} ${
                filters.overdue ? styles.quickFilterChipActive : ''
              } ${styles.quickFilterChipOverdue}`}
              onClick={() => {
                setSearchText('');
                setFilters({ overdue: filters.overdue ? undefined : true });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSearchText('');
                  setFilters({
                    overdue: filters.overdue ? undefined : true,
                  });
                }
              }}
              role="button"
              tabIndex={0}
            >
              {t('pacs.worklist.overdue')} ({overdueCount})
            </span>
          )}
          {hasActiveFilters && (
            <span
              className={styles.clearFiltersLink}
              onClick={() => {
                clearFilters();
                setSearchText('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  clearFilters();
                  setSearchText('');
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={t('pacs.worklist.clearFilters')}
              data-testid="worklist-clear-filters"
            >
              {t('pacs.worklist.clearFilters')}
            </span>
          )}
        </div>
      </div>

      {isLoading && items.length === 0 ? (
        <WorklistSkeleton />
      ) : filteredItems.length === 0 && !hasActiveFilters ? (
        <WorklistComplete t={t} />
      ) : filteredItems.length === 0 ? (
        <EmptyState hasFilters={hasActiveFilters} t={t} />
      ) : isMobile ? (
        <Stack gap={0}>
          {filteredItems.map((item) => (
            <MobileCard
              key={item.id}
              item={item}
              onClick={() => onStudyClick?.(item)}
              t={t}
            />
          ))}
        </Stack>
      ) : (
        <EMRTable<ReadingWorklistItem>
          columns={columns}
          data={filteredItems}
          onRowClick={handleRowClick}
          rowLeftBorder={rowLeftBorder}
          enableKeyboardNavigation
          striped
          stickyHeader
          compact
          ariaLabel={t('pacs.worklist.tableLabel')}
          emptyState={{
            icon: IconListDetails,
            title: t('pacs.worklist.empty'),
            description: t('pacs.worklist.emptyDescription'),
          }}
        />
      )}

      {hasMore && filteredItems.length > 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: 'var(--emr-spacing-sm) 0',
          }}
        >
          <EMRButton
            variant="subtle"
            onClick={loadMore}
            loading={isLoadingMore}
            size="sm"
          >
            {t('pacs.worklist.loadMore')}
          </EMRButton>
        </div>
      )}

      <div className={styles.footerBar}>
        <div className={styles.footerHint}>
          <span className={styles.kbdHint}>R</span>
          <span>{t('pacs.worklist.refresh')}</span>
          <span style={{ margin: '0 4px', color: 'var(--emr-border-color)' }}>
            |
          </span>
          <span className={styles.kbdHint}>/</span>
          <span>{t('pacs.worklist.search')}</span>
        </div>
        <Group gap="xs" wrap="nowrap">
          <Text
            size="xs"
            c="dimmed"
            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {t('pacs.worklist.autoAdvance')}
          </Text>
          <EMRSwitch
            size="xs"
            checked={autoAdvance}
            onChange={handleAutoAdvanceChange}
            aria-label={t('pacs.worklist.autoAdvance')}
          />
        </Group>
      </div>
    </Stack>
  );
});

export default ReadingWorklist;
