// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// StudyList (LiverRa)
// ============================================================================
// Patient imaging studies table. Columns: Date, Accession, Modality, Body
// Part, Description, Images, Status, Findings, Source, Actions. Includes
// color-coded status badges, a findings popover, a pending-orders section,
// loading skeletons, an empty state, and a mobile-card fallback below 768px.
//
// Ported from MediMind with two adaptations:
//   1. `EMRTable` (961 LOC in MediMind) is not ported to LiverRa yet;
//      we use the local `LiverraPacsTable` shim that covers the props
//      this component actually reaches for.
//   2. `StudyCardGrid` is kept as the full-width card-grid mode.
// ============================================================================

import React, { memo, useState, useMemo, useCallback } from 'react';
import { Box, Group, Text, Stack, Skeleton, Popover } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconPhoto,
  IconCalendar,
  IconEye,
  IconColumns,
  IconFileText,
  IconFileCheck,
} from '@tabler/icons-react';
import { EMRTable, type EMRTableColumn } from './LiverraPacsTable';
import { useTranslation } from '../../contexts/TranslationContext';
import { toLocaleDateForPacs } from '../../services/pacs/dateFormatHelpers';
import type { Locale } from '../../services/localeService';
import type {
  ImagingStudyListItem,
  ImagingStudyStatus,
} from '../../types/pacs';
import { StatusTimelinePopover } from './StatusTimelinePopover';
import { StudyCardGrid } from './StudyCardGrid';
import styles from './StudyList.module.css';

// ============================================================================
// Props
// ============================================================================

interface StudyListProps {
  /** Studies to display (may include pending orders merged in). */
  studies: ImagingStudyListItem[];
  /** Loading flag. */
  loading: boolean;
  /** Row clicked → open viewer. */
  onStudyClick?: (study: ImagingStudyListItem) => void;
  /** Pending-order row clicked → open order details. */
  onOrderClick?: (orderRef: string) => void;
  /** "Compare" button clicked → open side-by-side view. */
  onCompareClick?: (study: ImagingStudyListItem) => void;
  /** Error to render inline. */
  error?: Error | null;
  /** Currently selected study id (row gets the accent border). */
  activeStudyId?: string;
  /** Slim mode: only show essential columns (used in narrow drawers). */
  compact?: boolean;
  /** `'table'` (default) or `'cards'`. */
  viewMode?: 'table' | 'cards';
}

// ============================================================================
// Status badge
// ============================================================================

const STATUS_STYLE_MAP: Record<ImagingStudyStatus, string> = {
  ordered: styles.statusOrdered,
  scheduled: styles.statusScheduled,
  'in-progress': styles.statusInProgress,
  'images-available': styles.statusImagesAvailable,
  'preliminary-read': styles.statusPreliminaryRead,
  reported: styles.statusReported,
};

const STATUS_LABEL_MAP: Record<ImagingStudyStatus, string> = {
  ordered: 'pacs.status.ordered',
  scheduled: 'pacs.status.scheduled',
  'in-progress': 'pacs.status.inProgress',
  'images-available': 'pacs.status.imagesAvailable',
  'preliminary-read': 'pacs.status.preliminaryRead',
  reported: 'pacs.status.reported',
};

export function StudyStatusBadge({
  status,
  t,
}: {
  status: ImagingStudyStatus;
  t: (key: string) => string;
}): React.ReactElement {
  const className = STATUS_STYLE_MAP[status] || styles.statusOrdered;
  const labelKey = STATUS_LABEL_MAP[status] || 'pacs.status.ordered';
  return (
    <span className={`${styles.statusBadge} ${className}`}>{t(labelKey)}</span>
  );
}

// ============================================================================
// Source badge — PACS / local upload / order
// ============================================================================

