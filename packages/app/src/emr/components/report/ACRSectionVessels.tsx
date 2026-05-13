// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionVessels — renders the VESSELS anatomical section
 * (002-acr-structured-readout, T035).
 *
 * No vessel findings are persisted yet — the section is structural only
 * (FR-002). Visible content is the per-stage `vessels` PNG rendered by
 * the API at `/analyses/:id/report/render/vessels`. We inline a minimal
 * <img> wrapper rather than importing StageImage from ReportInlineView
 * to keep the coupling between report components low.
 */

import { Stack } from '@mantine/core';

import { EMRAlert, EMRSkeleton } from '../common';
import type { ReadoutSection } from '../../services/report/acrAnatomicalMapping';
import styles from './ACRSection.module.css';

export interface ACRSectionVesselsProps {
  section: ReadoutSection;
  analysisId?: string;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export function ACRSectionVessels({
  section,
  analysisId,
}: ACRSectionVesselsProps): JSX.Element {
  const src = analysisId
    ? `${readApiBaseUrl()}/analyses/${encodeURIComponent(analysisId)}/report/render/vessels`
    : '';

  return (
    <section
      className={styles.section}
      aria-label={section.title}
      data-testid="acr-section-vessels"
    >
      <h3 className={styles.sectionHeader}>{section.title}</h3>
      {section.status === 'computing' ? (
        <Stack gap="xs" className={styles.sectionRows}>
          <EMRSkeleton height={140} width="100%" />
        </Stack>
      ) : section.status === 'unavailable' ? (
        <EMRAlert variant="error">{section.emptyMessage}</EMRAlert>
      ) : !analysisId ? (
        <span className={styles.emptyMessage}>{section.emptyMessage}</span>
      ) : (
        <img
          src={src}
          alt={section.title}
          className={styles.lesionImage}
          loading="lazy"
        />
      )}
    </section>
  );
}

export default ACRSectionVessels;
