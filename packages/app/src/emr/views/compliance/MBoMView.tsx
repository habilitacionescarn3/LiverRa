// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * MBoMView (T345, T449).
 *
 * Plain-English: a read-only table listing every ML model the current
 * build is shipping — each one's pinned commit SHA, license hash,
 * source URL, and the human who approved it. This is the "show me the
 * model bill of materials" page the compliance reviewer opens when a
 * regulator asks "what exactly is in this build?".
 *
 * Data comes from `useMBoM()` (T350) which hits
 * `GET /api/v1/compliance/mbom` and merges the live `MBoM.json` with
 * historical approval rows.
 *
 * Spec refs: FR-038, data-model.md §16.
 */

import type { ReactElement } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Code,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconExternalLink,
  IconPackage,
} from '@tabler/icons-react';

import {
  EMRCard,
  EMREmptyState as EMREmpty,
  EMRPageHeader,
  EMRTableSkeleton,
} from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';
import { useMBoM, type MBoMRow } from '../../hooks/useMBoM';

function ShortHash({ hash }: { hash: string }): ReactElement {
  if (!hash) return <Text c="var(--emr-text-tertiary)">—</Text>;
  const short = hash.length > 16 ? `${hash.slice(0, 12)}…` : hash;
  return (
    <Code title={hash} style={{ fontSize: 'var(--emr-font-xs)' }}>
      {short}
    </Code>
  );
}

function MBoMRowView({ row }: { row: MBoMRow }): ReactElement {
  const { t } = useTranslation();
  return (
    <Table.Tr data-testid="mbom-row">
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <IconPackage size={14} aria-hidden="true" />
          <Text fw={600} size="sm">
            {row.model_name}
          </Text>
        </Group>
      </Table.Td>
      <Table.Td>
        <ShortHash hash={row.pinned_commit_sha} />
      </Table.Td>
      <Table.Td>
        <ShortHash hash={row.license_text_hash_hex} />
      </Table.Td>
      <Table.Td>
        <Badge variant="light" color="green" size="sm">
          {row.license_name || 'Apache-2.0'}
        </Badge>
      </Table.Td>
      <Table.Td>
        {row.source_url ? (
          <Anchor
            href={row.source_url}
            target="_blank"
            rel="noreferrer"
            size="sm"
            style={{ wordBreak: 'break-all' }}
          >
            <Group gap={4} wrap="nowrap">
              <IconExternalLink size={12} aria-hidden="true" />
              <span>{row.source_url.replace(/^https?:\/\//, '')}</span>
            </Group>
          </Anchor>
        ) : (
          <Text c="var(--emr-text-tertiary)" size="sm">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm">{row.integration_date ?? '—'}</Text>
      </Table.Td>
      <Table.Td>
        {row.approver ? (
          <Text size="sm">{row.approver}</Text>
        ) : (
          <Badge color="yellow" variant="light" size="sm">
            {t('compliance:mbom.pendingApproval')}
          </Badge>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

export default function MBoMView(): ReactElement {
  const { t } = useTranslation();
  const { rows, isLoading, isError, error } = useMBoM();

  return (
    <Stack gap="md" p="md" data-testid="mbom-view">
      <EMRPageHeader
        title={t('compliance:mbom.title')}
        subtitle={t('compliance:mbom.subtitle')}
      />

      {isError && (
        <Alert
          color="red"
          icon={<IconAlertCircle size={16} />}
          title={t('compliance:mbom.loadError')}
        >
          {error?.message ?? t('common:genericError')}
        </Alert>
      )}

      <EMRCard>
        <Box style={{ overflowX: 'auto' }}>
          {isLoading ? (
            <Stack gap="xs" aria-busy="true">
              <Skeleton height={32} radius="sm" visible />
              <EMRTableSkeleton columns={7} rows={5} />
            </Stack>
          ) : rows.length === 0 ? (
            <EMREmpty
              title={t('compliance:mbom.emptyTitle')}
              description={t('compliance:mbom.emptyDescription')}
            />
          ) : (
            <Table
              striped
              highlightOnHover
              verticalSpacing="sm"
              horizontalSpacing="md"
              aria-label={t('compliance:mbom.tableAriaLabel')}
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('compliance:mbom.colModel')}</Table.Th>
                  <Table.Th>{t('compliance:mbom.colCommit')}</Table.Th>
                  <Table.Th>{t('compliance:mbom.colLicenseHash')}</Table.Th>
                  <Table.Th>{t('compliance:mbom.colLicense')}</Table.Th>
                  <Table.Th>{t('compliance:mbom.colSource')}</Table.Th>
                  <Table.Th>{t('compliance:mbom.colIntegrated')}</Table.Th>
                  <Table.Th>{t('compliance:mbom.colApprover')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <MBoMRowView key={row.model_name} row={row} />
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Box>
      </EMRCard>
    </Stack>
  );
}
