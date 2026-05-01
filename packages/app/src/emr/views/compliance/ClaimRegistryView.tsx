// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ClaimRegistryView (T349, T449, T451).
 *
 * Plain-English: the compliance reviewer sees exactly 7 rows — one per
 * AI claim (parenchyma volumetry, FLR, Couinaud segmentation, vessel
 * identification, lesion detection, lesion classification, surgical
 * planning). Each row has:
 *
 *   - current status (`ruo` / `under_conformity_assessment` / `cleared`),
 *   - effective-from timestamp,
 *   - regulatory reference (e.g. CE cert number),
 *   - a status select + a save button.
 *
 * The save button is a `<PermissionButton stepUp>` with permission
 * `compliance.toggle_claim_registry` — the server requires a fresh MFA
 * challenge (≤5 min) for that permission, so the errorClient bounces
 * the user through `StepUpAuthModal` before the PUT actually lands.
 *
 * Flipping a row from `ruo` → `cleared` narrows the disclaimer scope
 * for that claim on every future export (FR-028b). The hook cross-
 * invalidates the global `RUOClaimRegistryContext` so the banner UI
 * updates immediately for all open tabs.
 *
 * Spec refs: FR-028b, data-model.md §17, SC-009.
 */

import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { IconAlertCircle, IconCertificate, IconClipboardCheck } from '@tabler/icons-react';

import {
  EMRCard,
  EMREmptyState as EMREmpty,
  EMRErrorBoundary,
  EMRPageHeader,
} from '../../components/common';
import { EMRSelect, EMRTextInput } from '../../components/shared/EMRFormFields';
import { PermissionButton } from '../../components/access-control';
import { useTranslation } from '../../contexts/TranslationContext';
import {
  useClaimRegistry,
  type ClaimKey,
  type ClaimRegistryEntry,
  type ClaimStatus,
} from '../../hooks/useClaimRegistry';

const STATUS_COLORS: Record<ClaimStatus, string> = {
  ruo: 'yellow',
  under_conformity_assessment: 'blue',
  cleared: 'green',
};

