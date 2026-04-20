// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * DeleteRequestApprovalPanel (T290).
 *
 * Plain-English: shows a single user-submitted case-deletion request and
 * lets the admin approve (soft-delete) or reject it. Hard-delete stays
 * reserved to the DPO erasure workflow (FR-046).
 */
import { useState } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconTrash, IconX } from '@tabler/icons-react';
import { EMRButton } from '../common/EMRButton';
import { EMRAlert } from '../common/EMRAlert';
import { useTranslation } from '../../contexts/TranslationContext';

export interface DeleteRequest {
  studyId: string;
  requestedBy: string;
  requestedAt: string;
  reason?: string;
}

export interface DeleteRequestApprovalPanelProps {
  request: DeleteRequest;
  onApprove: (studyId: string) => Promise<void>;
  onReject: (studyId: string) => Promise<void>;
}

export function DeleteRequestApprovalPanel({
  request,
  onApprove,
  onReject,
}: DeleteRequestApprovalPanelProps): React.ReactElement {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const runApprove = async (): Promise<void> => {
    setSubmitting('approve');
    setError(null);
    try {
      await onApprove(request.studyId);
    } catch (e) {
      setError(e as Error);
    } finally {
      setSubmitting(null);
    }
  };

  const runReject = async (): Promise<void> => {
    setSubmitting('reject');
    setError(null);
    try {
      await onReject(request.studyId);
    } catch (e) {
      setError(e as Error);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Box
      style={{
        padding: 16,
        borderRadius: 'var(--emr-border-radius-lg)',
        background: 'var(--emr-bg-card)',
        border: '1px solid var(--emr-warning)',
      }}
    >
      <Stack gap="md">
        <Group gap="sm" wrap="wrap">
          <IconAlertTriangle size={20} color="var(--emr-warning)" />
          <Text fw={600} fz="var(--emr-font-md)" c="var(--emr-text-primary)">
            {t('admin:deleteRequest.title') || 'Case deletion request'}
          </Text>
        </Group>
        <Stack gap={4}>
          <Text fz="var(--emr-font-sm)">
            <strong>{t('admin:deleteRequest.studyId') || 'Study ID'}:</strong> {request.studyId}
          </Text>
          <Text fz="var(--emr-font-sm)">
            <strong>{t('admin:deleteRequest.requestedBy') || 'Requested by'}:</strong>{' '}
            {request.requestedBy}
          </Text>
          <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
            {request.requestedAt}
          </Text>
          {request.reason && (
            <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)" style={{ marginTop: 8 }}>
              {request.reason}
            </Text>
          )}
        </Stack>
        {error && (
          <EMRAlert variant="error" title={t('common:error') || 'Error'}>
            {error.message}
          </EMRAlert>
        )}
        <Group gap="sm" wrap="wrap" justify="flex-end">
          <EMRButton
            variant="ghost"
            icon={IconX}
            onClick={runReject}
            disabled={submitting !== null}
            loading={submitting === 'reject'}
          >
            {t('admin:deleteRequest.reject') || 'Reject'}
          </EMRButton>
          <EMRButton
            variant="danger"
            icon={IconTrash}
            onClick={runApprove}
            disabled={submitting !== null}
            loading={submitting === 'approve'}
          >
            {t('admin:deleteRequest.approve') || 'Approve (soft delete)'}
          </EMRButton>
        </Group>
      </Stack>
    </Box>
  );
}

export default DeleteRequestApprovalPanel;
