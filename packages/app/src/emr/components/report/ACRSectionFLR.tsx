// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionFLR — renders the FLR ASSESSMENT anatomical section
 * (002-acr-structured-readout, T038).
 *
 * The FLR % row carries `data-testid="flr-percent"` so the end-to-end
 * spec can assert the percentage is rendered correctly.
 */

import { Box, Group, Stack, Text } from '@mantine/core';

import { EMRAlert, EMRBadge, EMRSkeleton } from '../common';
import { mapBadgeColorToVariant } from './acrBadgeColor';
import type { ReadoutSection, ReadoutRow } from '../../services/report/acrAnatomicalMapping';
import styles from './ACRSection.module.css';

export interface ACRSectionFLRProps {
  section: ReadoutSection;
}

function RowItem({ row }: { row: ReadoutRow }): JSX.Element {
  const valueTestId = row.key === 'flr-value' ? 'flr-percent' : undefined;
  return (
    <Box className={styles.row}>
      <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
        <Group gap="xs" style={{ flex: 1, minWidth: 0 }} wrap="nowrap">
          <Text className={styles.rowLabel} component="span">
            {row.label}
          </Text>
        </Group>
        <Group gap="xs" style={{ flexShrink: 0 }} wrap="nowrap">
          <Text
            className={styles.rowValue}
            component="span"
            data-testid={valueTestId}
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

export function ACRSectionFLR({ section }: ACRSectionFLRProps): JSX.Element {
  return (
    <section
      className={styles.section}
      aria-label={section.title}
      data-testid="acr-section-flr"
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

export default ACRSectionFLR;
