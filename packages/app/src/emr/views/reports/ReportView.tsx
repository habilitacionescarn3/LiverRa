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
import { useEffect, useState, type ReactElement } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Badge, Box, Group, Stack, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconClipboardX,
  IconFileText,
} from '@tabler/icons-react';

import { useReport } from '../../hooks/useReport';
import { PACSPushPanel } from '../../components/report/PACSPushPanel';
import { PDFPreview } from '../../components/report/PDFPreview';
import { RetractModal } from '../../components/report/RetractModal';
import { PermissionButton } from '../../components/access-control/PermissionButton';
import {
  EMRAlert,
  EMRButton,
  EMREmptyState,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRSkeleton,
} from '../../components/common';
import { RUODisclaimer } from '../../components/ruo/RUODisclaimer';
import { useTranslation } from '../../contexts/TranslationContext';

function ReportViewBody(): ReactElement {
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

  // Reasonable browser tab title — falls back gracefully if reportId is empty.
  useEffect(() => {
    const base = t('report:view.title') ?? 'Report';
    document.title = reportId
      ? `${base} ${reportId.slice(0, 8)} · LiverRa`
      : `${base} · LiverRa`;
  }, [reportId, t]);

  // Missing route param — empty state with a navigation back to cases list.
  if (!reportId) {
    return (
      <Box p={{ base: 'md', md: 'lg' }} data-testid="report-view-no-id">
        <EMREmptyState
          icon={IconClipboardX}
          title={t('report:view.noId') ?? 'No report id in URL.'}
          description={
            t('report:view.noIdDescription') ??
            'Open a finalized analysis from your cases list to view its report.'
          }
          action={{
            label: t('analysis:detail.back') ?? 'Back to cases',
            onClick: () => navigate('/emr/cases'),
            icon: IconArrowLeft,
          }}
        />
      </Box>
    );
  }

  // Loading — skeleton, not blank screen.
  if (report.isLoading) {
    return (
      <Stack
        gap="lg"
        p={{ base: 'md', md: 'lg' }}
        data-testid="report-view-loading"
      >
        <EMRSkeleton height={56} width="60%" />
        <Group align="flex-start" gap="md" wrap="wrap">
          <Box style={{ flex: 2, minWidth: 320 }}>
            <EMRSkeleton height={520} />
          </Box>
          <Box style={{ flex: 1, minWidth: 280 }}>
            <Stack gap="sm">
              <EMRSkeleton height={32} width="50%" />
              <EMRSkeleton height={120} />
              <EMRSkeleton height={120} />
            </Stack>
          </Box>
        </Group>
      </Stack>
    );
  }

  // Error — actionable retry + back affordances rather than a dead-end alert.
  if (report.error || !report.data) {
    return (
      <Stack
        gap="lg"
        p={{ base: 'md', md: 'lg' }}
        data-testid="report-view-error"
      >
        <EMRPageHeader
          icon={IconFileText}
          title={t('report:view.title') ?? 'Report'}
          showBack
          onBack={() => navigate(-1)}
        />
        <EMRAlert
          variant="error"
          icon={IconAlertTriangle}
          title={t('report:view.error') ?? 'Unable to load this report.'}
        >
          <Stack gap="sm">
            <Text size="sm" c="var(--emr-text-secondary)">
              {report.error instanceof Error
                ? report.error.message
                : t('common:genericError') ?? 'Something went wrong.'}
            </Text>
            <Group gap="xs">
              <EMRButton
                variant="secondary"
                onClick={() => report.refetch?.()}
                data-testid="report-view-retry"
              >
                {t('common:retry') ?? 'Retry'}
              </EMRButton>
              <EMRButton
                variant="ghost"
                icon={IconArrowLeft}
                onClick={() => navigate('/emr/cases')}
              >
                {t('analysis:detail.back') ?? 'Back to cases'}
              </EMRButton>
            </Group>
          </Stack>
        </EMRAlert>
      </Stack>
    );
  }

  const r = report.data;
  const statusKey = `report:status.${r.status}`;
  const statusLabel = t(statusKey) ?? r.status;
  // Map report status → semantic Mantine colour family. Keeps the badge
  // visually consistent with statuses elsewhere in the app.
  const statusColor: 'green' | 'red' | 'orange' | 'gray' =
    r.status === 'finalized'
      ? 'green'
      : r.status === 'retracted'
        ? 'red'
        : r.status === 'superseded'
          ? 'orange'
          : 'gray';

  return (
    <Stack
      gap="lg"
      p={{ base: 'md', md: 'lg' }}
      data-testid="report-view"
      style={{ minHeight: 'calc(100vh - 64px)' }}
    >
      <EMRPageHeader
        icon={IconFileText}
        title={`${t('report:view.title') ?? 'Report'} ${r.id.slice(0, 8)}`}
        subtitle={
          r.finalized_at
            ? `${t('report:view.finalizedAt') ?? 'Finalized at'} ${r.finalized_at}`
            : undefined
        }
        showBack
        onBack={() => navigate(-1)}
        actions={
          <Group gap="xs" wrap="wrap">
            <Badge color={statusColor} variant="light" size="lg">
              {statusLabel}
            </Badge>
            {r.sample_case_flag && (
              <Badge
                color="red"
                variant="filled"
                data-testid="report-sample-badge"
              >
                {t('report:view.sampleData') ?? 'SAMPLE DATA'}
              </Badge>
            )}
            <PermissionButton
              permission="report.retract"
              variant="danger"
              disabled={r.status !== 'finalized'}
              onClick={() => setRetractOpen(true)}
              data-testid="report-view-retract-button"
            >
              {t('report:view.retract') ?? 'Retract'}
            </PermissionButton>
          </Group>
        }
      />

      {r.superseded_by_report_id && (
        <EMRAlert
          variant="warning"
          icon={IconAlertTriangle}
          data-testid="report-superseded-banner"
        >
          <Text size="sm">
            {t('report:view.supersededBy') ?? 'Superseded by'}{' '}
            <Link
              to={`/reports/${r.superseded_by_report_id}`}
              style={{
                color: 'var(--emr-secondary)',
                fontWeight: 600,
                textDecoration: 'underline',
              }}
            >
              Report {r.superseded_by_report_id.slice(0, 8)}
            </Link>
          </Text>
        </EMRAlert>
      )}

      {r.status === 'retracted' && (
        <EMRAlert
          variant="error"
          icon={IconAlertTriangle}
          title={
            t('report:view.retracted') ?? 'This report has been retracted.'
          }
          data-testid="report-retracted-banner"
        >
          {r.retraction_reason && (
            <Text size="sm" c="var(--emr-text-secondary)" mt={4}>
              {r.retraction_reason}
            </Text>
          )}
        </EMRAlert>
      )}

      <Box
        className="liverra-report-grid"
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'minmax(0, 1fr)',
          alignItems: 'flex-start',
        }}
      >
        {/* Inline media query so the panel stacks on mobile and goes 2-col on
            tablet+. Avoids a separate CSS module file (project rule: keep
            view-local style colocated). */}
        <style>
          {`
            @media (min-width: 900px) {
              .liverra-report-grid {
                grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) !important;
              }
            }
          `}
        </style>
        <Box
          style={{
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-border-color, var(--emr-gray-200))',
            borderRadius: 'var(--emr-border-radius-lg, 12px)',
            overflow: 'hidden',
            minWidth: 0,
          }}
        >
          <PDFPreview reportId={r.id} />
        </Box>
        <Box
          style={{
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-border-color, var(--emr-gray-200))',
            borderRadius: 'var(--emr-border-radius-lg, 12px)',
            padding: 12,
            minWidth: 0,
          }}
        >
          <PACSPushPanel
            reportId={r.id}
            readonly={r.status !== 'finalized'}
            sampleCase={r.sample_case_flag}
          />
        </Box>
      </Box>

      <RetractModal
        opened={retractOpen}
        onClose={() => setRetractOpen(false)}
        reportId={r.id}
        onRetracted={() => {
          setRetractOpen(false);
          navigate(0);
        }}
      />

      {/* Persistent RUO disclaimer — fixed bottom-right per FR-028 */}
      <RUODisclaimer />
    </Stack>
  );
}

export function ReportView(): ReactElement {
  return (
    <EMRErrorBoundary componentName="ReportView">
      <ReportViewBody />
    </EMRErrorBoundary>
  );
}

export default ReportView;
