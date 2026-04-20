// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * SampleDataBadge (T310, T441).
 *
 * Plain-English: persistent banner + opt-in watermark rendered whenever
 * the user is viewing a `DemoCase`-derived analysis. It doubles as a
 * "do not push to real PACS" guard — the PACS push button is disabled
 * when this badge is mounted (FR-042 invariant).
 */
import type { ReactNode } from 'react';
import { Box, Group, Text } from '@mantine/core';
import { IconFlask } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';

export interface SampleDataBadgeProps {
  /** Optional slot — typically a "How this was seeded" link. */
  trailing?: ReactNode;
  /** Inline (compact) vs. banner layout. */
  variant?: 'banner' | 'inline';
}

export function SampleDataBadge({
  trailing,
  variant = 'banner',
}: SampleDataBadgeProps): React.ReactElement {
  const { t } = useTranslation();
  const label = t('onboarding:sample.badge') || 'Sample data — not real patient';

  if (variant === 'inline') {
    return (
      <Box
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 10px',
          borderRadius: 999,
          background: 'color-mix(in srgb, var(--emr-warning) 14%, transparent)',
          color: 'var(--emr-warning)',
          fontSize: 'var(--emr-font-xs)',
          fontWeight: 600,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
        role="status"
        aria-label={label}
      >
        <IconFlask size={14} aria-hidden="true" />
        {label}
      </Box>
    );
  }

  return (
    <Box
      role="status"
      aria-label={label}
      data-sample-data-badge="true"
      style={{
        padding: 12,
        borderRadius: 'var(--emr-border-radius-lg)',
        background: 'color-mix(in srgb, var(--emr-warning) 10%, transparent)',
        border: '1px solid var(--emr-warning)',
      }}
    >
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconFlask size={20} color="var(--emr-warning)" aria-hidden="true" />
          <Text fw={600} fz="var(--emr-font-sm)" c="var(--emr-warning)">
            {label}
          </Text>
        </Group>
        {trailing}
      </Group>
    </Box>
  );
}

export default SampleDataBadge;
