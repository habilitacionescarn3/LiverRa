// SPDX-License-Identifier: Apache-2.0
//
// EMRErrorCard — fail-closed error surface used by FailClosedErrorStates and
// other production paths.
//
// Built on EMRAlert + EMRButton (no raw Mantine wrappers) so the surface
// follows brand-token swap and dark-mode rules automatically.

import type { ReactNode } from 'react';
import { Group, Stack, Text } from '@mantine/core';
import { EMRAlert, type EMRAlertVariant } from './EMRAlert';
import { EMRButton } from './EMRButton';

export interface EMRErrorCardProps {
  title: string;
  message: ReactNode;
  severity?: 'error' | 'warning' | 'info';
  onRetry?: () => void;
  retryLabel?: string;
  suggestions?: ReactNode[];
}

/** Map severity → EMRAlert variant. */
const SEVERITY_TO_VARIANT: Record<NonNullable<EMRErrorCardProps['severity']>, EMRAlertVariant> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
};

export function EMRErrorCard({
  title,
  message,
  severity = 'error',
  onRetry,
  retryLabel = 'Retry',
  suggestions,
}: EMRErrorCardProps): React.ReactElement {
  const variant = SEVERITY_TO_VARIANT[severity];
  // Map severity → retry button variant. Errors get the danger style; everything else stays primary.
  const retryButtonVariant = severity === 'error' ? 'danger' : 'primary';

  return (
    <EMRAlert variant={variant} title={title}>
      <Stack gap="sm">
        <Text size="sm">{message}</Text>
        {suggestions && suggestions.length > 0 && (
          <Stack gap={4}>
            {suggestions.map((s, i) => (
              <Text key={i} size="xs" c="var(--emr-text-secondary)">
                • {s}
              </Text>
            ))}
          </Stack>
        )}
        {onRetry && (
          <Group>
            <EMRButton variant={retryButtonVariant} size="sm" onClick={onRetry}>
              {retryLabel}
            </EMRButton>
          </Group>
        )}
      </Stack>
    </EMRAlert>
  );
}
