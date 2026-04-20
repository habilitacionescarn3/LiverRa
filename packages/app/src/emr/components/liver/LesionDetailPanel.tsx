// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LesionDetailPanel (T219).
 *
 * Plain-English: a right-hand drawer that opens when a lesion in the list
 * is clicked. It tells the clinician everything LiverRa knows about that
 * lesion in one scrollable card: where it is, how big it is, what the AI
 * thinks it is (with the full probability spread, not just the top-pick),
 * three small slice views for context, and two reviewer actions — override
 * the classification (FR-011 edge) or mark for re-review.
 *
 * Click any segment / slice on the panel → `useViewerState().setCamera()`
 * recentres the 3D + all slice viewers on that lesion (FR-010 + FR-020).
 *
 * RUO watermark: if the `lesion_detection` claim is still research-use-only
 * or `watermarkRequired=true`, the visualization strip is burned with a
 * translucent "Research Use Only" overlay per T415 wiring.
 *
 * ARIA: the panel is `role="dialog" aria-modal="false"` — it doesn't trap
 * focus (the underlying viewer is still interactive) but SR users still
 * announce it as a named dialog.
 *
 * Spec refs: T219, FR-010, FR-011, FR-020, T415 (RUO wiring).
 */

import { Box, Group, Stack, Text } from '@mantine/core';
import { useCallback, useMemo } from 'react';

import { useRUOClaim } from '../../contexts/RUOClaimRegistryContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { useViewerState, type ViewerCamera } from '../../contexts/ViewerStateContext';
import { EMRButton } from '../common';

import { LesionBadge } from './LesionBadge';
import styles from './LesionDetailPanel.module.css';
import { LESION_CLASS_ORDER, LESION_MALIGNANCY, type BBox3D, type LesionUI } from './types';

export interface LesionDetailPanelProps {
  lesion: LesionUI;
  /** Close button click handler. */
  onClose: () => void;
  /** Fires when the reviewer clicks "Override classification" (Phase 6 — T238). */
  onOverride?: (lesion: LesionUI) => void;
  /** Fires when the reviewer clicks "Mark for re-review". */
  onReReview?: (lesion: LesionUI) => void;
  /** Test hook. */
  'data-testid'?: string;
}

function cameraForBbox(bbox: BBox3D): ViewerCamera {
  const [x0, y0, z0, x1, y1, z1] = bbox;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  const diag =
    Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2) || 50;
  const offset = Math.max(80, diag * 2.5);
  return {
    position: [cx, cy, cz + offset],
    target: [cx, cy, cz],
    up: [0, -1, 0],
    zoom: 1,
  };
}

