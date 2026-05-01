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
 */

import {
  Badge,
  Box,
  Card,
  Divider,
  Group,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Text,
} from '@mantine/core';
import {
  IconActivity,
  IconAlertTriangle,
  IconCheck,
  IconCpu,
  IconRefresh,
  IconShieldCheck,
  IconSnowflake,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../contexts/TranslationContext';
import { useOpsQueue, type OpsAnalysisSummary } from '../../hooks/useOpsQueue';
import { QueueDepthGauge } from '../../components/ops/QueueDepthGauge';
import { StuckCasePanel } from '../../components/ops/StuckCasePanel';
import {
  EMRAlert as Alert,
  EMRButton,
  EMREmptyState as EMREmpty,
  EMRPageHeader,
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
        <EMREmpty
          icon={IconShieldCheck}
          title={t('ops:header.noStuckTitle') || 'Pipeline is healthy'}
          description={t('ops:header.noStuckDescription') || 'No analyses have been stuck for more than 15 minutes.'}
        />
      </Box>
    );
  }
  return (
    <ScrollArea>
      <Table
        highlightOnHover
        withRowBorders
        striped
        verticalSpacing="sm"
        horizontalSpacing="md"
        data-testid="ops-stuck-table"
      >
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
            const stuckSeverity = (item.stuck_minutes ?? 0) >= 30 ? 'red' : 'yellow';
            return (
              <Table.Tr
                key={item.analysis_id}
                onClick={() => onSelect(item.analysis_id)}
                style={{
                  cursor: 'pointer',
                  backgroundColor: isSel
                    ? 'var(--emr-bg-card-hover, var(--emr-gray-50))'
                    : undefined,
                  outline: isSel ? '2px solid var(--emr-secondary)' : undefined,
                  outlineOffset: -2,
                }}
                data-testid={`ops-stuck-row-${item.analysis_id}`}
              >
                <Table.Td>
                  <Text fz="xs" ff="monospace" fw={600}>
                    {item.analysis_id.slice(0, 8)}…
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge
                    size="sm"
                    variant="light"
                    color={item.status === 'running' ? 'blue' : 'yellow'}
                    style={{ textTransform: 'none' }}
                  >
                    {item.status}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text fz="sm">{item.last_stage ?? '—'}</Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="light" color={stuckSeverity} style={{ textTransform: 'none' }}>
                    {fmtMinutes(item.stuck_minutes)}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {item.error_slug ? (
                    <Text fz="xs" ff="monospace" c="var(--emr-error)">
                      {item.error_slug}
                    </Text>
                  ) : (
                    <Text fz="xs" c="var(--emr-text-secondary)">
                      —
                    </Text>
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

function MetricCard({
  icon: Icon,
  label,
  value,
  testId,
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  value: string;
  testId: string;
}): JSX.Element {
  return (
    <Card
      shadow="xs"
      padding="md"
      radius="md"
      withBorder
      style={{ minWidth: 160, flex: '1 1 160px' }}
    >
      <Stack gap={6} align="center" data-testid={testId}>
        <Icon size={26} />
        <Text fw={700} fz="xl">
          {value}
        </Text>
        <Text fz="xs" c="dimmed" ta="center">
          {label}
        </Text>
      </Stack>
    </Card>
  );
}

export default function OpsQueueView(): JSX.Element {
  const { t, locale } = useTranslation();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const { view, isLoading, isError, error, refetch } = useOpsQueue({
    refetchIntervalMs: autoRefresh ? 5_000 : 0,
  });
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    if (view) setLastUpdated(new Date());
  }, [view]);

  const lastUpdatedLabel = useMemo(() => {
    if (!lastUpdated) return null;
    return lastUpdated.toLocaleTimeString(locale);
  }, [lastUpdated, locale]);

  const handleManualRefresh = (): void => {
    void refetch();
  };

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string} data-testid="ops-queue-view">
      <EMRPageHeader
        icon={IconActivity}
        title={t('ops:page.title')}
        subtitle={t('ops:page.subtitle')}
        actions={
          <Group gap="xs" wrap="wrap">
            <Badge color="green" variant="light" leftSection={<IconShieldCheck size={12} />}>
              {t('ops:page.no_phi_badge')}
            </Badge>
            {lastUpdatedLabel && (
              <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
                {t('ops:header.lastUpdated', { time: lastUpdatedLabel }) || `Last updated ${lastUpdatedLabel}`}
              </Text>
            )}
            <Switch
              size="sm"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.currentTarget.checked)}
              label={
                autoRefresh
                  ? t('ops:header.autoRefreshOn') || 'Auto-refresh on (every 5s)'
                  : t('ops:header.autoRefreshOff') || 'Auto-refresh paused'
              }
              aria-label={t('ops:header.autoRefresh') || 'Auto-refresh'}
            />
            <EMRButton
              variant="ghost"
              icon={IconRefresh}
              onClick={handleManualRefresh}
            >
              {t('ops:header.refresh') || 'Refresh now'}
            </EMRButton>
          </Group>
        }
      />

      {isError ? (
        <Alert
          variant="error"
          icon={IconAlertTriangle}
          title={t('ops:errors.load_title')}
          data-testid="ops-queue-error"
        >
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Text fz="var(--emr-font-sm)" style={{ flex: 1, minWidth: 0 }}>
              {error?.message ?? t('ops:errors.load_body')}
            </Text>
            <EMRButton size="sm" variant="secondary" onClick={handleManualRefresh}>
              {t('common:retry') || 'Retry'}
            </EMRButton>
          </Group>
        </Alert>
      ) : null}

      {/* Gauges + metrics row. Responsive: wraps on mobile. */}
      <Group gap="md" wrap="wrap" align="stretch">
        <Card shadow="xs" padding="md" radius="md" withBorder style={{ minWidth: 180 }}>
          <QueueDepthGauge
            label={t('ops:gauges.queued')}
            count={view?.queued.length ?? 0}
            testId="ops-gauge-queued"
          />
        </Card>
        <Card shadow="xs" padding="md" radius="md" withBorder style={{ minWidth: 180 }}>
          <QueueDepthGauge
            label={t('ops:gauges.running')}
            count={view?.running.length ?? 0}
            testId="ops-gauge-running"
          />
        </Card>
        <Card shadow="xs" padding="md" radius="md" withBorder style={{ minWidth: 180 }}>
          <QueueDepthGauge
            label={t('ops:gauges.stuck')}
            count={view?.stuck_over_15min.length ?? 0}
            warnThreshold={1}
            alarmThreshold={3}
            testId="ops-gauge-stuck"
          />
        </Card>

        <MetricCard
          icon={IconCpu}
          label={t('ops:gauges.gpu_utilization')}
          value={`${(view?.gpu_utilization_pct ?? 0).toFixed(0)}%`}
          testId="ops-gpu-panel"
        />

        <MetricCard
          icon={IconSnowflake}
          label={t('ops:gauges.cold_starts')}
          value={(view?.cold_start_rate_last_hour ?? 0).toFixed(2)}
          testId="ops-cold-start-panel"
        />
      </Group>

      <Divider
        label={
          <Group gap={6}>
            <IconAlertTriangle size={14} />
            <Text fz="var(--emr-font-sm)" fw={600}>
              {t('ops:sections.stuck_cases')}
            </Text>
            {view && view.stuck_over_15min.length > 0 && (
              <Badge size="sm" color="yellow" variant="light">
                {view.stuck_over_15min.length}
              </Badge>
            )}
          </Group>
        }
        labelPosition="left"
      />

      {isLoading ? (
        <Skeleton rows={5} columns={5} data-testid="ops-stuck-loading" />
      ) : (
        <Group align="flex-start" wrap="wrap" gap="md" style={{ alignItems: 'stretch' }}>
          <Box style={{ flex: '1 1 480px', minWidth: 0 }}>
            {view && view.stuck_over_15min.length > 0 && (
              <Box
                style={{
                  borderRadius: 'var(--emr-border-radius-lg)',
                  border: '1px solid var(--emr-gray-200)',
                  overflow: 'hidden',
                  background: 'var(--emr-bg-card)',
                  boxShadow: 'var(--emr-shadow-sm)',
                }}
              >
                <StuckTable
                  items={view.stuck_over_15min}
                  onSelect={setSelectedAnalysisId}
                  selectedId={selectedAnalysisId}
                />
              </Box>
            )}
            {(!view || view.stuck_over_15min.length === 0) && (
              <EMREmpty
                icon={IconCheck}
                title={t('ops:header.noStuckTitle') || 'Pipeline is healthy'}
                description={t('ops:header.noStuckDescription') || 'No analyses have been stuck for more than 15 minutes.'}
              />
            )}
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
          ) : view && view.stuck_over_15min.length > 0 ? (
            <Card
              shadow="xs"
              padding="md"
              radius="md"
              withBorder
              style={{ flex: '0 0 360px', maxWidth: 420 }}
            >
              <Stack gap="xs" align="center" justify="center" style={{ minHeight: 200 }}>
                <IconActivity size={28} color="var(--emr-text-secondary)" />
                <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)" ta="center">
                  {t('ops:header.selectCase') || 'Select a stuck case from the table to view actions.'}
                </Text>
              </Stack>
            </Card>
          ) : null}
        </Group>
      )}
    </Stack>
  );
}
