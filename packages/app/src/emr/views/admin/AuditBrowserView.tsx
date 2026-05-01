// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * AuditBrowserView (T289, T436).
 *
 * Plain-English: filterable, paginated table of FHIR AuditEvents for this
 * tenant. Summaries are PHI-free — we surface category + actor (user id
 * only) + outcome + a short text hint. Filters: date range + category.
 * Click any row to open a slide-out drawer with the full event JSON.
 */
import { Suspense, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Code,
  Drawer,
  Group,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCopy,
  IconExternalLink,
  IconHistory,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import {
  EMRAlert as Alert,
  EMRButton,
  EMRCard,
  EMREmptyState as EmptyState,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableSkeleton as Skeleton,
} from '../../components/common';
import { EMRSelect } from '../../components/shared/EMRFormFields';
import {
  useAdminAudit,
  type AuditEventRow,
  type AuditFilters,
} from '../../hooks/useAdminAudit';
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

function OutcomeBadge({ outcome }: { outcome: string }): React.ReactElement {
  const { t } = useTranslation();
  const map: Record<string, { color: string; label: string }> = {
    success: { color: 'green', label: t('admin:audit.outcome.success') || 'Success' },
    denied: { color: 'yellow', label: t('admin:audit.outcome.denied') || 'Denied' },
    error: { color: 'red', label: t('admin:audit.outcome.error') || 'Error' },
  };
  const cfg = map[outcome] ?? { color: 'gray', label: outcome };
  return (
    <Badge variant="light" color={cfg.color} size="sm" style={{ textTransform: 'none' }}>
      {cfg.label}
    </Badge>
  );
}

function FilterDateInput({
  label,
  value,
  onChange,
  ariaLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
}): React.ReactElement {
  return (
    <Stack gap={4}>
      <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)" fw={500}>
        {label}
      </Text>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        style={{
          height: 36,
          minWidth: 200,
          padding: '6px 10px',
          fontSize: 'var(--emr-font-sm)',
          border: '1px solid var(--emr-gray-300)',
          borderRadius: 'var(--emr-border-radius-md)',
          background: 'var(--emr-bg-input, var(--emr-bg-card))',
          color: 'var(--emr-text-primary)',
          fontFamily: 'inherit',
        }}
      />
    </Stack>
  );
}

