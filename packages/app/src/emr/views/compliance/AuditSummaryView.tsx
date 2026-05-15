// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AuditSummaryView (T346, T449).
 *
 * Plain-English: the compliance reviewer picks a tenant + a date range,
 * clicks "Verify chain", and this view:
 *
 *   1. POSTs to `/compliance/audit-summary` via `useAuditSummary()`,
 *   2. hands the response to `<AuditChainVerifier>` which renders the
 *      chain-valid badge (green) or first-invalid-seq highlight (red)
 *      plus S3 Merkle anchor links,
 *   3. renders a tamper-evident event table below with a "download
 *      report" button (the JSON the server already returned — kept
 *      client-side as a Blob download so no extra endpoint is needed).
 *
 * Tenant selection: the reviewer can have ComplianceAssignment for
 * multiple tenants (data-model §21). For MVP we use the user's own
 * `tenant.id` from `useAuth()`; the dropdown hook-point is marked
 * with a TODO for when ComplianceAssignment ships its scope endpoint.
 *
 * Spec refs: SC-010, FR-029a, research.md §A.3, data-model.md §14 / §21.
 */

import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Group,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { IconCalendar, IconDownload } from '@tabler/icons-react';

import {
  EMRAlert as Alert,
  EMRButton,
  EMRCard,
  EMREmptyState as EmptyState,
  EMRPageHeader,
  EMRTableSkeleton as Skeleton,
} from '../../components/common';
import { EMRDatePicker } from '../../components/shared/EMRFormFields/EMRDatePicker';
import { EMRSelect } from '../../components/shared/EMRFormFields/EMRSelect';
import { AuditChainVerifier } from '../../components/compliance/AuditChainVerifier';
import { useTranslation } from '../../contexts/TranslationContext';
import { useAuditSummary } from '../../hooks/useAuditSummary';
import { useAuth } from '../../services/auth';

function toStartIso(d: Date | null): string | null {
  if (!d) return null;
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.toISOString();
}

function toEndIso(d: Date | null): string | null {
  if (!d) return null;
  const c = new Date(d);
  c.setHours(23, 59, 59, 999);
  return c.toISOString();
}

