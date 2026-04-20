// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * AuditBrowserView (T289, T436).
 *
 * Plain-English: filterable, paginated table of FHIR AuditEvents for this
 * tenant. Summaries are PHI-free — we surface category + actor (user id
 * only) + outcome + a short text hint. Filters: date range + category.
 */
import { Suspense, useMemo, useState } from 'react';
import { Box, Group, Stack, Table, Text } from '@mantine/core';
import { IconAlertCircle, IconHistory, IconRefresh } from '@tabler/icons-react';
import {
  EMRAlert as Alert,
  EMRButton,
  EMREmptyState as EmptyState,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableSkeleton as Skeleton,
} from '../../components/common';
import { EMRSelect } from '../../components/shared/EMRFormFields';
import { useAdminAudit, type AuditFilters } from '../../hooks/useAdminAudit';
import { useTranslation } from '../../contexts/TranslationContext';

const CATEGORIES = [
  'admin_invite',
  'admin_suspend_user',
  'admin_configure_pacs',
  'admin_approve_deletion',
  'admin_override_coverage',
  'permission_check',
  'study_upload',
  'analysis_cancel',
  'analysis_retry',
  'ruo_acceptance',
  'mfa_challenge',
  'onboarding_completed',
];

function AuditBrowserInner(): React.ReactElement {
  const { t, locale } = useTranslation();
  const [filters, setFilters] = useState<AuditFilters>({ limit: 100 });
  const { events, loading, error, refetch } = useAdminAudit(filters);

  const setFilter = (patch: Partial<AuditFilters>): void => {
    setFilters((f) => ({ ...f, ...patch }));
  };

  const rows = useMemo(() => events, [events]);

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string}>
      <EMRPageHeader
        icon={IconHistory}
        title={t('admin:audit.title') || 'Audit browser'}
        subtitle={t('admin:audit.subtitle') || 'PHI-free chain-of-hashes audit events for this tenant.'}
        actions={
          <EMRButton variant="ghost" icon={IconRefresh} onClick={refetch}>
            {t('common:refresh') || 'Refresh'}
          </EMRButton>
        }
      />

      <Box
        style={{
          padding: 12,
          borderRadius: 'var(--emr-border-radius-lg)',
          background: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-gray-200)',
        }}
      >
        <Group wrap="wrap" gap="sm" align="flex-end">
          <Stack gap={4}>
            <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
              {t('admin:audit.filters.from') || 'From'}
            </Text>
            <input
              type="datetime-local"
              value={filters.from ?? ''}
              onChange={(e) => setFilter({ from: e.target.value })}
              style={{
                height: 32,
                padding: '4px 8px',
                fontSize: 'var(--emr-font-sm)',
                border: '1px solid var(--emr-gray-300)',
                borderRadius: 'var(--emr-border-radius-sm)',
                background: 'var(--emr-bg-input)',
                color: 'var(--emr-text-primary)',
              }}
              aria-label="from"
            />
          </Stack>
          <Stack gap={4}>
            <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
              {t('admin:audit.filters.to') || 'To'}
            </Text>
            <input
              type="datetime-local"
              value={filters.to ?? ''}
              onChange={(e) => setFilter({ to: e.target.value })}
              style={{
                height: 32,
                padding: '4px 8px',
                fontSize: 'var(--emr-font-sm)',
                border: '1px solid var(--emr-gray-300)',
                borderRadius: 'var(--emr-border-radius-sm)',
                background: 'var(--emr-bg-input)',
                color: 'var(--emr-text-primary)',
              }}
              aria-label="to"
            />
          </Stack>
          <Stack gap={4} style={{ minWidth: 220 }}>
            <EMRSelect
              label={t('admin:audit.filters.category') || 'Category'}
              value={filters.category ?? ''}
              onChange={(v) => setFilter({ category: v ? String(v) : undefined })}
              data={[
                { value: '', label: t('admin:audit.filters.all') || 'All' },
                ...CATEGORIES.map((c) => ({ value: c, label: c })),
              ]}
              size="sm"
            />
          </Stack>
        </Group>
      </Box>

      {error && (
        <Alert variant="error" icon={IconAlertCircle} title={t('common:error') || 'Error'}>
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Text fz="var(--emr-font-sm)" style={{ minWidth: 0, flex: 1 }}>
              {error.message}
            </Text>
            <EMRButton size="sm" variant="secondary" onClick={refetch}>
              {t('common:retry') || 'Retry'}
            </EMRButton>
          </Group>
        </Alert>
      )}

      {loading && rows.length === 0 && <Skeleton rows={10} columns={5} />}

      {!loading && !error && rows.length === 0 && (
        <EmptyState
          title={t('admin:audit.empty.title') || 'No events'}
          description={
            t('admin:audit.empty.description') ||
            'No audit events match the current filters.'
          }
        />
      )}

      {rows.length > 0 && (
        <Box
          style={{
            borderRadius: 'var(--emr-border-radius-lg)',
            border: '1px solid var(--emr-gray-200)',
            overflow: 'hidden',
            background: 'var(--emr-bg-card)',
          }}
        >
          <Table striped verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('admin:audit.col.seq') || '#'}</Table.Th>
                <Table.Th>{t('admin:audit.col.recorded') || 'Recorded'}</Table.Th>
                <Table.Th>{t('admin:audit.col.category') || 'Category'}</Table.Th>
                <Table.Th>{t('admin:audit.col.actor') || 'Actor'}</Table.Th>
                <Table.Th>{t('admin:audit.col.outcome') || 'Outcome'}</Table.Th>
                <Table.Th>{t('admin:audit.col.summary') || 'Summary'}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((ev) => (
                <Table.Tr key={ev.id}>
                  <Table.Td>
                    <Text fz="var(--emr-font-xs)" style={{ fontFamily: 'var(--emr-font-mono)' }}>
                      {ev.sequence_no}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
                      {new Date(ev.recorded).toLocaleString(locale)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text fz="var(--emr-font-sm)" fw={500}>
                      {ev.category}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text fz="var(--emr-font-xs)" style={{ fontFamily: 'var(--emr-font-mono)' }}>
                      {ev.actor ?? '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text
                      fz="var(--emr-font-xs)"
                      fw={600}
                      c={ev.outcome === 'success' ? 'var(--emr-success)' : 'var(--emr-error)'}
                      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      {ev.outcome}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
                      {ev.summary ?? ''}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      )}
    </Stack>
  );
}

export default function AuditBrowserView(): React.ReactElement {
  return (
    <EMRErrorBoundary>
      <Suspense fallback={<Skeleton rows={10} columns={5} />}>
        <AuditBrowserInner />
      </Suspense>
    </EMRErrorBoundary>
  );
}
