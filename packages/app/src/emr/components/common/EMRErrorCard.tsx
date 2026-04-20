// SPDX-License-Identifier: Apache-2.0
// Minimal EMRErrorCard stub for LiverRa (unblock FailClosedErrorStates at dev time).
// TODO: port full MediMind EMRErrorCard once visual spec lands.

import type { ReactNode } from 'react';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';

export interface EMRErrorCardProps {
  title: string;
  message: ReactNode;
  severity?: 'error' | 'warning' | 'info';
  onRetry?: () => void;
  retryLabel?: string;
  suggestions?: ReactNode[];
}

export function EMRErrorCard({
  title,
  message,
  severity = 'error',
  onRetry,
  retryLabel = 'Retry',
  suggestions,
}: EMRErrorCardProps) {
  const color = severity === 'error' ? 'red' : severity === 'warning' ? 'yellow' : 'blue';
  return (
    <Alert color={color} title={title} variant="light" radius="md">
      <Stack gap="sm">
        <Text size="sm">{message}</Text>
        {suggestions && suggestions.length > 0 && (
          <Stack gap={4}>
            {suggestions.map((s, i) => (
              <Text key={i} size="xs" c="dimmed">
                • {s}
              </Text>
            ))}
          </Stack>
        )}
        {onRetry && (
          <Group>
            <Button variant="light" color={color} size="xs" onClick={onRetry}>
              {retryLabel}
            </Button>
          </Group>
        )}
      </Stack>
    </Alert>
  );
}
