// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * QueueDepthGauge (T318, US8).
 *
 * Plain-English:
 *   A visual speedometer for the cross-tenant queue. Green when the
 *   backlog is comfortable, amber when it approaches the warning
 *   threshold, red when we're past it. No PHI here — just a count.
 *
 * Design:
 *   Uses Mantine's RingProgress for a compact, responsive gauge. Colors
 *   come from the EMR theme variables — never hardcoded.
 *
 * Props:
 *   - label: short text (e.g. "Queued", "Stuck >15 min").
 *   - count: current queue size.
 *   - warnThreshold: triggers amber styling (default 3).
 *   - alarmThreshold: triggers red styling + aria-live alert (default 8).
 */

import { Badge, Group, RingProgress, Stack, Text } from '@mantine/core';

import { useTranslation } from '../../contexts/TranslationContext';

export interface QueueDepthGaugeProps {
  label: string;
  count: number;
  warnThreshold?: number;
  alarmThreshold?: number;
  /** Maximum count the ring should reflect as "full" (default 20). */
  capacity?: number;
  /** Optional test id so Playwright can target the component. */
  testId?: string;
}

type Severity = 'ok' | 'warn' | 'alarm';

function severityFor(
  count: number,
  warn: number,
  alarm: number,
): Severity {
  if (count >= alarm) return 'alarm';
  if (count >= warn) return 'warn';
  return 'ok';
}

/** Map severity → CSS variable (EMR theme) — never hardcode hex. */
const SEVERITY_COLORS: Record<Severity, string> = {
  ok: 'var(--emr-status-success, teal)',
  warn: 'var(--emr-status-warning, orange)',
  alarm: 'var(--emr-status-danger, red)',
};

export function QueueDepthGauge({
  label,
  count,
  warnThreshold = 3,
  alarmThreshold = 8,
  capacity = 20,
  testId,
}: QueueDepthGaugeProps): JSX.Element {
  const { t } = useTranslation();
  const severity = severityFor(count, warnThreshold, alarmThreshold);
  const color = SEVERITY_COLORS[severity];
  const pct = Math.min(100, Math.round((count / Math.max(1, capacity)) * 100));

  const severityLabel =
    severity === 'alarm'
      ? t('ops:severity.alarm')
      : severity === 'warn'
        ? t('ops:severity.warn')
        : t('ops:severity.ok');

  return (
    <Stack
      gap="xs"
      align="center"
      data-testid={testId}
      aria-live={severity === 'alarm' ? 'polite' : undefined}
    >
      <RingProgress
        size={96}
        thickness={10}
        roundCaps
        sections={[{ value: pct, color }]}
        label={
          <Text ta="center" fw={700} fz="lg" c={color}>
            {count}
          </Text>
        }
      />
      <Group gap={6} wrap="wrap" justify="center">
        <Text fz="sm" fw={500}>
          {label}
        </Text>
        <Badge
          size="sm"
          variant="light"
          color={
            severity === 'alarm' ? 'red' : severity === 'warn' ? 'yellow' : 'teal'
          }
        >
          {severityLabel}
        </Badge>
      </Group>
    </Stack>
  );
}

export default QueueDepthGauge;
