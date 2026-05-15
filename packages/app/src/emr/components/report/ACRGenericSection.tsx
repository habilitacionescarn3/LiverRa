// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRGenericSection — single source of truth for the LIVER / SPLEEN /
 * GALLBLADDER / FLR / (default) LESIONS ACR section render (H-ACR-4).
 *
 * Five 95% copy-paste section components previously diverged on tiny
 * details; this generic accepts a `renderRow` callback so the LESIONS
 * section can still surface the FIRST lesion row as the "primary",
 * and the LIVER section can mark the steatosis row with a testid.
 *
 * B-ACR-1: every metric row renders the stale-stamp inline next to
 * the value when `row.stale.computedAt` is set — closing the FR-023c
 * gap that previously only the clipboard text path covered.
 */

import type { ReactNode } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';

import { EMRAlert, EMRBadge, EMRSkeleton } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';
import { mapBadgeColorToVariant } from './acrBadgeColor';
import type { ReadoutSection, ReadoutRow } from '../../services/report/acrAnatomicalMapping';
import styles from './ACRSection.module.css';

export interface ACRGenericSectionProps {
  section: ReadoutSection;
  /** Stable test id (e.g. "acr-section-liver"). */
  testId: string;
  /**
   * Optional override for individual rows. Return `null` to fall
   * through to the default renderer. Used by ACRSectionLesions to
   * mark the FIRST per-lesion row as "primary".
   */
  renderRow?: (row: ReadoutRow, index: number) => ReactNode | null;
  /** Skeleton row count when section is "computing". */
  skeletonRows?: number;
}

/** Inline stale stamp. */
function StaleStamp({ computedAt }: { computedAt: string }): JSX.Element {
  const { t } = useTranslation();
  const label = t('reportAcr:staleness.lastComputed').replace(
    '{{time}}',
    new Date(computedAt).toLocaleString(),
  );
  return (
    <span
      className={styles.stale}
      role="note"
      aria-label={t('reportAcr:staleness.stale')}
      data-testid="acr-stale-stamp"
    >
      &#8635; {label}
    </span>
  );
}

/** Default per-row renderer. Used unless `renderRow` returns a node. */
export function DefaultRowItem({
  row,
  testId,
}: {
  row: ReadoutRow;
  testId?: string;
}): JSX.Element {
  return (
    <Box className={styles.row}>
      <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
        <Group gap="xs" style={{ flex: 1, minWidth: 0 }} wrap="nowrap">
          <Text className={styles.rowLabel} component="span">
            {row.label}
          </Text>
          {row.segment && (
            <EMRBadge variant="neutral" size="sm">
              {row.segment}
            </EMRBadge>
          )}
        </Group>
        <Group gap="xs" style={{ flexShrink: 0 }} wrap="nowrap">
          <Text
            className={styles.rowValue}
            component="span"
            data-testid={testId}
          >
            {row.value ?? ''}
          </Text>
          {row.badge && (
            <EMRBadge
              variant={mapBadgeColorToVariant(row.badge.color)}
              size="sm"
            >
              {row.badge.label}
            </EMRBadge>
          )}
          {row.stale?.computedAt && <StaleStamp computedAt={row.stale.computedAt} />}
        </Group>
      </Group>
      {row.warning && (
        <div className={styles.warning} role="status">
          {row.warning}
        </div>
      )}
    </Box>
  );
}

export function ACRGenericSection({
  section,
  testId,
  renderRow,
  skeletonRows = 2,
}: ACRGenericSectionProps): JSX.Element {
  return (
    <section
      className={styles.section}
      aria-label={section.title}
      data-testid={testId}
    >
      <h3 className={styles.sectionHeader}>{section.title}</h3>
      {section.status === 'computing' ? (
        <Stack gap="xs" className={styles.sectionRows}>
          {Array.from({ length: skeletonRows }).map((_, i) => (
            <EMRSkeleton key={i} height={18} width={i === 0 ? '80%' : '60%'} />
          ))}
        </Stack>
      ) : section.status === 'unavailable' ? (
        <EMRAlert variant="error">{section.emptyMessage}</EMRAlert>
      ) : section.status === 'empty' ? (
        <span className={styles.emptyMessage}>{section.emptyMessage}</span>
      ) : (
        <Stack gap="xs" className={styles.sectionRows}>
          {section.rows.map((row, idx) => {
            const custom = renderRow ? renderRow(row, idx) : null;
            return (
              <Box key={row.key}>
                {custom ?? <DefaultRowItem row={row} />}
              </Box>
            );
          })}
        </Stack>
      )}
    </section>
  );
}

export default ACRGenericSection;
