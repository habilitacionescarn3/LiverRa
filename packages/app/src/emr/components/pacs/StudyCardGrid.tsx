// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// StudyCardGrid (LiverRa)
// ============================================================================
// Horizontal single-row card layout for imaging studies — one card per study,
// six zones (modality icon → info → body part → image count → badges →
// actions). Used in full-width mode only; the narrow drawer falls back to
// the compact table.
//
// Ported from MediMind verbatim. No Medplum dependency.
// ============================================================================

import React, { memo, useCallback } from 'react';
import { IconPhoto, IconEye, IconColumns } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import type { ImagingStudyListItem } from '../../types/pacs';
import {
  StudyStatusBadge,
  SourceBadge,
  ModalityChips,
  FindingsIndicator,
} from './StudyList';
import styles from './StudyCardGrid.module.css';

// ============================================================================
// Props
// ============================================================================

interface StudyCardGridProps {
  studies: ImagingStudyListItem[];
  onStudyClick?: (study: ImagingStudyListItem) => void;
  onCompareClick?: (study: ImagingStudyListItem) => void;
  activeStudyId?: string;
  studiesWithImages: number;
}

// ============================================================================
// Card
// ============================================================================

interface StudyCardProps {
  study: ImagingStudyListItem;
  index: number;
  onClick?: () => void;
  onCompare?: (e: React.MouseEvent) => void;
  isSelected: boolean;
  showCompare: boolean;
  t: (key: string) => string;
}

function getModalityLabel(modalities: string[]): string {
  if (!modalities.length) return '—';
  const first = modalities[0];
  return modalities.length > 1 ? `${first}+` : first;
}

const StudyCard = memo(function StudyCard({
  study,
  index,
  onClick,
  onCompare,
  isSelected,
  showCompare,
  t,
}: StudyCardProps): React.ReactElement {
  const isPending = !study.orthancStudyId;

  const classNames = [
    styles.card,
    styles.animated,
    styles[`delay${Math.min(index, 9)}` as keyof typeof styles],
    isSelected && styles.selected,
    study.priority === 'stat' && styles.priorityStat,
    study.priority === 'urgent' && styles.priorityUrgent,
    isPending && styles.pendingCard,
  ]
    .filter(Boolean)
    .join(' ');

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
    <div
      className={classNames}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`${study.description || t('pacs.imagingOrder')} - ${
        study.date ? new Date(study.date).toLocaleDateString() : ''
      }`}
    >
      {/* Zone 1 — modality icon */}
      <div className={styles.modalityIcon}>
        <span>{getModalityLabel(study.modalities)}</span>
      </div>

      {/* Zone 2 — description + date */}
      <div className={styles.infoZone}>
        <p className={styles.cardDescription}>
          {study.description || t('pacs.imagingOrder')}
        </p>
        <p className={styles.cardDate}>
          {study.date ? new Date(study.date).toLocaleDateString() : '—'}
        </p>
      </div>

      {/* Zone 3 — body part (hidden on tablet via CSS) */}
      {study.bodyPart && (
        <span className={styles.bodyPart}>{study.bodyPart}</span>
      )}

      {/* Zone 4 — image count */}
      <div className={styles.imageCount}>
        <IconPhoto size={14} />
        <span className={styles.imageCountValue}>{study.instanceCount}</span>
      </div>

      {/* Zone 5 — status + priority + source badges */}
      <div className={styles.badgeZone}>
        <StudyStatusBadge status={study.status} t={t} />
        {study.priority === 'stat' && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '1px 6px',
              borderRadius: 4,
              fontSize: 'var(--emr-font-xs)',
              fontWeight: 'var(--emr-font-bold)',
              background: 'var(--emr-error-alpha-12)',
              color: 'var(--emr-error)',
              whiteSpace: 'nowrap',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            {t('pacs.priority.stat')}
          </span>
        )}
        {study.priority === 'urgent' && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '1px 6px',
              borderRadius: 4,
              fontSize: 'var(--emr-font-xs)',
              fontWeight: 'var(--emr-font-semibold)',
              background: 'var(--emr-warning-alpha-12)',
              color: 'var(--emr-warning)',
              whiteSpace: 'nowrap',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            {t('pacs.priority.urgent')}
          </span>
        )}
        <SourceBadge study={study} t={t} />
      </div>

      {/* Zone 6 — findings + view + compare */}
      <div className={styles.actionZone}>
        <FindingsIndicator study={study} t={t} />
        {!isPending && (
          <button
            className={styles.actionBtn}
            onClick={(e) => {
              e.stopPropagation();
              onClick?.();
            }}
            aria-label={t('pacs.viewStudy')}
            title={t('pacs.viewStudy')}
          >
            <IconEye size={18} />
          </button>
        )}
        {showCompare && !isPending && onCompare && (
          <button
            className={styles.actionBtn}
            onClick={(e) => {
              e.stopPropagation();
              onCompare(e);
            }}
            aria-label={t('pacs.comparison.compareStudy')}
            title={t('pacs.comparison.compare')}
            data-testid={`compare-btn-${study.id}`}
          >
            <IconColumns size={18} />
          </button>
        )}
      </div>
    </div>
  );
});

// ============================================================================
// Grid
// ============================================================================

export const StudyCardGrid = memo(function StudyCardGrid({
  studies,
  onStudyClick,
  onCompareClick,
  activeStudyId,
  studiesWithImages,
}: StudyCardGridProps): React.ReactElement {
  const { t } = useTranslation();

  const handleClick = useCallback(
    (study: ImagingStudyListItem) => {
      onStudyClick?.(study);
    },
    [onStudyClick]
  );

  const handleCompare = useCallback(
    (study: ImagingStudyListItem) => {
      onCompareClick?.(study);
    },
    [onCompareClick]
  );

  return (
    <div className={styles.grid}>
      {studies.map((study, index) => (
        <StudyCard
          key={study.id}
          study={study}
          index={index}
          onClick={() => handleClick(study)}
          onCompare={onCompareClick ? () => handleCompare(study) : undefined}
          isSelected={activeStudyId === study.id}
          showCompare={studiesWithImages >= 2}
          t={t}
        />
      ))}
    </div>
  );
});

export default StudyCardGrid;
