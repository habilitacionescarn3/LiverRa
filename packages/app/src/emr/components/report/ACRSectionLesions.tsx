// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionLesions — renders the LESIONS anatomical section
 * (002-acr-structured-readout, T034).
 *
 * The FIRST lesion row gets `data-testid="primary-lesion-size"` so the
 * end-to-end spec can assert that the primary lesion is surfaced at the
 * top of the section.
 */

import { Box, Group, Stack, Text } from '@mantine/core';

import { EMRAlert, EMRBadge, EMRSkeleton } from '../common';
import { mapBadgeColorToVariant } from './acrBadgeColor';
import type { ReadoutSection, ReadoutRow } from '../../services/report/acrAnatomicalMapping';
import styles from './ACRSection.module.css';

export interface ACRSectionLesionsProps {
  section: ReadoutSection;
}

function LesionRow({ row, isPrimary }: { row: ReadoutRow; isPrimary: boolean }): JSX.Element {
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
            data-testid={isPrimary ? 'primary-lesion-size' : undefined}
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

export function ACRSectionLesions({ section }: ACRSectionLesionsProps): JSX.Element {
  // The FIRST per-lesion row is the "primary" — lesion rows have a
  // `itemId` set by the builder; summary rows do not.
  const firstLesionIdx = section.rows.findIndex((r) => !!r.itemId);

  return (
    <section
      className={styles.section}
      aria-label={section.title}
      data-testid="acr-section-lesions"
    >
      <h3 className={styles.sectionHeader}>{section.title}</h3>
      {section.status === 'computing' ? (
        <Stack gap="xs" className={styles.sectionRows}>
          <EMRSkeleton height={18} width="80%" />
          <EMRSkeleton height={18} width="60%" />
          <EMRSkeleton height={18} width="70%" />
        </Stack>
      ) : section.status === 'unavailable' ? (
        <EMRAlert variant="error">{section.emptyMessage}</EMRAlert>
      ) : section.status === 'empty' ? (
        <span className={styles.emptyMessage}>{section.emptyMessage}</span>
      ) : (
        <Stack gap="xs" className={styles.sectionRows}>
          {section.rows.map((row, idx) => (
            <LesionRow key={row.key} row={row} isPrimary={idx === firstLesionIdx} />
          ))}
        </Stack>
      )}
    </section>
  );
}

export default ACRSectionLesions;