export function SourceBadge({
  study,
  t,
}: {
  study: ImagingStudyListItem;
  t: (key: string) => string;
}): React.ReactElement {
  const source =
    study.source ||
    (study.orthancStudyId
      ? 'pacs'
      : study.orderRef
        ? 'order'
        : 'local-upload');

  if (source === 'pacs') {
    return (
      <span className={`${styles.sourceBadge} ${styles.sourcePacs}`}>
        {t('pacs.source.pacs')}
      </span>
    );
  }
  if (source === 'local-upload') {
    return (
      <span className={`${styles.sourceBadge} ${styles.sourceLocal}`}>
        {t('pacs.source.localUpload')}
      </span>
    );
  }
  return (
    <span className={`${styles.sourceBadge} ${styles.sourceOrder}`}>
      {t('pacs.source.order')}
    </span>
  );
}

// ============================================================================
// Modality chips
// ============================================================================

export function ModalityChips({
  modalities,
}: {
  modalities: string[];
}): React.ReactElement {
  if (modalities.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Group gap={4} wrap="wrap">
      {modalities.map((mod) => (
        <span key={mod} className={styles.modalityChip}>
          {mod}
        </span>
      ))}
    </Group>
  );
}

// ============================================================================
// Status + priority group
// ============================================================================

function StatusWithPriority({
  study,
  t,
}: {
  study: ImagingStudyListItem;
  t: (key: string) => string;
}): React.ReactElement {
  if (study.timeline && study.timeline.length > 0) {
    return <StatusTimelinePopover study={study} />;
  }
  return (
    <span className={styles.statusGroup}>
      <StudyStatusBadge status={study.status} t={t} />
      {study.priority === 'stat' && (
        <span className={styles.priorityBadgeStat}>
          {t('pacs.priority.stat')}
        </span>
      )}
      {study.priority === 'urgent' && (
        <span className={styles.priorityBadgeUrgent}>
          {t('pacs.priority.urgent')}
        </span>
      )}
    </span>
  );
}

// ============================================================================
// Findings indicator + popover
// ============================================================================

export function FindingsIndicator({
  study,
  t,
}: {
  study: ImagingStudyListItem;
  t: (key: string) => string;
}): React.ReactElement | null {
  const [opened, setOpened] = useState(false);

  if (!study.hasFindings || !study.findingsText) {
    return null;
  }

  const isPreliminary = study.reportStatus === 'preliminary';

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={400}
      position="bottom-start"
      withArrow
      shadow="md"
    >
      <Popover.Target>
        <span
          className={styles.findingsIndicator}
          onClick={(e) => {
            e.stopPropagation();
            setOpened((o) => !o);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              setOpened((o) => !o);
            }
          }}
          aria-label={t('pacs.findings.viewFindings')}
          aria-expanded={opened}
          aria-haspopup="true"
          data-testid={`findings-indicator-${study.id}`}
        >
          {isPreliminary ? (
            <IconFileText size={16} style={{ color: 'var(--emr-warning)' }} />
          ) : (
            <IconFileCheck size={16} style={{ color: 'var(--emr-success)' }} />
          )}
          <span
            className={`${styles.reportBadge} ${
              isPreliminary ? styles.reportPreliminary : styles.reportFinal
            }`}
          >
            {isPreliminary
              ? t('pacs.findings.preliminary')
              : t('pacs.findings.final')}
          </span>
        </span>
      </Popover.Target>
      <Popover.Dropdown>
        <div className={styles.findingsPopoverContent}>
          <div className={styles.findingsPopoverHeader}>
            <Text size="sm" fw={600}>
              {t('pacs.findings.reportTitle')}
            </Text>
            <span
              className={`${styles.reportBadge} ${
                isPreliminary ? styles.reportPreliminary : styles.reportFinal
              }`}
            >
              {isPreliminary
                ? t('pacs.findings.preliminary')
                : t('pacs.findings.final')}
            </span>
          </div>
          <div className={styles.findingsFullText}>{study.findingsText}</div>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

// ============================================================================
// Loading skeleton
// ============================================================================

function StudyListSkeleton(): React.ReactElement {
  return (
    <Stack gap="xs">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} height={48} radius="sm" />
      ))}
    </Stack>
  );
}