function downloadJsonBlob(data: unknown, filename: string): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function AuditSummaryView(): ReactElement {
  const { t } = useTranslation();
  const { tenant } = useAuth();

  const today = useMemo(() => new Date(), []);
  const sevenDaysAgo = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 7);
    return d;
  }, [today]);

  const [tenantId, setTenantId] = useState<string | null>(tenant?.id ?? null);
  const [fromDate, setFromDate] = useState<Date | null>(sevenDaysAgo);
  const [toDate, setToDate] = useState<Date | null>(today);
  // Category filter (002-acr-structured-readout FR-019). Sentinel `__all__`
  // means "no filter"; otherwise restrict to one AuditCategory value
  // (e.g., `readout_clipboard_export`).
  const [categoryFilter, setCategoryFilter] = useState<string>('__all__');
  const [committed, setCommitted] = useState<{
    tenantId: string | null;
    from: string | null;
    to: string | null;
  }>({ tenantId: null, from: null, to: null });

  // Only kick off the query when the user clicks "verify chain".
  const { summary, isLoading, isError, error } = useAuditSummary(committed);

  // Categories present in the current result set; drives the filter dropdown.
  const categoryOptions = useMemo(() => {
    const seen = new Set<string>(summary?.events.map((e) => e.category) ?? []);
    const opts = Array.from(seen).sort().map((c) => ({ value: c, label: c }));
    return [{ value: '__all__', label: t('compliance:audit.categoryAll') ?? 'All categories' }, ...opts];
  }, [summary, t]);

  const filteredEvents = useMemo(() => {
    if (!summary) return [];
    if (categoryFilter === '__all__') return summary.events;
    return summary.events.filter((e) => e.category === categoryFilter);
  }, [summary, categoryFilter]);

  const canSubmit = Boolean(tenantId && fromDate && toDate);

  const handleVerify = (): void => {
    if (!canSubmit) return;
    setCommitted({
      tenantId,
      from: toStartIso(fromDate),
      to: toEndIso(toDate),
    });
  };

  const handleDownload = (): void => {
    if (!summary) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJsonBlob(summary, `audit-summary-${stamp}.json`);
  };

  return (
    <Stack gap="md" p="md" data-testid="audit-summary-view">
      <EMRPageHeader
        title={t('compliance:audit.title')}
        subtitle={t('compliance:audit.subtitle')}
      />

      <EMRCard>
        <Stack gap="md">
          <Group align="flex-end" gap="md" wrap="wrap">
            <Box style={{ minWidth: 220 }}>
              <EMRSelect
                data-testid="audit-summary-tenant"
                label={t('compliance:audit.tenantLabel')}
                value={tenantId}
                onChange={setTenantId}
                data={
                  tenant?.id
                    ? [{ value: tenant.id, label: tenant.id }]
                    : []
                }
                placeholder={t('compliance:audit.tenantPlaceholder')}
                // TODO: populate from ComplianceAssignment scope endpoint.
              />
            </Box>
            <Box style={{ minWidth: 180 }}>
              <EMRDatePicker
                label={t('compliance:audit.fromLabel')}
                value={fromDate}
                onChange={setFromDate}
                leftSection={<IconCalendar size={14} aria-hidden="true" />}
                data-testid="audit-summary-from"
              />
            </Box>
            <Box style={{ minWidth: 180 }}>
              <EMRDatePicker
                label={t('compliance:audit.toLabel')}
                value={toDate}
                onChange={setToDate}
                leftSection={<IconCalendar size={14} aria-hidden="true" />}
                data-testid="audit-summary-to"
              />
            </Box>
            <Box style={{ minWidth: 220 }}>
              <EMRSelect
                data-testid="audit-summary-category-filter"
                label={t('compliance:audit.categoryLabel') ?? 'Category'}
                value={categoryFilter}
                onChange={(v) => setCategoryFilter(v ?? '__all__')}
                data={categoryOptions}
              />
            </Box>
            <Group gap="sm">
              <EMRButton
                onClick={handleVerify}
                disabled={!canSubmit}
                data-testid="audit-summary-verify"
              >
                {t('compliance:audit.verifyButton')}
              </EMRButton>
              <EMRButton
                variant="outline"
                onClick={handleDownload}
                disabled={!summary}
                leftSection={<IconDownload size={14} aria-hidden="true" />}
                data-testid="audit-summary-download"
              >
                {t('compliance:audit.downloadButton')}
              </EMRButton>
            </Group>
          </Group>

          <AuditChainVerifier summary={summary} isLoading={isLoading} />
        </Stack>
      </EMRCard>

      <EMRCard>
        <Stack gap="sm">
          <Text fw={600}>{t('compliance:audit.eventsTitle')}</Text>
          {isLoading ? (
            <Skeleton columns={6} rows={8} />
          ) : isError ? (
            <Alert
              variant="error"
              title={t('compliance:audit.errorTitle')}
            >
              {error?.message ?? t('common:genericError')}
            </Alert>
          ) : !summary || filteredEvents.length === 0 ? (
            <EmptyState
              title={t('compliance:audit.emptyTitle')}
              description={t('compliance:audit.emptyDescription')}
            />
          ) : (
            <Box style={{ overflowX: 'auto' }}>
              <Table
                striped
                highlightOnHover
                verticalSpacing="xs"
                aria-label={t('compliance:audit.tableAriaLabel')}
              >
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('compliance:audit.colSeq')}</Table.Th>
                    <Table.Th>{t('compliance:audit.colTimestamp')}</Table.Th>
                    <Table.Th>{t('compliance:audit.colCategory')}</Table.Th>
                    <Table.Th>{t('compliance:audit.colActor')}</Table.Th>
                    <Table.Th>{t('compliance:audit.colSubject')}</Table.Th>
                    <Table.Th>{t('compliance:audit.colOutcome')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {filteredEvents.map((ev) => {
                    const tampered =
                      !summary.chain_valid &&
                      summary.chain_first_invalid_sequence_no === ev.chain_sequence_no;
                    return (
                      <Table.Tr
                        key={ev.id}
                        data-testid="audit-summary-row"
                        data-invalid={tampered ? 'true' : undefined}
                        style={
                          tampered
                            ? {
                                backgroundColor: 'var(--emr-bg-error-light)',
                              }
                            : undefined
                        }
                      >
                        <Table.Td>
                          <Text size="sm" fw={tampered ? 700 : 500}>
                            #{ev.chain_sequence_no}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">
                            {new Date(ev.timestamp).toISOString()}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{ev.category}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{ev.actor || '—'}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" style={{ wordBreak: 'break-all' }}>
                            {ev.subject || '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            color={
                              ev.outcome === 'success'
                                ? 'green'
                                : ev.outcome === 'denied'
                                  ? 'yellow'
                                  : 'red'
                            }
                            variant="light"
                            size="sm"
                          >
                            {ev.outcome}
                          </Badge>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Box>
          )}
        </Stack>
      </EMRCard>
    </Stack>
  );
}
