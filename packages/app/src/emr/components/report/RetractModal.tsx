// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RetractModal (T271, T451).
 *
 * Plain-English: the confirmation modal that triggers
 * `POST /reports/{id}/retract`. Step-up MFA is enforced by the server,
 * but we gate the submit button with `<PermissionButton permission=
 * "report.retract">` so the UI mirrors the permission matrix and
 * surfaces a friendly "you don't have access" tooltip when denied.
 *
 * Retraction is audit-preserving (FR-027a) — the Report row remains;
 * only `retracted_at` + `retraction_reason` are stamped. Surgeons are
 * warned in the modal body that nothing is deleted.
 */
import { useState } from 'react';
import { Alert, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { EMRButton } from '../common/EMRButton';
import { EMRModal } from '../common/EMRModal';
import { EMRTextarea } from '../shared/EMRFormFields';
import { PermissionButton } from '../access-control/PermissionButton';
import { useTranslation } from '../../contexts/TranslationContext';

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

async function postRetract(reportId: string, reason: string): Promise<void> {
  const base = readApiBaseUrl();
  const res = await fetch(`${base}/reports/${encodeURIComponent(reportId)}/retract`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(String(body.detail ?? `retract failed (HTTP ${res.status})`));
  }
}

export interface RetractModalProps {
  opened: boolean;
  onClose: () => void;
  reportId: string;
  onRetracted?: () => void;
}

export function RetractModal({
  opened,
  onClose,
  reportId,
  onRetracted,
}: RetractModalProps): JSX.Element {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: (r: string) => postRetract(reportId, r),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reports', reportId] });
      setReason('');
      onRetracted?.();
      onClose();
    },
    onError: (err) => setError((err as Error).message),
  });

  const canSubmit = reason.trim().length > 0 && !mutation.isPending;

  return (
    <EMRModal
      opened={opened}
      onClose={() => {
        setError(null);
        setReason('');
        onClose();
      }}
      title={t('report:retract.title') ?? 'Retract Report'}
      size="sm"
      data-testid="retract-modal"
    >
      <Stack gap="md">
        <Alert icon={<IconAlertTriangle size={18} />} color="red" variant="light">
          {t('report:retract.body') ??
            'Retraction is audit-preserving: the report row is kept and flagged. Downstream viewers will see a "Retracted" banner.'}
        </Alert>

        <EMRTextarea
          label={t('report:retract.reasonLabel') ?? 'Reason for retraction'}
          placeholder={
            t('report:retract.reasonPlaceholder') ??
            'Explain why this report is being retracted…'
          }
          value={reason}
          onChange={(value) => setReason(value)}
          autosize
          minRows={2}
          maxRows={5}
          required
          data-testid="retract-modal-reason"
        />

        {error ? (
          <Text size="sm" c="red">
            {error}
          </Text>
        ) : null}

        <Group justify="flex-end" gap="xs">
          <EMRButton variant="default" onClick={onClose}>
            {t('common:cancel') ?? 'Cancel'}
          </EMRButton>
          <PermissionButton
            permission="report.retract"
            color="red"
            disabled={!canSubmit}
            onClick={() => {
              setError(null);
              mutation.mutate(reason.trim());
            }}
            data-testid="retract-modal-submit"
          >
            {mutation.isPending
              ? t('common:submitting') ?? 'Submitting…'
              : t('report:retract.confirm') ?? 'Retract'}
          </PermissionButton>
        </Group>
      </Stack>
    </EMRModal>
  );
}

export default RetractModal;
