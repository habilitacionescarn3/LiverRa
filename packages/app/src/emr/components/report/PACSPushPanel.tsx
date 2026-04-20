// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * PACSPushPanel (T270, T429).
 *
 * Plain-English: the timeline that lists every (destination × artifact)
 * delivery for a Report, shows its current state (pending/sending/…),
 * and offers:
 *
 *   - "Retry" on a failed delivery → calls `retryDelivery()`.
 *   - "Download for manual push" as a fallback when the retry state
 *     machine has already exhausted its 6 attempts.
 *
 * Server-side, demo-case Reports are rejected with
 * `slug=demo-case-no-pacs-push` (T430); we render a human-friendly
 * banner for that case.
 */
import { Badge, Group, Stack, Text } from '@mantine/core';
import { IconDownload, IconRefresh } from '@tabler/icons-react';

import { usePacsDelivery } from '../../hooks/usePacsDelivery';
import type { PacsDeliveryStatus, ReportDelivery } from '../../hooks/usePacsDelivery';
import { EMRButton } from '../common/EMRButton';
import { useTranslation } from '../../contexts/TranslationContext';

const STATUS_COLOR: Record<PacsDeliveryStatus, string> = {
  pending: 'gray',
  sending: 'blue',
  acknowledged: 'green',
  failed: 'red',
  manual_fallback: 'orange',
};

export interface PACSPushPanelProps {
  reportId: string;
  /** When true, disable start/retry buttons (e.g. report is retracted). */
  readonly?: boolean;
  /** Set to true for DemoCase-backed reports — renders the blocked banner. */
  sampleCase?: boolean;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export function PACSPushPanel({
  reportId,
  readonly = false,
  sampleCase = false,
}: PACSPushPanelProps): JSX.Element {
  const { t } = useTranslation();
  const { deliveries, isLoading, startPush, retryDelivery } = usePacsDelivery(reportId);

  if (sampleCase) {
    return (
      <Stack gap="xs" data-testid="pacs-push-blocked-demo">
        <Text c="red.7" fw={600}>
          {t('report:pacs.demoBlocked') ??
            'Sample-data reports cannot be pushed to a real PACS destination.'}
        </Text>
        <Text size="xs" c="dimmed">
          demo-case-no-pacs-push
        </Text>
      </Stack>
    );
  }

  const handleDownloadManual = (delivery: ReportDelivery): void => {
    const base = readApiBaseUrl();
    // Points at the same KMS-encrypted S3 artifact the PACS push would have
    // shipped; the download endpoint re-authenticates + logs an
    // `artifact_export` AuditEvent server-side.
    const href = `${base}/reports/${encodeURIComponent(
      delivery.report_id,
    )}/artifacts/${delivery.artifact_type}/download`;
    window.open(href, '_blank', 'noopener');
  };

  return (
    <Stack gap="md" data-testid="pacs-push-panel">
      <Group justify="space-between">
        <Text fw={600}>{t('report:pacs.title') ?? 'PACS Delivery'}</Text>
        {!readonly && deliveries.length === 0 ? (
          <EMRButton
            onClick={() => void startPush(reportId)}
            data-testid="pacs-push-start"
          >
            {t('report:pacs.start') ?? 'Start push'}
          </EMRButton>
        ) : null}
      </Group>

      {isLoading && deliveries.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('report:pacs.loading') ?? 'Loading deliveries…'}
        </Text>
      ) : null}

      {deliveries.length === 0 && !isLoading ? (
        <Text size="sm" c="dimmed">
          {t('report:pacs.empty') ??
            'No PACS destinations pushed yet. Click "Start push" to fan out to configured destinations.'}
        </Text>
      ) : null}

      <Stack gap="xs" role="list" aria-label={t('report:pacs.aria') ?? 'Delivery timeline'}>
        {deliveries.map((d) => (
          <Group
            key={d.id}
            justify="space-between"
            align="center"
            role="listitem"
            data-testid={`delivery-${d.id}`}
            style={{
              padding: 'var(--mantine-spacing-xs)',
              border: '1px solid var(--mantine-color-gray-3)',
              borderRadius: 'var(--mantine-radius-sm)',
            }}
          >
            <Stack gap={2}>
              <Group gap="xs">
                <Badge color={STATUS_COLOR[d.status]} variant="light">
                  {t(`report:pacs.status.${d.status}`) ?? d.status}
                </Badge>
                <Text size="sm" fw={500}>
                  {d.artifact_type.toUpperCase()} → {d.destination_ae_title}
                </Text>
              </Group>
              {d.last_error ? (
                <Text size="xs" c="red.7">
                  {d.last_error}
                </Text>
              ) : null}
              {d.next_attempt_at ? (
                <Text size="xs" c="dimmed">
                  {t('report:pacs.nextAttempt') ?? 'Next attempt:'} {d.next_attempt_at}
                </Text>
              ) : null}
            </Stack>

            {!readonly ? (
              <Group gap="xs">
                {d.status === 'failed' || d.status === 'pending' ? (
                  <EMRButton
                    size="sm"
                    variant="light"
                    icon={IconRefresh}
                    onClick={() => void retryDelivery(d.report_id, d.id)}
                    data-testid={`retry-${d.id}`}
                  >
                    {t('report:pacs.retry') ?? 'Retry'}
                  </EMRButton>
                ) : null}
                {d.status === 'failed' || d.status === 'manual_fallback' ? (
                  <EMRButton
                    size="sm"
                    variant="secondary"
                    icon={IconDownload}
                    onClick={() => handleDownloadManual(d)}
                    data-testid={`manual-${d.id}`}
                  >
                    {t('report:pacs.manualFallback') ?? 'Download for manual push'}
                  </EMRButton>
                ) : null}
              </Group>
            ) : null}
          </Group>
        ))}
      </Stack>
    </Stack>
  );
}

export default PACSPushPanel;
