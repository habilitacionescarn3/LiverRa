// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ReportInlineView — native React replacement for PDFPreview.
 *
 * Why: the PDF iframe at `/api/v1/reports/{id}/pdf` is intercepted by
 * Opera's content-blocker (ad/tracker/privacy guard, all of which match
 * URL patterns containing `/report/pdf`) and renders ERR_BLOCKED_BY_CLIENT
 * even with the user's adblock toggled off. This component avoids
 * iframes entirely: fetches structured JSON + per-stage PNG images
 * served from URLs that don't match common blocker rules, and renders
 * them in native Mantine components.
 *
 * The PDF download is offered as an explicit user action via window.open()
 * — the browser's native PDF viewer handles it without iframe wrapping.
 */
import { useMemo } from 'react';
import {
  Badge,
  Box,
  Card,
  Group,
  Image,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconDownload, IconInfoCircle } from '@tabler/icons-react';

import { useReport } from '../../hooks/useReport';
import { useRUOClaim } from '../../hooks/useRUOClaim';
import { useTranslation } from '../../contexts/TranslationContext';
import { EMRButton } from '../common/EMRButton';
import { ACRStructuredReadout } from './ACRStructuredReadout';
import type { ReportSummary } from '../../services/report/reportSummary';
import { useReportSummary } from '../../hooks/useReportSummary';

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

function StageImage({
  analysisId,
  stage,
  alt,
}: {
  analysisId: string;
  stage: 'parenchyma' | 'vessels' | 'flr' | 'mesh3d' | 'four-phase';
  alt: string;
}): JSX.Element {
  const base = readApiBaseUrl();
  const src = `${base}/analyses/${encodeURIComponent(analysisId)}/report/render/${stage}`;
  return (
    <Image
      src={src}
      alt={alt}
      radius="sm"
      fit="contain"
      style={{ background: '#000', width: '100%' }}
      fallbackSrc="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='800' height='200'><text x='50%' y='50%' text-anchor='middle' fill='%23999'>render unavailable</text></svg>"
    />
  );
}

function LesionImage({
  analysisId,
  lesionId,
}: {
  analysisId: string;
  lesionId: string;
}): JSX.Element {
  const base = readApiBaseUrl();
  const src = `${base}/analyses/${encodeURIComponent(analysisId)}/report/render/lesion/${encodeURIComponent(lesionId)}`;
  return (
    <Image
      src={src}
      alt={`lesion ${lesionId.slice(0, 8)}`}
      radius="sm"
      fit="contain"
      style={{ background: '#000', width: '100%' }}
      fallbackSrc="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='200'><text x='50%' y='50%' text-anchor='middle' fill='%23999'>lesion preview unavailable</text></svg>"
    />
  );
}

export interface ReportInlineViewProps {
  reportId: string;
  claimKey?: string;
}