// ============================================================================
// Empty state
// ============================================================================

function EmptyState({
  t,
}: {
  t: (key: string) => string;
}): React.ReactElement {
  return (
    <Box className={styles.emptyState}>
      <Box className={styles.emptyIcon}>
        <IconPhoto size={28} style={{ color: 'var(--emr-text-secondary)' }} />
      </Box>
      <Text size="md" fw={500} style={{ color: 'var(--emr-text-primary)' }}>
        {t('pacs.noStudies')}
      </Text>
      <Text size="sm" c="dimmed" mt={4}>
        {t('pacs.noStudiesDescription')}
      </Text>
    </Box>
  );
}

// ============================================================================
// Mobile card
// ============================================================================

interface MobileCardProps {
  study: ImagingStudyListItem;
  onClick?: () => void;
  t: (key: string) => string;
  locale: Locale;
}

const MobileCard = memo(function MobileCard({
  study,
  onClick,
  t,
  locale,
}: MobileCardProps): React.ReactElement {
  const isPending = !study.orthancStudyId;
  const cardClassName = `${styles.mobileCard}${
    isPending ? ` ${styles.pendingRow}` : ''
  }`;

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
      className={cardClassName}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`${study.description || t('pacs.imagingOrder')} - ${toLocaleDateForPacs(study.date, locale)}`}
    >
      <Group justify="space-between" wrap="wrap" gap="xs" mb="xs">
        <Group gap="xs" wrap="nowrap">
          <IconCalendar
            size={14}
            style={{ color: 'var(--emr-text-secondary)', flexShrink: 0 }}
          />
          <Text
            size="sm"
            fw={500}
            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {study.date ? toLocaleDateForPacs(study.date, locale) : '—'}
          </Text>
        </Group>
        <StatusWithPriority study={study} t={t} />
      </Group>

      <Group gap="xs" mb="xs" wrap="wrap">
        <ModalityChips modalities={study.modalities} />
        {study.bodyPart && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {study.bodyPart}
          </Text>
        )}
      </Group>

      {study.description && (
        <Text size="xs" c="dimmed" lineClamp={2} mb="xs">
          {study.description}
        </Text>
      )}

      {study.hasFindings && study.findingsText && (
        <Group gap={4} mb="xs" align="center">
          {study.reportStatus === 'preliminary' ? (
            <IconFileText
              size={14}
              style={{ color: 'var(--emr-warning)', flexShrink: 0 }}
            />
          ) : (
            <IconFileCheck
              size={14}
              style={{ color: 'var(--emr-success)', flexShrink: 0 }}
            />
          )}
          <span
            className={`${styles.reportBadge} ${
              study.reportStatus === 'preliminary'
                ? styles.reportPreliminary
                : styles.reportFinal
            }`}
          >
            {study.reportStatus === 'preliminary'
              ? t('pacs.findings.preliminary')
              : t('pacs.findings.final')}
          </span>
          <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
            {study.findingsText.length > 100
              ? study.findingsText.slice(0, 100) + '\u2026'
              : study.findingsText}
          </Text>
        </Group>
      )}

      <Group justify="space-between" wrap="wrap" gap="xs">
        <Text size="xs" c="dimmed">
          {study.instanceCount} {t('pacs.images')} · {study.seriesCount}{' '}
          {t('pacs.series')}
        </Text>
        <Group gap="xs" wrap="nowrap">
          <SourceBadge study={study} t={t} />
          {!isPending && (
            <IconEye
              size={16}
              style={{ color: 'var(--emr-accent)', flexShrink: 0 }}
            />
          )}
        </Group>
      </Group>
    </Box>
  );
});

// ============================================================================
// Main
// ============================================================================

