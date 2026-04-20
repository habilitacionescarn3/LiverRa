// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * OpsQueueView (T316, T444, US8).
 *
 * Plain-English:
 *   The cross-tenant ops dashboard. Shows three gauges (queued / running /
 *   stuck), the GPU-utilization and cold-start panels, and a sortable
 *   table of stuck cases. Clicking a row opens the StuckCasePanel which
 *   offers retry / cancel / mark-blocked actions.
 *
 *   No PHI on screen. The backend already projects PHI-free columns and
 *   the UI only renders the documented allowlist (see StuckCasePanel).
 *
 * Data:
 *   - `useOpsQueue()` polls every 5 s (T444).
 *   - Mutations in StuckCasePanel invalidate the `['ops','queue']` key so
 *     the dashboard refreshes automatically.
 */

import {
  Alert,
  Badge,
  Box,
  Card,
  Divider,
  Group,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconCpu, IconSnowflake } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslation } from '../../contexts/TranslationContext';
import { useOpsQueue, type OpsAnalysisSummary } from '../../hooks/useOpsQueue';
import { QueueDepthGauge } from '../../components/ops/QueueDepthGauge';
import { StuckCasePanel } from '../../components/ops/StuckCasePanel';
import {
  EMREmptyState as EMREmpty,
  EMRTableSkeleton as Skeleton,
} from '../../components/common';

function fmtMinutes(m: number | null): string {
  if (m === null || Number.isNaN(m)) return '—';
  if (m < 1) return `${(m * 60).toFixed(0)}s`;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function StuckTable({
  items,
  onSelect,
  selectedId,
}: {
  items: OpsAnalysisSummary[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}): JSX.Element {
  const { t } = useTranslation();
  if (items.length === 0) {
    return (
      <Box data-testid="ops-stuck-empty">
        <EMREmpty title={t('ops:table.empty')} />
      </Box>
    );
  }
  return (
    <ScrollArea>
      <Table highlightOnHover withRowBorders striped data-testid="ops-stuck-table">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('ops:table.analysis_id')}</Table.Th>
            <Table.Th>{t('ops:table.status')}</Table.Th>
            <Table.Th>{t('ops:table.last_stage')}</Table.Th>
            <Table.Th>{t('ops:table.stuck_for')}</Table.Th>
            <Table.Th>{t('ops:table.error_slug')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((item) => {
            const isSel = item.analysis_id === selectedId;
            return (
              <Table.Tr
                key={item.analysis_id}
                onClick={() => onSelect(item.analysis_id)}
                style={{
                  cursor: 'pointer',
                  backgroundColor: isSel ? 'var(--emr-bg-card-hover, transparent)' : undefined,
                }}
                data-testid={`ops-stuck-row-${item.analysis_id}`}
              >
                <Table.Td>
                  <Text fz="xs" ff="monospace">
                    {item.analysis_id.slice(0, 8)}…
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge
                    size="sm"
                    variant="light"
                    color={item.status === 'running' ? 'blue' : 'yellow'}
                  >
                    {item.status}
                  </Badge>
                </Table.Td>
                <Table.Td>{item.last_stage ?? '—'}</Table.Td>
                <Table.Td>{fmtMinutes(item.stuck_minutes)}</Table.Td>
                <Table.Td>
                  {item.error_slug ? (
                    <Text fz="xs" ff="monospace">
                      {item.error_slug}
                    </Text>
                  ) : (
                    '—'
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

export default function OpsQueueView(): JSX.Element {
  const { t } = useTranslation();
  const { view, isLoading, isError, error } = useOpsQueue();
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(null);

  return (
    <Stack gap="md" p="md" data-testid="ops-queue-view">
      <Group justify="space-between" wrap="wrap">
        <Title order={2}>{t('ops:page.title')}</Title>
        <Badge color="gray" variant="light">
          {t('ops:page.no_phi_badge')}
        </Badge>
      </Group>
      <Text c="dimmed" fz="sm">
        {t('ops:page.subtitle')}
      </Text>

      {isError ? (
        <Alert
          icon={<IconAlertTriangle size={18} />}
          color="red"
          title={t('ops:errors.load_title')}
          data-testid="ops-queue-error"
        >
          {error?.message ?? t('ops:errors.load_body')}
        </Alert>
      ) : null}

      {/* Gauges row. Responsive: wraps on mobile. */}
      <Group gap="lg" wrap="wrap" justify="flex-start">
        <Card shadow="xs" padding="md" radius="md" withBorder>
          <QueueDepthGauge
            label={t('ops:gauges.queued')}
            count={view?.queued.length ?? 0}
            testId="ops-gauge-queued"
          />
        </Card>
        <Card shadow="xs" padding="md" radius="md" withBorder>
          <QueueDepthGauge
            label={t('ops:gauges.running')}
            count={view?.running.length ?? 0}
            testId="ops-gauge-running"
          />
        </Card>
        <Card shadow="xs" padding="md" radius="md" withBorder>
          <QueueDepthGauge
            label={t('ops:gauges.stuck')}
            count={view?.stuck_over_15min.length ?? 0}
            warnThreshold={1}
            alarmThreshold={3}
            testId="ops-gauge-stuck"
          />
        </Card>

        <Card shadow="xs" padding="md" radius="md" withBorder>
          <Stack gap={4} align="center" data-testid="ops-gpu-panel">
            <IconCpu size={28} />
            <Text fw={700} fz="xl">
              {(view?.gpu_utilization_pct ?? 0).toFixed(0)}%
            </Text>
            <Text fz="xs" c="dimmed">
              {t('ops:gauges.gpu_utilization')}
            </Text>
          </Stack>
        </Card>

        <Card shadow="xs" padding="md" radius="md" withBorder>
          <Stack gap={4} align="center" data-testid="ops-cold-start-panel">
            <IconSnowflake size={28} />
            <Text fw={700} fz="xl">
              {(view?.cold_start_rate_last_hour ?? 0).toFixed(2)}
            </Text>
            <Text fz="xs" c="dimmed">
              {t('ops:gauges.cold_starts')}
            </Text>
          </Stack>
        </Card>
      </Group>

      <Divider label={t('ops:sections.stuck_cases')} labelPosition="left" />

      {isLoading ? (
        <Skeleton rows={5} columns={5} data-testid="ops-stuck-loading" />
      ) : (
        <Group align="flex-start" wrap="nowrap" gap="md" style={{ alignItems: 'stretch' }}>
          <Box style={{ flex: 1, minWidth: 0 }}>
            <StuckTable
              items={view?.stuck_over_15min ?? []}
              onSelect={setSelectedAnalysisId}
              selectedId={selectedAnalysisId}
            />
          </Box>
          {selectedAnalysisId ? (
            <Card
              shadow="xs"
              padding={0}
              radius="md"
              withBorder
              style={{ flex: '0 0 360px', maxWidth: 420 }}
            >
              <StuckCasePanel
                analysisId={selectedAnalysisId}
                onClose={() => setSelectedAnalysisId(null)}
              />
            </Card>
          ) : null}
        </Group>
      )}
    </Stack>
  );
}