export function ReportInlineView({
  reportId,
  claimKey = 'report.pdf',
}: ReportInlineViewProps): JSX.Element {
  const { t } = useTranslation();
  const report = useReport(reportId);
  const claim = useRUOClaim(claimKey);
  const analysisId = report.data?.analysis_id ?? '';

  const { query: summary } = useReportSummary(analysisId);

  const downloadHref = useMemo(() => {
    if (!analysisId) return '';
    const base = readApiBaseUrl();
    return `${base}/analyses/${encodeURIComponent(analysisId)}/report/pdf`;
  }, [analysisId]);

  if (claim.uiGate === 'hidden') {
    return (
      <Box p="md" data-testid="report-inline-claim-hidden">
        <Text size="sm" c="dimmed">
          {t('report:view.claimHidden') ??
            'Report is restricted for the current RUO claim scope.'}
        </Text>
      </Box>
    );
  }

  if (report.isLoading || summary.isLoading) {
    return (
      <Stack align="center" gap="md" p="xl">
        <Loader />
        <Text size="sm" c="dimmed">
          {t('report:view.loading') ?? 'Loading report…'}
        </Text>
      </Stack>
    );
  }

  if (summary.isError || !summary.data) {
    return (
      <Box p="md">
        <Text size="sm" c="red">
          {(summary.error as Error | null)?.message ??
            t('report:view.error') ??
            'Could not load report.'}
        </Text>
      </Box>
    );
  }

  const s = summary.data;
  const liverVol = s.segmentations.find(
    (x) => x.anatomy_category === 'liver',
  )?.volume_ml;

  return (
    <Stack gap="lg" p={{ base: 'md', md: 'lg' } as unknown as string}>
      {/* Top action bar */}
      <Group justify="space-between" wrap="wrap">
        <Title order={3} style={{ margin: 0 }}>
          {t('report:view.heading') ?? 'Analysis report'}
        </Title>
        <Group gap="xs">
          <EMRButton
            variant="secondary"
            icon={IconDownload}
            onClick={() => {
              const base = readApiBaseUrl();
              window.open(
                `${base}/analyses/${encodeURIComponent(analysisId)}/report/per-slice-pdf`,
                '_blank',
                'noopener,noreferrer',
              );
            }}
          >
            {t('report:view.downloadPerSlice') ?? 'Per-slice PDF'}
          </EMRButton>
          <EMRButton
            variant="primary"
            icon={IconDownload}
            onClick={() => window.open(downloadHref, '_blank', 'noopener,noreferrer')}
          >
            {t('report:view.downloadPdf') ?? 'Download PDF'}
          </EMRButton>
        </Group>
      </Group>

      {/* QC flags banner */}
      {s.qc_flags.length > 0 && (
        <Stack gap={6}>
          {s.qc_flags.map((f) => (
            <Card
              key={f.code}
              withBorder
              radius="sm"
              padding="sm"
              style={{
                // H-ACR-3: replaced forbidden Tailwind blues + raw
                // warning hex with semantic theme tokens so light/dark
                // both auto-resolve correctly.
                borderColor:
                  f.level === 'warn'
                    ? 'var(--emr-warning)'
                    : 'var(--emr-info)',
                background:
                  f.level === 'warn'
                    ? 'var(--emr-warning-bg)'
                    : 'var(--emr-info-bg)',
              }}
            >
              <Group gap="xs" wrap="nowrap">
                {f.level === 'warn' ? (
                  <IconAlertTriangle size={16} color="var(--emr-warning-text)" />
                ) : (
                  <IconInfoCircle size={16} color="var(--emr-info)" />
                )}
                <Text size="sm" style={{ flex: 1 }}>
                  {f.message}
                </Text>
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      {/* ACR-aligned structured anatomical readout (002-acr-structured-readout). */}
      <ACRStructuredReadout analysisId={analysisId} />

      {/* Stats grid */}
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatCard
          label={t('report:view.stats.liver') ?? 'Liver volume'}
          value={liverVol ? `${liverVol.toFixed(0)} ml` : '—'}
        />
        <StatCard
          label={t('report:view.stats.flr') ?? 'Future Liver Remnant'}
          value={s.flr?.flr_pct != null ? `${s.flr.flr_pct.toFixed(1)} %` : '—'}
          subtitle={
            s.flr?.flr_ml != null
              ? `${s.flr.flr_ml.toFixed(0)} ml`
              : undefined
          }
        />
        <StatCard
          label={t('report:view.stats.lesions') ?? 'Lesions'}
          value={`${s.lesions.length}`}
        />
        <StatCard
          label={t('report:view.stats.status') ?? 'Status'}
          value={s.status}
        />
      </SimpleGrid>

      {/* Per-stage cards */}
      <Card withBorder radius="md" padding="md">
        <Title order={4} mb="sm">
          {t('report:view.parenchymaTitle') ?? 'Parenchyma segmentation'}
        </Title>
        <Text size="xs" c="dimmed" mb="sm">
          6 axial + 2 coronal + 2 sagittal slices through the liver bbox, red contour overlay.
        </Text>
        <StageImage analysisId={analysisId} stage="parenchyma" alt="parenchyma mosaic" />
      </Card>

      <Card withBorder radius="md" padding="md">
        <Title order={4} mb="sm">
          {t('report:view.vesselsTitle') ?? 'Vessels'}
        </Title>
        <Text size="xs" c="dimmed" mb="sm">
          Coronal MIP showing portal + hepatic vein tree (cyan) within the liver outline (red).
        </Text>
        <StageImage analysisId={analysisId} stage="vessels" alt="vessels mosaic" />
      </Card>

      <Card withBorder radius="md" padding="md">
        <Title order={4} mb="sm">
          {t('report:view.flrTitle') ?? 'FLR — resection plane'}
        </Title>
        <Text size="xs" c="dimmed" mb="sm">
          Coronal + sagittal views with the cutting plane (yellow dashed line). FLR (green) above
          the plane, remnant (red) below. Heuristic axial-midpoint — not surgically validated.
        </Text>
        <StageImage analysisId={analysisId} stage="flr" alt="flr cutting plane" />
      </Card>

      <Card withBorder radius="md" padding="md">
        <Title order={4} mb="sm">
          {t('report:view.fourPhaseTitle') ?? '4-phase comparison'}
        </Title>
        <Text size="xs" c="dimmed" mb="sm">
          Same axial slice across all 4 phases — radiology gold-standard for
          hypervascular vs hypovascular lesion characterisation.
        </Text>
        <StageImage analysisId={analysisId} stage="four-phase" alt="4-phase axial comparison" />
      </Card>

      <Card withBorder radius="md" padding="md">
        <Title order={4} mb="sm">
          {t('report:view.mesh3dTitle') ?? '3D liver mesh'}
        </Title>
        <Text size="xs" c="dimmed" mb="sm">
          Marching-cubes surface render of the parenchyma mask (downsampled).
        </Text>
        <StageImage analysisId={analysisId} stage="mesh3d" alt="3D liver mesh" />
      </Card>

      {/* Lesions */}
      {s.lesions.length > 0 && (
        <Card withBorder radius="md" padding="md">
          <Title order={4} mb="sm">
            {t('report:view.lesionsTitle') ?? `Lesions (${s.lesions.length})`}
          </Title>
          <Stack gap="md">
            {s.lesions.slice(0, 10).map((l) => (
              <Box key={l.id}>
                <Group gap="xs" mb={4}>
                  <Badge variant="light" color="yellow">
                    {l.id.slice(0, 8)}
                  </Badge>
                  {l.longest_diameter_mm != null && (
                    <Text size="xs" c="dimmed">
                      Ø {l.longest_diameter_mm.toFixed(1)} mm
                    </Text>
                  )}
                </Group>
                <LesionImage analysisId={analysisId} lesionId={l.id} />
              </Box>
            ))}
            {s.lesions.length > 10 && (
              <Text size="xs" c="dimmed">
                + {s.lesions.length - 10} more lesions (omitted from preview)
              </Text>
            )}
          </Stack>
        </Card>
      )}

      {/* Pipeline + model versions */}
      <Card withBorder radius="md" padding="md">
        <Title order={4} mb="sm">
          {t('report:view.pipelineTitle') ?? 'Pipeline checkpoints'}
        </Title>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>#</Table.Th>
              <Table.Th>Stage</Table.Th>
              <Table.Th>Model version</Table.Th>
              <Table.Th>Written at</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {s.stages.map((st) => (
              <Table.Tr key={st.stage_no}>
                <Table.Td>{st.stage_no}</Table.Td>
                <Table.Td>{st.stage}</Table.Td>
                <Table.Td>
                  <Text size="xs" ff="monospace">
                    {st.model_version ?? '—'}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {st.written_at?.replace('T', ' ').slice(0, 19) ?? '—'}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
    </Stack>
  );
}

function StatCard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string;
  subtitle?: string;
}): JSX.Element {
  return (
    <Card withBorder radius="md" padding="sm" style={{ minWidth: 0 }}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="lg" fw={700} mt={2}>
        {value}
      </Text>
      {subtitle && (
        <Text size="xs" c="dimmed">
          {subtitle}
        </Text>
      )}
    </Card>
  );
}
