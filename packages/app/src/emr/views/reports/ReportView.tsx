// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ReportView (T272, T429).
 *
 * Plain-English: the landing page for a finalized Report. Shows:
 *
 *   - A header with finalize time + retracted banner (if applicable).
 *   - "Superseded by Report X" banner that links to the replacement.
 *   - PDF preview (iframe) on the left.
 *   - PACS push panel on the right.
 *   - Retract button (step-up MFA gated via `PermissionButton`).
 *
 * Route: `/reports/:reportId` — wired in `AppRoutes.tsx`.
 */
import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Alert, Badge, Box, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconClockHour3 } from '@tabler/icons-react';

import { useReport } from '../../hooks/useReport';
import { PACSPushPanel } from '../../components/report/PACSPushPanel';
import { PDFPreview } from '../../components/report/PDFPreview';
import { RetractModal } from '../../components/report/RetractModal';
import { PermissionButton } from '../../components/access-control/PermissionButton';
import { useTranslation } from '../../contexts/TranslationContext';

export function ReportView(): JSX.Element {
  const { t } = useTranslation();
  // The app route (`LIVERRA_ROUTES.REPORT_VIEW = '/reports/:id'`) uses `:id`
  // as the param name. We accept either — so both the spec-named location
  // (`views/reports/ReportView.tsx`) and the existing lazy-import target at
  // `views/cases/ReportView.tsx` work interchangeably.
  const params = useParams<{ reportId?: string; id?: string }>();
  const reportId = params.reportId ?? params.id ?? '';
  const navigate = useNavigate();
  const report = useReport(reportId);
  const [retractOpen, setRetractOpen] = useState(false);

  if (!reportId) {
    return (
      <Box p="md">
        <Text>{t('report:view.noId') ?? 'No report id in URL.'}</Text>
      </Box>
    );
  }

  if (report.isLoading) {
    return (
      <Box p="md" data-testid="report-view-loading">
        <Text size="sm" c="dimmed">
          <IconClockHour3 size={14} style={{ verticalAlign: 'middle' }} />{' '}
          {t('report:view.loading') ?? 'Loading report…'}
        </Text>
      </Box>
    );
  }

  if (report.error || !report.data) {
    return (
      <Box p="md" data-testid="report-view-error">
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          {t('report:view.error') ?? 'Unable to load this report.'}
        </Alert>
      </Box>
    );
  }

  const r = report.data;

  return (
    <Stack gap="md" p="md" data-testid="report-view">
      <Group justify="space-between" align="flex-start">
        <Stack gap={2}>
          <Group gap="xs">
            <Title order={3}>
              {t('report:view.title') ?? 'Report'} {r.id.slice(0, 8)}
            </Title>
            <Badge
              color={
                r.status === 'finalized'
                  ? 'green'
                  : r.status === 'retracted'
                    ? 'red'
                    : r.status === 'superseded'
                      ? 'orange'
                      : 'gray'
              }
              variant="light"
            >
              {t(`report:status.${r.status}`) ?? r.status}
            </Badge>
            {r.sample_case_flag ? (
              <Badge color="red" variant="filled" data-testid="report-sample-badge">
                {t('report:view.sampleData') ?? 'SAMPLE DATA'}
              </Badge>
            ) : null}
          </Group>
          {r.finalized_at ? (
            <Text size="xs" c="dimmed">
              {t('report:view.finalizedAt') ?? 'Finalized at:'} {r.finalized_at}
            </Text>
          ) : null}
        </Stack>

        <PermissionButton
          permission="report.retract"
          color="red"
          variant="light"
          disabled={r.status !== 'finalized'}
          onClick={() => setRetractOpen(true)}
          data-testid="report-view-retract-button"
        >
          {t('report:view.retract') ?? 'Retract'}
        </PermissionButton>
      </Group>

      {r.superseded_by_report_id ? (
        <Alert
          color="orange"
          icon={<IconAlertTriangle size={18} />}
          data-testid="report-superseded-banner"
        >
          <Text>
            {t('report:view.supersededBy') ?? 'Superseded by'}{' '}
            <Link to={`/reports/${r.superseded_by_report_id}`}>
              Report {r.superseded_by_report_id.slice(0, 8)}
            </Link>
          </Text>
        </Alert>
      ) : null}

      {r.status === 'retracted' ? (
        <Alert
          color="red"
          icon={<IconAlertTriangle size={18} />}
          data-testid="report-retracted-banner"
        >
          <Text fw={600}>{t('report:view.retracted') ?? 'This report has been retracted.'}</Text>
          {r.retraction_reason ? (
            <Text size="sm" mt={4}>
              {r.retraction_reason}
            </Text>
          ) : null}
        </Alert>
      ) : null}

      <Group align="flex-start" gap="md" wrap="wrap">
        <Box style={{ flex: 2, minWidth: 360 }}>
          <PDFPreview reportId={r.id} />
        </Box>
        <Box style={{ flex: 1, minWidth: 280 }}>
          <PACSPushPanel
            reportId={r.id}
            readonly={r.status !== 'finalized'}
            sampleCase={r.sample_case_flag}
          />
        </Box>
      </Group>

      <RetractModal
        opened={retractOpen}
        onClose={() => setRetractOpen(false)}
        reportId={r.id}
        onRetracted={() => {
          setRetractOpen(false);
          navigate(0);
        }}
      />
    </Stack>
  );
}

export default ReportView;