function ClaimRow({
  row,
  onSave,
  isSaving,
}: {
  row: ClaimRegistryEntry;
  onSave: (next: { status: ClaimStatus; regulatory_reference: string | null }) => void;
  isSaving: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ClaimStatus>(row.status);
  const [ref, setRef] = useState<string>(row.regulatory_reference ?? '');

  // Keep local draft in sync when the server-side row changes.
  useEffect(() => {
    setStatus(row.status);
    setRef(row.regulatory_reference ?? '');
  }, [row.status, row.regulatory_reference]);

  const dirty = status !== row.status || (ref || '') !== (row.regulatory_reference ?? '');

  return (
    <Table.Tr data-testid="claim-registry-row" data-claim-key={row.claim_key}>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <IconCertificate size={14} aria-hidden="true" />
          <Text fw={600} size="sm">
            {t(`compliance:claim.key.${row.claim_key}`)}
          </Text>
        </Group>
      </Table.Td>
      <Table.Td>
        <Badge color={STATUS_COLORS[row.status]} variant="light" size="sm">
          {t(`compliance:claim.status.${row.status}`)}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{new Date(row.effective_from).toISOString()}</Text>
      </Table.Td>
      <Table.Td style={{ minWidth: 180 }}>
        <EMRSelect
          data-testid="claim-registry-status-select"
          value={status}
          onChange={(v) => {
            if (v === 'ruo' || v === 'under_conformity_assessment' || v === 'cleared') {
              setStatus(v);
            }
          }}
          data={[
            { value: 'ruo', label: t('compliance:claim.status.ruo') },
            {
              value: 'under_conformity_assessment',
              label: t('compliance:claim.status.under_conformity_assessment'),
            },
            { value: 'cleared', label: t('compliance:claim.status.cleared') },
          ]}
          aria-label={t('compliance:claim.statusAriaLabel')}
        />
      </Table.Td>
      <Table.Td style={{ minWidth: 200 }}>
        <EMRTextInput
          data-testid="claim-registry-reference"
          value={ref}
          onChange={(v) => setRef(v)}
          placeholder={t('compliance:claim.referencePlaceholder')}
          aria-label={t('compliance:claim.referenceAriaLabel')}
        />
      </Table.Td>
      <Table.Td>
        <PermissionButton
          permission="compliance.toggle_claim_registry"
          size="compact-sm"
          onClick={() =>
            onSave({ status, regulatory_reference: ref.trim() ? ref.trim() : null })
          }
          disabled={!dirty}
          loading={isSaving && dirty}
          data-testid="claim-registry-save"
          deniedTooltip={t('compliance:claim.deniedTooltip')}
        >
          {t('compliance:claim.saveButton')}
        </PermissionButton>
      </Table.Td>
    </Table.Tr>
  );
}

function ClaimRegistryInner(): ReactElement {
  const { t } = useTranslation();
  const { rows, isLoading, isError, error, update, isUpdating } = useClaimRegistry();
  const [activeKey, setActiveKey] = useState<ClaimKey | null>(null);

  // Sort the 7 rows in the canonical order so the UI is stable across
  // reloads even if the backend returns them in a different order.
  const ordered = useMemo<readonly ClaimRegistryEntry[]>(() => {
    const order: readonly ClaimKey[] = [
      'parenchyma_volumetry',
      'flr',
      'couinaud_segmentation',
      'vessel_identification',
      'lesion_detection',
      'lesion_classification',
      'surgical_planning',
    ];
    const by = new Map(rows.map((r) => [r.claim_key, r]));
    return order.map((k) => by.get(k)).filter(Boolean) as ClaimRegistryEntry[];
  }, [rows]);

  const handleSave = async (
    key: ClaimKey,
    input: { status: ClaimStatus; regulatory_reference: string | null },
  ): Promise<void> => {
    setActiveKey(key);
    try {
      await update({
        claim_key: key,
        status: input.status,
        regulatory_reference: input.regulatory_reference,
      });
    } finally {
      setActiveKey(null);
    }
  };

  return (
    <Stack gap="md" p="md" data-testid="claim-registry-view">
      <EMRPageHeader
        icon={IconClipboardCheck}
        title={t('compliance:claim.title')}
        subtitle={t('compliance:claim.subtitle')}
      />

      {isError && (
        <Alert
          color="red"
          icon={<IconAlertCircle size={16} />}
          title={t('compliance:claim.loadError')}
        >
          {error?.message ?? t('common:genericError')}
        </Alert>
      )}

      <EMRCard>
        <Box style={{ overflowX: 'auto' }}>
          {isLoading ? (
            <Stack gap="xs" data-testid="claim-registry-loading">
              {Array.from({ length: 7 }).map((_, i) => (
                <Skeleton key={i} height={40} radius="sm" />
              ))}
            </Stack>
          ) : ordered.length === 0 ? (
            <EMREmpty
              title={t('compliance:claim.emptyTitle')}
              description={t('compliance:claim.emptyDescription')}
            />
          ) : (
            <Table
              striped
              highlightOnHover
              verticalSpacing="sm"
              horizontalSpacing="md"
              aria-label={t('compliance:claim.tableAriaLabel')}
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('compliance:claim.colClaim')}</Table.Th>
                  <Table.Th>{t('compliance:claim.colCurrentStatus')}</Table.Th>
                  <Table.Th>{t('compliance:claim.colEffectiveFrom')}</Table.Th>
                  <Table.Th>{t('compliance:claim.colStatus')}</Table.Th>
                  <Table.Th>{t('compliance:claim.colReference')}</Table.Th>
                  <Table.Th>{t('compliance:claim.colAction')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {ordered.map((row) => (
                  <ClaimRow
                    key={row.claim_key}
                    row={row}
                    onSave={(input) => void handleSave(row.claim_key, input)}
                    isSaving={isUpdating && activeKey === row.claim_key}
                  />
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Box>
      </EMRCard>
    </Stack>
  );
}

export default function ClaimRegistryView(): ReactElement {
  return (
    <EMRErrorBoundary componentName="ClaimRegistryView">
      <ClaimRegistryInner />
    </EMRErrorBoundary>
  );
}