function AuditBrowserInner(): React.ReactElement {
  const { t, locale } = useTranslation();
  const [filters, setFilters] = useState<AuditFilters>({ limit: 100 });
  const { events, loading, error, refetch } = useAdminAudit(filters);
  const [selected, setSelected] = useState<AuditEventRow | null>(null);
  const [copied, setCopied] = useState(false);

  const setFilter = (patch: Partial<AuditFilters>): void => {
    setFilters((f) => ({ ...f, ...patch }));
  };

  const clearFilters = (): void => {
    setFilters({ limit: 100 });
  };

  const rows = useMemo(() => events, [events]);
  const hasFilters = Boolean(filters.from || filters.to || filters.category);

  const handleCopy = async (): Promise<void> => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string}>
      <EMRPageHeader
        icon={IconHistory}
        title={t('admin:audit.title') || 'Audit browser'}
        subtitle={t('admin:audit.subtitle') || 'PHI-free chain-of-hashes audit events for this tenant.'}
        badge={rows.length > 0 ? { count: rows.length, variant: 'default' } : undefined}
        actions={
          <EMRButton variant="ghost" icon={IconRefresh} onClick={refetch}>
            {t('common:refresh') || 'Refresh'}
          </EMRButton>
        }
      />

      <EMRCard padding="md">
        <Stack gap="sm">
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Text fz="var(--emr-font-sm)" fw={600}>
              {t('admin:audit.filters.title') || 'Filter events'}
            </Text>
            {hasFilters && (
              <EMRButton size="sm" variant="ghost" icon={IconX} onClick={clearFilters}>
                {t('admin:audit.filters.clear') || 'Clear filters'}
              </EMRButton>
            )}
          </Group>
          <Group wrap="wrap" gap="md" align="flex-end">
            <FilterDateInput
              label={t('admin:audit.filters.from') || 'From'}
              ariaLabel={t('admin:audit.filters.from') || 'From'}
              value={filters.from ?? ''}
              onChange={(v) => setFilter({ from: v || undefined })}
            />
            <FilterDateInput
              label={t('admin:audit.filters.to') || 'To'}
              ariaLabel={t('admin:audit.filters.to') || 'To'}
              value={filters.to ?? ''}
              onChange={(v) => setFilter({ to: v || undefined })}
            />
            <Box style={{ minWidth: 240 }}>
              <EMRSelect
                label={t('admin:audit.filters.category') || 'Category'}
                value={filters.category ?? ''}
                onChange={(v) => setFilter({ category: v ? String(v) : undefined })}
                data={[
                  { value: '', label: t('admin:audit.filters.all') || 'All categories' },
                  ...CATEGORIES.map((c) => ({ value: c, label: c })),
                ]}
                size="sm"
              />
            </Box>
          </Group>
        </Stack>
      </EMRCard>

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

      {loading && rows.length === 0 && <Skeleton rows={10} columns={6} />}

      {!loading && !error && rows.length === 0 && (
        <EmptyState
          icon={IconHistory}
          title={t('admin:audit.empty.title') || 'No events'}
          description={
            t('admin:audit.empty.description') ||
            'No audit events match the current filters.'
          }
        />
      )}

      {rows.length > 0 && (
        <Box
          role="region"
          aria-label={t('admin:audit.title') || 'Audit browser'}
          style={{
            borderRadius: 'var(--emr-border-radius-lg)',
            border: '1px solid var(--emr-gray-200)',
            overflow: 'hidden',
            background: 'var(--emr-bg-card)',
            boxShadow: 'var(--emr-shadow-sm)',
          }}
        >
          <ScrollArea.Autosize mah="calc(100vh - 360px)">
            <Table striped highlightOnHover verticalSpacing="sm" horizontalSpacing="md" stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={{ width: 64 }}>{t('admin:audit.col.seq') || '#'}</Table.Th>
                  <Table.Th>{t('admin:audit.col.recorded') || 'Recorded'}</Table.Th>
                  <Table.Th>{t('admin:audit.col.category') || 'Category'}</Table.Th>
                  <Table.Th>{t('admin:audit.col.actor') || 'Actor'}</Table.Th>
                  <Table.Th>{t('admin:audit.col.outcome') || 'Outcome'}</Table.Th>
                  <Table.Th>{t('admin:audit.col.summary') || 'Summary'}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((ev) => (
                  <Table.Tr
                    key={ev.id}
                    onClick={() => setSelected(ev)}
                    style={{ cursor: 'pointer' }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${t('admin:audit.drawer.open') || 'View detail'} #${ev.sequence_no}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(ev);
                      }
                    }}
                  >
                    <Table.Td>
                      <Code style={{ fontSize: 'var(--emr-font-xs)' }}>{ev.sequence_no}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)" style={{ whiteSpace: 'nowrap' }}>
                        {new Date(ev.recorded).toLocaleString(locale)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        variant="light"
                        color="blue"
                        size="sm"
                        style={{ textTransform: 'none', fontWeight: 600 }}
                      >
                        {ev.category}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text fz="var(--emr-font-xs)" style={{ fontFamily: 'var(--emr-font-mono)' }}>
                        {ev.actor ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <OutcomeBadge outcome={ev.outcome} />
                    </Table.Td>
                    <Table.Td>
                      <Text
                        fz="var(--emr-font-sm)"
                        c="var(--emr-text-secondary)"
                        lineClamp={2}
                        style={{ maxWidth: 360 }}
                      >
                        {ev.summary ?? '—'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Box>
      )}

      <Drawer
        opened={selected !== null}
        onClose={() => setSelected(null)}
        position="right"
        size="md"
        title={
          <Stack gap={2}>
            <Text fz="var(--emr-font-md)" fw={600}>
              {t('admin:audit.drawer.title') || 'Audit event detail'}
            </Text>
            {selected && (
              <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
                {t('admin:audit.drawer.subtitle', { seq: selected.sequence_no }) || `Sequence #${selected.sequence_no}`}
              </Text>
            )}
          </Stack>
        }
      >
        {selected && (
          <Stack gap="md">
            <SimpleField label={t('admin:audit.col.recorded') || 'Recorded'}>
              {new Date(selected.recorded).toLocaleString(locale)}
            </SimpleField>
            <SimpleField label={t('admin:audit.col.category') || 'Category'}>
              <Badge variant="light" color="blue" style={{ textTransform: 'none' }}>
                {selected.category}
              </Badge>
            </SimpleField>
            <SimpleField label={t('admin:audit.col.actor') || 'Actor'}>
              <Code>{selected.actor ?? '—'}</Code>
            </SimpleField>
            <SimpleField label={t('admin:audit.col.outcome') || 'Outcome'}>
              <OutcomeBadge outcome={selected.outcome} />
            </SimpleField>
            <SimpleField label={t('admin:audit.col.summary') || 'Summary'}>
              <Text fz="var(--emr-font-sm)">{selected.summary ?? '—'}</Text>
            </SimpleField>
            <Box>
              <Group justify="space-between" mb={6}>
                <Text fz="var(--emr-font-xs)" fw={600} c="var(--emr-text-secondary)">
                  {t('admin:audit.drawer.json') || 'Raw event JSON'}
                </Text>
                <EMRButton size="sm" variant="ghost" icon={copied ? IconExternalLink : IconCopy} onClick={handleCopy}>
                  {copied
                    ? t('admin:audit.drawer.copied') || 'Copied'
                    : t('admin:audit.drawer.copyJson') || 'Copy JSON'}
                </EMRButton>
              </Group>
              <Box
                component="pre"
                style={{
                  margin: 0,
                  padding: 12,
                  borderRadius: 'var(--emr-border-radius-md)',
                  background: 'var(--emr-gray-50)',
                  border: '1px solid var(--emr-gray-200)',
                  fontSize: 'var(--emr-font-xs)',
                  fontFamily: 'var(--emr-font-mono)',
                  overflow: 'auto',
                  maxHeight: 360,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--emr-text-primary)',
                }}
              >
                {JSON.stringify(selected, null, 2)}
              </Box>
            </Box>
          </Stack>
        )}
      </Drawer>
    </Stack>
  );
}

function SimpleField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Stack gap={4}>
      <Text fz="var(--emr-font-xs)" fw={600} c="var(--emr-text-secondary)" tt="uppercase">
        {label}
      </Text>
      <Box>{children}</Box>
    </Stack>
  );
}

export default function AuditBrowserView(): React.ReactElement {
  return (
    <EMRErrorBoundary>
      <Suspense fallback={<Skeleton rows={10} columns={6} />}>
        <AuditBrowserInner />
      </Suspense>
    </EMRErrorBoundary>
  );
}