export function LesionDetailPanel({
  lesion,
  onClose,
  onOverride,
  onReReview,
  'data-testid': testId = 'lesion-detail',
}: LesionDetailPanelProps): JSX.Element {
  const { t } = useTranslation();
  const { setCamera } = useViewerState();
  const detectionClaim = useRUOClaim('lesion_detection');
  const watermarkRequired = detectionClaim.watermarkRequired;

  const headingId = useMemo(() => `lesion-detail-heading-${lesion.id}`, [lesion.id]);

  const recenter = useCallback(() => {
    setCamera(cameraForBbox(lesion.bbox3d));
  }, [setCamera, lesion.bbox3d]);

  const segmentLabel =
    lesion.couinaudLocation === 'multi_segment'
      ? t('lesions:detail.location.multiSegment')
      : lesion.locationLabel;

  const suggestedKey = lesion.suggestedClass;
  const highestClass = suggestedKey;
  const isBenignHighlight =
    highestClass && LESION_MALIGNANCY[highestClass] === 'benign';

  return (
    <Box
      className={styles.root}
      role="dialog"
      aria-labelledby={headingId}
      aria-modal="false"
      data-testid={testId}
    >
      {/* Header */}
      <Box className={styles.header}>
        <Group gap="sm" wrap="wrap" style={{ minWidth: 0 }}>
          <Text id={headingId} className={styles.headerTitle}>
            {t('lesions:detail.heading', { index: lesion.index })}
          </Text>
          <LesionBadge
            classValue={lesion.suggestedClass}
            confidence={lesion.confidence}
            override={lesion.reviewerOverride}
            compact
            data-testid={`${testId}-badge`}
          />
        </Group>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('lesions:detail.close')}
          className={styles.closeBtn}
          data-testid={`${testId}-close`}
        >
          <span aria-hidden="true">×</span>
        </button>
      </Box>

      {/* Body */}
      <Box className={styles.body}>
        {/* Location */}
        <section className={styles.section} aria-labelledby={`${testId}-loc-title`}>
          <h3 id={`${testId}-loc-title`} className={styles.sectionTitle}>
            {t('lesions:detail.sections.location')}
          </h3>
          <Box className={styles.kvRow}>
            <span className={styles.kvKey}>{t('lesions:detail.location.segment')}</span>
            <button
              type="button"
              onClick={recenter}
              className={styles.kvValue}
              style={{
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                textDecoration: 'underline',
                color: 'var(--emr-accent)',
              }}
              aria-label={`${t('lesions:detail.location.segment')}: ${segmentLabel}`}
              data-testid={`${testId}-segment`}
            >
              {segmentLabel}
            </button>
          </Box>
        </section>

        {/* Size */}
        <section className={styles.section} aria-labelledby={`${testId}-size-title`}>
          <h3 id={`${testId}-size-title`} className={styles.sectionTitle}>
            {t('lesions:detail.sections.size')}
          </h3>
          {lesion.axialDiameterMm !== undefined && (
            <Box className={styles.kvRow}>
              <span className={styles.kvKey}>{t('lesions:detail.size.axial')}</span>
              <span className={styles.kvValue}>
                {lesion.axialDiameterMm.toFixed(1)} {t('lesions:detail.size.mm')}
              </span>
            </Box>
          )}
          {lesion.coronalDiameterMm !== undefined && (
            <Box className={styles.kvRow}>
              <span className={styles.kvKey}>{t('lesions:detail.size.coronal')}</span>
              <span className={styles.kvValue}>
                {lesion.coronalDiameterMm.toFixed(1)} {t('lesions:detail.size.mm')}
              </span>
            </Box>
          )}
          {lesion.sagittalDiameterMm !== undefined && (
            <Box className={styles.kvRow}>
              <span className={styles.kvKey}>{t('lesions:detail.size.sagittal')}</span>
              <span className={styles.kvValue}>
                {lesion.sagittalDiameterMm.toFixed(1)} {t('lesions:detail.size.mm')}
              </span>
            </Box>
          )}
          <Box className={styles.kvRow}>
            <span className={styles.kvKey}>{t('lesions:detail.size.volume')}</span>
            <span className={styles.kvValue}>
              {lesion.volumeMl.toFixed(2)} {t('lesions:detail.size.ml')}
            </span>
          </Box>
        </section>

        {/* Classification (probability distribution) */}
        <section className={styles.section} aria-labelledby={`${testId}-class-title`}>
          <h3 id={`${testId}-class-title`} className={styles.sectionTitle}>
            {t('lesions:detail.sections.classification')}
          </h3>
          {suggestedKey === null && (
            <Text fz="xs" c="dimmed">
              {t('lesions:detail.classification.abstained', {
                threshold: lesion.abstentionThreshold.toFixed(2),
              })}
            </Text>
          )}
          <ul
            className={styles.distList}
            aria-label={t('lesions:detail.classification.distribution')}
          >
            {LESION_CLASS_ORDER.map((cls) => {
              const prob = lesion.confidenceVector[cls] ?? 0;
              const pct = Math.round(prob * 100);
              const isTop = cls === highestClass;
              const fillCls = isTop
                ? isBenignHighlight
                  ? styles.distFillHighlightBenign
                  : styles.distFillHighlight
                : '';
              return (
                <li key={cls} className={styles.distItem}>
                  <span className={styles.distLabel}>
                    {t(`lesions:classes.${cls}.name`)}
                  </span>
                  <Box
                    className={styles.distTrack}
                    role="progressbar"
                    aria-label={t(`lesions:classes.${cls}.long`)}
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <Box
                      className={[styles.distFill, fillCls].filter(Boolean).join(' ')}
                      style={{ width: `${pct}%` }}
                    />
                  </Box>
                  <span className={styles.distValue}>{pct}%</span>
                </li>
              );
            })}
          </ul>
          <Text fz="xs" c="dimmed">
            {t('lesions:detail.classification.temperature', {
              value: lesion.temperatureApplied.toFixed(2),
            })}
          </Text>
        </section>

        {/* Visualization strip */}
        <section className={styles.section} aria-labelledby={`${testId}-vis-title`}>
          <h3 id={`${testId}-vis-title`} className={styles.sectionTitle}>
            {t('lesions:detail.sections.visualization')}
          </h3>
          <Box className={styles.visStrip}>
            {(['axial', 'coronal', 'sagittal'] as const).map((plane) => (
              <button
                type="button"
                key={plane}
                onClick={recenter}
                className={styles.visTile}
                aria-label={`${t(`lesions:detail.visualization.${plane}`)} — ${segmentLabel}`}
                data-testid={`${testId}-plane-${plane}`}
              >
                <span className={styles.visTileLabel}>
                  {t(`lesions:detail.visualization.${plane}`)}
                </span>
                {watermarkRequired && (
                  <span className={styles.watermark} aria-hidden="true">
                    {t('lesions:detail.visualization.watermark')}
                  </span>
                )}
              </button>
            ))}
          </Box>
        </section>
      </Box>

      {/* Actions */}
      <Box className={styles.actions}>
        <Stack gap={4}>
          <EMRButton
            fullWidth
            variant="outline"
            onClick={() => onOverride?.(lesion)}
            data-testid={`${testId}-override`}
            disabled={!onOverride}
          >
            {t('lesions:detail.actions.override')}
          </EMRButton>
          <Text className={styles.actionHelp}>
            {t('lesions:detail.actions.overrideHelp')}
          </Text>
        </Stack>
        <Stack gap={4}>
          <EMRButton
            fullWidth
            variant="subtle"
            onClick={() => onReReview?.(lesion)}
            data-testid={`${testId}-rereview`}
            disabled={!onReReview}
          >
            {t('lesions:detail.actions.reReview')}
          </EMRButton>
          <Text className={styles.actionHelp}>
            {t('lesions:detail.actions.reReviewHelp')}
          </Text>
        </Stack>
      </Box>
    </Box>
  );
}

export default LesionDetailPanel;
