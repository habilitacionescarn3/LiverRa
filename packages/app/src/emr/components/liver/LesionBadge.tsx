// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LesionBadge (T218).
 *
 * Plain-English: a small coloured pill you see next to every lesion telling
 * you what the AI thinks it is (HCC, MET, cyst, …), paired with a confidence
 * bar that shows how sure the AI is. Think of it as the product-tag on a
 * grocery shelf: "Organic" + a freshness rating. It has three visual
 * families:
 *
 *   1. Malignant classes (HCC / ICC / MET) → red pill (uses
 *      `--liverra-lesion-marker`).
 *   2. Benign classes (FNH / HEM / CYST) → green pill (uses
 *      `--liverra-lesion-benign`).
 *   3. Abstention state — the AI wasn't sure enough (FR-011) → gray + italic
 *      + dashed border + "Uncertain — radiologist review recommended"
 *      tooltip.
 *
 * When the RUO claim for `lesion_classification` is still RUO (not yet CE
 * cleared), we append "(AI suggestion)" so the clinician never forgets
 * this is not a diagnosis.
 *
 * Spec refs: FR-010, FR-011, FR-020; task T218 + T415 (RUO wiring).
 */

import { Box, Text, Tooltip } from '@mantine/core';
import { useMemo } from 'react';

import { useRUOClaim } from '../../contexts/RUOClaimRegistryContext';
import { useTranslation } from '../../contexts/TranslationContext';

import styles from './LesionBadge.module.css';
import { LESION_MALIGNANCY, type LesionClass } from './types';

export interface LesionBadgeProps {
  /** `null` means the AI abstained — renders the "Uncertain" state per FR-011. */
  classValue: LesionClass | null;
  /** Confidence in [0, 1]. Ignored when `classValue === null`. */
  confidence: number | null;
  /** If set, renders an override-ring and uses the override class. */
  override?: { classValue: LesionClass };
  /** Render without the confidence bar (e.g. inside a tight table cell). */
  compact?: boolean;
  /** Test hook for e2e / unit coverage. */
  'data-testid'?: string;
}

/** CSS class for the pill colour family. */
function pillVariantClass(classValue: LesionClass | null): string {
  if (classValue === null) return styles.abstained;
  return LESION_MALIGNANCY[classValue] === 'malignant' ? styles.malignant : styles.benign;
}

/** CSS class for the confidence bar fill colour. */
function barVariantClass(classValue: LesionClass | null): string {
  if (classValue === null) return styles.barFillAbstained;
  return LESION_MALIGNANCY[classValue] === 'malignant'
    ? styles.barFillMalignant
    : styles.barFillBenign;
}

export function LesionBadge({
  classValue,
  confidence,
  override,
  compact = false,
  'data-testid': testId,
}: LesionBadgeProps): JSX.Element {
  const { t } = useTranslation();
  const claim = useRUOClaim('lesion_classification');

  // Effective class after override (FR-046): the override REPLACES the AI
  // suggestion in the badge but we keep a visual ring so reviewers can see
  // it was manually set.
  const effectiveClass = override?.classValue ?? classValue;
  const isAbstained = effectiveClass === null;
  const isOverridden = Boolean(override);
  const isRUO = claim.disclaimerVariant === 'ruo';

  const confidencePct = useMemo(() => {
    if (confidence === null || confidence === undefined) return 0;
    return Math.max(0, Math.min(100, Math.round(confidence * 100)));
  }, [confidence]);

  const label = isAbstained
    ? t('lesions:abstention.label')
    : t(`lesions:classes.${effectiveClass}.name`);

  const ariaLabel = isAbstained
    ? t('lesions:abstention.badgeAria')
    : `${t(`lesions:classes.${effectiveClass}.long`)}, ${confidencePct}% ${t(
        'lesions:list.columns.confidence',
      )}`;

  const tooltipLabel = isAbstained
    ? t('lesions:abstention.tooltip')
    : t(`lesions:classes.${effectiveClass}.long`);

  const pill = (
    <span
      data-testid={isAbstained ? 'abstention-badge' : testId}
      aria-label={ariaLabel}
      className={[
        styles.pill,
        pillVariantClass(effectiveClass),
        isOverridden ? styles.overridden : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
    >
      <Text component="span" fz="xs" fw={600} style={{ color: 'inherit', lineHeight: 1 }}>
        {label}
      </Text>
      {!isAbstained && isRUO && (
        <span className={styles.suffix}>{t('lesions:list.aiSuggestionSuffix')}</span>
      )}
    </span>
  );

  return (
    <Box className={styles.root} data-testid={testId ? `${testId}-root` : undefined}>
      <Tooltip label={tooltipLabel} withinPortal position="top" openDelay={350}>
        {pill}
      </Tooltip>
      {!compact && (
        <Box
          className={styles.barTrack}
          role="progressbar"
          aria-valuenow={confidencePct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={
            isAbstained
              ? t('lesions:abstention.help')
              : `${t('lesions:list.columns.confidence')} ${confidencePct}%`
          }
        >
          <Box
            className={[styles.barFill, barVariantClass(effectiveClass)].join(' ')}
            style={{ width: `${confidencePct}%` }}
          />
        </Box>
      )}
      {!compact && (
        <Text component="span" className={styles.barLabel}>
          {isAbstained ? t('lesions:abstention.label') : `${confidencePct}%`}
        </Text>
      )}
    </Box>
  );
}

export default LesionBadge;
