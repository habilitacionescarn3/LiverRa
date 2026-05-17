// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * MarkersList (Phase G5).
 *
 * Plain-English: shows the count of reviewer-placed markers ("sticky
 * notes" anchored in voxel space) plus one row per marker with its
 * label, optional Couinaud segment, and a relative timestamp ("3m ago").
 *
 * Hover behaviour: each row fires `liverra:focus-voxel` so a future
 * viewer change can re-center the camera on that marker. We emit the
 * event today even though no consumer is listening yet — wiring the
 * receive side is a separate change.
 *
 * Structural sibling of `LesionsList.tsx` — same testid pattern, same
 * empty/loading state idioms, same CSS-module-only styling.
 */

import { IconPin } from '@tabler/icons-react';
import { useCallback, type ReactElement } from 'react';

import styles from './MarkersList.module.css';
import { EMREmptyState } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';
import { useMarkers } from '../../hooks/useMarkers';
import { formatRelativeTime } from '../../services/localeService';

export interface MarkersListProps {
  analysisId: string;
  apiBaseUrl: string;
}

export function MarkersList({
  analysisId,
  apiBaseUrl,
}: MarkersListProps): ReactElement {
  const { t, tPlural, locale } = useTranslation();
  const { data, isLoading, error } = useMarkers(analysisId, apiBaseUrl);
  const markers = data ?? [];

  const onRowHover = useCallback(
    (voxel: [number, number, number]): void => {
      try {
        window.dispatchEvent(
          new CustomEvent('liverra:focus-voxel', {
            detail: { voxel, analysisId },
          }),
        );
      } catch {
        /* CustomEvent constructor may throw in legacy environments; ignore. */
      }
    },
    [analysisId],
  );

  if (isLoading) {
    return (
      <p className={styles.helperText} data-testid="markers-loading">
        Loading markers…
      </p>
    );
  }
  if (error) {
    return (
      <p className={`${styles.helperText} ${styles.helperError}`}>
        {error.message}
      </p>
    );
  }
  if (markers.length === 0) {
    return (
      <div data-testid="markers-empty">
        <EMREmptyState
          icon={IconPin}
          size="sm"
          title={t('refine:marker.emptyTitle')}
          description={t('refine:marker.emptyDescription')}
        />
      </div>
    );
  }

  return (
    <div className={styles.stack} data-testid="markers-list">
      <p className={styles.markersCount} data-testid="markers-count">
        {tPlural('refine:marker.count', markers.length, { count: markers.length })}
      </p>
      {markers.map((m) => {
        const label = m.label?.trim() || t('refine:marker.unlabeled');
        const segment = m.couinaud_segment ? `Segment ${m.couinaud_segment}` : null;
        const age = formatRelativeTime(m.created_at, locale);
        return (
          <div
            key={m.id}
            role="button"
            tabIndex={0}
            data-testid={`marker-row-${m.id}`}
            className={styles.markerRow}
            onMouseEnter={() => onRowHover(m.voxel)}
            onFocus={() => onRowHover(m.voxel)}
          >
            <span className={styles.markerRowTitle}>{label}</span>
            <span className={styles.markerRowMeta}>
              {segment ? `${segment} · ` : ''}
              {age}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default MarkersList;
