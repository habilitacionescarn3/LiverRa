// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionSpleen — renders the SPLEEN anatomical section
 * (002-acr-structured-readout, T037).
 */

import { Box, Group, Stack, Text } from '@mantine/core';

import { EMRAlert, EMRBadge, EMRSkeleton } from '../common';
import { mapBadgeColorToVariant } from './acrBadgeColor';
import type { ReadoutSection, ReadoutRow } from '../../services/report/acrAnatomicalMapping';
import styles from './ACRSection.module.css';

export interface ACRSectionSpleenProps {
  section: ReadoutSection;
}

function RowItem({ row }: { row: ReadoutRow }): JSX.Element {
  return (
    <Box className={styles.row}>
      <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
        <Group gap="xs" style={{ flex: 1, minWidth: 0 }} wrap="nowrap">
          <Text className={styles.rowLabel} component="span">
            {row.label}
          </Text>
        </Group>
        <Group gap="xs" style={{ flexShrink: 0 }} wrap="nowrap">
          <Text className={styles.rowValue} component="span">
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

export function ACRSectionSpleen({ section }: ACRSectionSpleenProps): JSX.Element {
  return (
    <section
      className={styles.section}
      aria-label={section.title}
      data-testid="acr-section-spleen"
    >
      <h3 className={styles.sectionHeader}>{section.title}</h3>
      {section.status === 'computing' ? (
        <Stack gap="xs" className={styles.sectionRows}>
          <EMRSkeleton height={18} width="80%" />
          <EMRSkeleton height={18} width="60%" />
        </Stack>
      ) : section.status === 'unavailable' ? (
        <EMRAlert variant="error">{section.emptyMessage}</EMRAlert>
      ) : section.status === 'empty' ? (
        <span className={styles.emptyMessage}>{section.emptyMessage}</span>
      ) : (
        <Stack gap="xs" className={styles.sectionRows}>
          {section.rows.map((row) => (
            <RowItem key={row.key} row={row} />
          ))}
        </Stack>
      )}
    </section>
  );
}

export default ACRSectionSpleen;
