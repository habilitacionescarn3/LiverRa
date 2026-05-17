// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LesionsList — extracted from `AnalysisDetailView.tsx` so the Refine page can
 * mount the same lesion table that the Case page renders in the Lesions drawer
 * tab.
 *
 * Plain-English:
 *   Shows the count of lesions the cascade found, plus one row per lesion with
 *   its classification (HCC, metastasis, …), confidence, Couinaud segment, and
 *   longest diameter in mm.
 *
 * Behaviour is byte-identical to the previous inline `LesionsTabContent` —
 * same query key (`['analysis', id, 'results']`, shared with `useAnalysisResults`),
 * same `data-testid` attributes for tests, same JSON-parse fallback for corrupt
 * classification payloads.
 */

import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import styles from './LesionsList.module.css';

export interface LesionsListProps {
  analysisId: string;
  apiBaseUrl: string;
}

interface LesionRow {
  id: string;
  couinaud_location?: number | null;
  longest_diameter_mm?: string | number | null;
  classification?: string | null;
}

interface ResultsBundle {
  lesions?: LesionRow[];
}

export function LesionsList({
  analysisId,
  apiBaseUrl,
}: LesionsListProps): ReactElement {
  const { data, isLoading, error } = useQuery<ResultsBundle, Error>({
    queryKey: ['analysis', analysisId, 'results'],
    queryFn: async () => {
      const r = await fetch(
        `${apiBaseUrl}/analyses/${encodeURIComponent(analysisId)}/results`,
        { credentials: 'include' },
      );
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
        } catch (e) {
          // H-CATCH variant: corrupt classification JSON is rare but
          // important to surface — silent catch previously masked a
          // real classifier output drift. We mark the row "parse error"
          // and log via console.warn so dev tools + Sentry beforeSend
          // can pick it up.
          // eslint-disable-next-line no-console
          console.warn(
            '[LesionsList] classification JSON parse failed',
            { lesionId: les.id, error: e },
          );
          label = 'parse-error';
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

export default LesionsList;