export const StudyList = memo(function StudyList({
  studies,
  loading,
  onStudyClick,
  onOrderClick,
  onCompareClick,
  error,
  activeStudyId,
  compact = false,
  viewMode = 'table',
}: StudyListProps): React.ReactElement {
  const { t, locale } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 768px)');

  const studiesWithImages = useMemo(
    () => studies.filter((s) => !!s.orthancStudyId).length,
    [studies]
  );

  // Compact columns — narrow-panel layout.
  const compactColumns: EMRTableColumn<ImagingStudyListItem>[] = useMemo(
    () => [
      {
        key: 'date',
        title: t('pacs.column.date'),
        width: '90px',
        sortable: true,
        render: (row) => (
          <Text size="xs" style={{ whiteSpace: 'nowrap' }}>
            {row.date ? toLocaleDateForPacs(row.date, locale) : '—'}
          </Text>
        ),
      },
      {
        key: 'modality',
        title: t('pacs.column.modality'),
        width: '70px',
        render: (row) => <ModalityChips modalities={row.modalities} />,
      },
      {
        key: 'bodyPart',
        title: t('pacs.column.bodyPart'),
        render: (row) => (
          <Text size="xs" lineClamp={1} style={{ minWidth: 0 }}>
            {row.bodyPart || '—'}
          </Text>
        ),
      },
      {
        key: 'actions',
        title: '',
        width: '44px',
        align: 'center',
        render: (row) => {
          if (row.orthancStudyId) {
            return (
              <button
                className={styles.viewButton}
                onClick={(e) => {
                  e.stopPropagation();
                  onStudyClick?.(row);
                }}
                aria-label={t('pacs.viewStudy')}
                title={t('pacs.viewStudy')}
              >
                <IconEye size={16} />
              </button>
            );
          }
          return null;
        },
      },
    ],
    [t, onStudyClick, locale]
  );

  // Full columns
  const columns: EMRTableColumn<ImagingStudyListItem>[] = useMemo(
    () => [
      {
        key: 'date',
        title: t('pacs.column.date'),
        width: '120px',
        sortable: true,
        render: (row) => (
          <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
            {row.date ? toLocaleDateForPacs(row.date, locale) : '—'}
          </Text>
        ),
      },
      {
        key: 'accession',
        title: t('pacs.column.accession'),
        width: '150px',
        hideOnMobile: true,
        render: (row) => (
          <Text
            size="sm"
            style={{
              whiteSpace: 'nowrap',
              fontFamily: 'monospace',
              fontSize: 'var(--emr-font-xs)',
            }}
          >
            {row.accessionNumber || '—'}
          </Text>
        ),
      },
      {
        key: 'modality',
        title: t('pacs.column.modality'),
        width: '100px',
        render: (row) => <ModalityChips modalities={row.modalities} />,
      },
      {
        key: 'bodyPart',
        title: t('pacs.column.bodyPart'),
        width: '120px',
        hideOnMobile: true,
        render: (row) => <Text size="sm">{row.bodyPart || '—'}</Text>,
      },
      {
        key: 'description',
        title: t('pacs.column.description'),
        hideOnMobile: true,
        render: (row) => (
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" lineClamp={1}>
              {row.description || '—'}
            </Text>
            {row.hasFindings && row.findingsText && (
              <Text
                size="xs"
                c="dimmed"
                lineClamp={1}
                className={styles.findingsPreview}
              >
                {row.findingsText.length > 100
                  ? row.findingsText.slice(0, 100) + '\u2026'
                  : row.findingsText}
              </Text>
            )}
          </Stack>
        ),
      },
      {
        key: 'images',
        title: t('pacs.column.images'),
        width: '80px',
        align: 'center',
        hideOnTablet: true,
        render: (row) => <Text size="sm">{row.instanceCount}</Text>,
      },
      {
        key: 'status',
        title: t('pacs.column.status'),
        width: '180px',
        render: (row) => <StatusWithPriority study={row} t={t} />,
      },
      {
        key: 'findings',
        title: t('pacs.column.findings'),
        width: '120px',
        hideOnTablet: true,
        render: (row) => <FindingsIndicator study={row} t={t} />,
      },
      {
        key: 'source',
        title: t('pacs.column.source'),
        width: '90px',
        hideOnTablet: true,
        render: (row) => <SourceBadge study={row} t={t} />,
      },
      {
        key: 'actions',
        title: '',
        width: studiesWithImages >= 2 ? '90px' : '48px',
        align: 'center',
        render: (row) => {
          if (row.orthancStudyId) {
            return (
              <Group gap={4} wrap="nowrap" justify="center">
                <button
                  className={styles.viewButton}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStudyClick?.(row);
                  }}
                  aria-label={t('pacs.viewStudy')}
                  title={t('pacs.viewStudy')}
                >
                  <IconEye size={18} />
                </button>
                {studiesWithImages >= 2 && onCompareClick && (
                  <button
                    className={styles.viewButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCompareClick(row);
                    }}
                    aria-label={t('pacs.comparison.compareStudy')}
                    title={t('pacs.comparison.compare')}
                    data-testid={`compare-btn-${row.id}`}
                  >
                    <IconColumns size={18} />
                  </button>
                )}
              </Group>
            );
          }
          return null;
        },
      },
    ],
    [t, onStudyClick, onCompareClick, studiesWithImages, locale]
  );

  // Row click — dispatch based on source.
  const handleRowClick = useCallback(
    (row: ImagingStudyListItem) => {
      if (row.orthancStudyId) {
        onStudyClick?.(row);
      } else if (
        row.source === 'local-upload' ||
        (!row.orthancStudyId && !row.orderRef)
      ) {
        onStudyClick?.(row);
      } else if (row.orderRef) {
        onOrderClick?.(row.orderRef);
      }
    },
    [onStudyClick, onOrderClick]
  );

  const rowLeftBorder = useCallback(
    (row: ImagingStudyListItem): string | false => {
      if (activeStudyId && row.id === activeStudyId) return 'var(--emr-accent)';
      if (row.priority === 'stat') return 'var(--emr-error)';
      if (row.priority === 'urgent') return 'var(--emr-warning)';
      if (row.source === 'local-upload') return 'var(--emr-info)';
      if (row.source === 'order' || !row.orthancStudyId) return 'var(--emr-warning)';
      return false;
    },
    [activeStudyId]
  );

  const handleMobileClick = useCallback(
    (study: ImagingStudyListItem) => {
      if (study.orthancStudyId) {
        onStudyClick?.(study);
      } else if (
        study.source === 'local-upload' ||
        (!study.orthancStudyId && !study.orderRef)
      ) {
        onStudyClick?.(study);
      } else if (study.orderRef) {
        onOrderClick?.(study.orderRef);
      }
    },
    [onStudyClick, onOrderClick]
  );

  if (error) {
    return (
      <Box className={styles.emptyState}>
        <Text size="sm" c="red">
          {t('pacs.loadError')}
        </Text>
      </Box>
    );
  }

  if (loading) {
    return <StudyListSkeleton />;
  }

  return (
    <Stack gap="md">
      {studies.length === 0 ? (
        <EmptyState t={t} />
      ) : isMobile && !compact ? (
        <Stack gap={0}>
          {studies.map((study) => (
            <MobileCard
              key={study.id}
              study={study}
              onClick={() => handleMobileClick(study)}
              t={t}
              locale={locale}
            />
          ))}
        </Stack>
      ) : viewMode === 'cards' && !compact ? (
        <StudyCardGrid
          studies={studies}
          onStudyClick={onStudyClick}
          onCompareClick={onCompareClick}
          activeStudyId={activeStudyId}
          studiesWithImages={studiesWithImages}
        />
      ) : (
        <EMRTable<ImagingStudyListItem>
          columns={compact ? compactColumns : columns}
          data={studies}
          onRowClick={handleRowClick}
          rowLeftBorder={rowLeftBorder}
          enableKeyboardNavigation
          striped
          stickyHeader
          compact
          ariaLabel={t('pacs.studyListLabel')}
          emptyState={{
            icon: IconPhoto,
            title: t('pacs.noStudies'),
            description: t('pacs.noStudiesDescription'),
          }}
        />
      )}
    </Stack>
  );
});

export default StudyList;
