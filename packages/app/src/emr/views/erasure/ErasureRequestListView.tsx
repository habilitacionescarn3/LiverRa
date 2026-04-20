// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ErasureRequestListView (T329, US9).
 *
 * Plain-English:
 *   The DPO's "inbox". Lists every erasure request (past + in-flight)
 *   so the officer can track progress and download confirmation PDFs
 *   for completed ones. A big "New erasure request" button links to
 *   the wizard.
 *
 *   DPO-only: the route is already guarded in `AppRoutes.tsx` with
 *   `requires={['erasure.execute']}`; nothing on this page assumes
 *   any other role.
 */

import {
  Alert,
  Badge,
  Code,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconFileShredder, IconPlus } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import {
  EMRButton,
  EMREmptyState as EMREmpty,
} from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';

interface ErasureRequestRow {
  id: string;
  target_study_id: string;
  status: 'requested' | 'executing' | 'completed' | 'rolled_back';
  requested_at: string;
  completed_at: string | null;
  tombstone_hash_hex: string | null;
  confirmation_pdf_url: string | null;
  dpo_email: string | null;
  justification: string;
}

function readApiBaseUrl(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

async function fetchErasureRequests(): Promise<ErasureRequestRow[]> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/erasure/requests`, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Failed to load erasure requests: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (Array.isArray(body)) return body as ErasureRequestRow[];
  if (body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)) {
    return (body as { items: ErasureRequestRow[] }).items;
  }
  return [];
}

function StatusBadge({ status }: { status: ErasureRequestRow['status'] }): JSX.Element {
  const { t } = useTranslation();
  const color =
    status === 'completed'
      ? 'teal'
      : status === 'executing'
        ? 'blue'
        : status === 'rolled_back'
          ? 'red'
          : 'yellow';
  return (
    <Badge color={color} variant="light" size="sm">
      {t(`erasure:status.${status}`)}
    </Badge>
  );
}

export default function ErasureRequestListView(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const query = useQuery<ErasureRequestRow[], Error>({
    queryKey: ['erasure', 'requests'],
    queryFn: fetchErasureRequests,
    staleTime: 10_000,
  });

  return (
    <Stack gap="md" p="md" data-testid="erasure-request-list">
      <Group justify="space-between" wrap="wrap">
        <Group gap={8}>
          <IconFileShredder size={28} />
          <Title order={2}>{t('erasure:list.title')}</Title>
        </Group>
        <EMRButton
          onClick={() => navigate('/erasure/new')}
          leftSection={<IconPlus size={16} />}
          variant="danger"
          data-testid="erasure-new-btn"
        >
          {t('erasure:list.new_request')}
        </EMRButton>
      </Group>
      <Text c="dimmed" fz="sm">
        {t('erasure:list.subtitle')}
      </Text>

      {query.isError ? (
        <Alert color="red" title={t('erasure:list.error_title')}>
          {query.error?.message}
        </Alert>
      ) : null}

      {query.isLoading ? (
        <Stack gap="xs" data-testid="erasure-list-loading" aria-label={t('common:loading')}>
          <Skeleton height={32} radius="sm" />
          <Skeleton height={32} radius="sm" />
          <Skeleton height={32} radius="sm" />
          <Skeleton height={32} radius="sm" />
        </Stack>
      ) : (query.data ?? []).length === 0 ? (
        <EMREmpty
          title={t('erasure:list.empty')}
          description={t('erasure:list.subtitle')}
          data-testid="erasure-list-empty"
        />
      ) : (
        <Table striped withRowBorders data-testid="erasure-list-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('erasure:list.col.request_id')}</Table.Th>
              <Table.Th>{t('erasure:list.col.study_id')}</Table.Th>
              <Table.Th>{t('erasure:list.col.status')}</Table.Th>
              <Table.Th>{t('erasure:list.col.requested_at')}</Table.Th>
              <Table.Th>{t('erasure:list.col.tombstone')}</Table.Th>
              <Table.Th>{t('erasure:list.col.pdf')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(query.data ?? []).map((row) => (
              <Table.Tr key={row.id} data-testid={`erasure-row-${row.id}`}>
                <Table.Td>
                  <Code fz="xs">{row.id.slice(0, 8)}…</Code>
                </Table.Td>
                <Table.Td>
                  <Code fz="xs">{row.target_study_id.slice(0, 8)}…</Code>
                </Table.Td>
                <Table.Td>
                  <StatusBadge status={row.status} />
                </Table.Td>
                <Table.Td>
                  <Text fz="xs">{new Date(row.requested_at).toLocaleString()}</Text>
                </Table.Td>
                <Table.Td>
                  {row.tombstone_hash_hex ? (
                    <Code fz="xs" title={row.tombstone_hash_hex}>
                      {row.tombstone_hash_hex.slice(0, 12)}…
                    </Code>
                  ) : (
                    '—'
                  )}
                </Table.Td>
                <Table.Td>
                  {row.confirmation_pdf_url ? (
                    <EMRButton
                      onClick={() => {
                        window.open(
                          row.confirmation_pdf_url ?? '',
                          '_blank',
                          'noopener,noreferrer',
                        );
                      }}
                      size="sm"
                      variant="light"
                      data-testid={`erasure-pdf-${row.id}`}
                    >
                      {t('erasure:list.download_pdf')}
                    </EMRButton>
                  ) : (
                    '—'
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
