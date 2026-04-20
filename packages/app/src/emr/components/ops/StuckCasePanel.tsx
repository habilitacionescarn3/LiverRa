// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * StuckCasePanel (T317, US8).
 *
 * Plain-English:
 *   Detail pane for a single stuck case. Shows the PHI-free fields the
 *   ops engineer needs to debug (analysis id, pipeline version, model
 *   versions, last stage, error slug, stuck minutes) and exposes three
 *   actions:
 *     1. Retry    — re-queue from last checkpoint.
 *     2. Cancel   — graceful stop (Celery revoke).
 *     3. Mark-blocked — terminal "can't recover"; notifies submitter.
 *
 * NO PHI. All identifiers rendered here are UUIDs or machine-generated
 * slugs. The server guarantees no PHI leaks via the fail-closed scrubber
 * on /api/v1/ops/*; this component does not attempt to render patient
 * names or accession numbers even if the backend accidentally sent them.
 */

import {
  Alert,
  Badge,
  Code,
  Divider,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBan,
  IconRefresh,
  IconXboxX,
} from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslation } from '../../contexts/TranslationContext';
import { useOpsAnalysis } from '../../hooks/useOpsAnalysis';
import { EMRButton } from '../common/EMRButton';
import { EMRConfirmationModal } from '../common/EMRConfirmationModal';
import { EMRTextarea } from '../shared/EMRFormFields/EMRTextarea';

export interface StuckCasePanelProps {
  analysisId: string;
  onClose?: () => void;
}

/** Whitelist of keys we will render — any PHI-looking key is skipped. */
const SAFE_RENDER_KEYS = new Set<string>([
  'analysis_id',
  'study_id',
  'tenant_id',
  'status',
  'queued_at',
  'started_at',
  'pipeline_version',
  'model_versions',
  'error_slug',
  'last_stage',
  'last_stage_at',
  'stuck_minutes',
]);

/** Filter a backend payload to our PHI-free allowlist. Defence in depth. */
function filterForDisplay(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (SAFE_RENDER_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export function StuckCasePanel({
  analysisId,
  onClose,
}: StuckCasePanelProps): JSX.Element {
  const { t } = useTranslation();
  const { analysis, isLoading, isError, error, retry, cancel, markBlocked, isMutating } =
    useOpsAnalysis(analysisId);
  const [confirmAction, setConfirmAction] =
    useState<'retry' | 'cancel' | 'mark-blocked' | null>(null);
  const [note, setNote] = useState('');

  if (isLoading) {
    return (
      <Stack gap="sm" p="md" data-testid="stuck-case-panel-loading">
        <Text>{t('common:loading')}</Text>
      </Stack>
    );
  }

  if (isError || !analysis) {
    return (
      <Alert
        icon={<IconAlertTriangle size={18} />}
        color="red"
        title={t('ops:detail.load_failed_title')}
        data-testid="stuck-case-panel-error"
      >
        {error?.message ?? t('ops:detail.load_failed_body')}
      </Alert>
    );
  }

  const safe = filterForDisplay(analysis);
  const stuckMinutes = typeof safe.stuck_minutes === 'number' ? safe.stuck_minutes : null;

  const handleConfirm = async () => {
    try {
      if (confirmAction === 'retry') await retry();
      if (confirmAction === 'cancel') await cancel();
      if (confirmAction === 'mark-blocked') await markBlocked(note || undefined);
    } finally {
      setConfirmAction(null);
      setNote('');
    }
  };

  return (
    <Stack gap="sm" p="md" data-testid="stuck-case-panel">
      <Group justify="space-between" wrap="wrap">
        <Title order={4}>{t('ops:detail.title')}</Title>
        <Badge color="orange" variant="light">
          {String(safe.status ?? 'unknown')}
        </Badge>
      </Group>

      <Divider />

      {/* PHI-free identifiers block. Rendered as <code> so the ops engineer
         can copy-paste into the audit log without ambiguity. */}
      <Stack gap={4}>
        <Group gap={8} wrap="wrap">
          <Text fz="xs" c="dimmed">
            {t('ops:detail.analysis_id')}
          </Text>
          <Code>{String(safe.analysis_id)}</Code>
        </Group>
        <Group gap={8} wrap="wrap">
          <Text fz="xs" c="dimmed">
            {t('ops:detail.study_id')}
          </Text>
          <Code>{String(safe.study_id)}</Code>
        </Group>
        <Group gap={8} wrap="wrap">
          <Text fz="xs" c="dimmed">
            {t('ops:detail.tenant_id')}
          </Text>
          <Code>{String(safe.tenant_id)}</Code>
        </Group>
        <Group gap={8} wrap="wrap">
          <Text fz="xs" c="dimmed">
            {t('ops:detail.pipeline_version')}
          </Text>
          <Code>{String(safe.pipeline_version)}</Code>
        </Group>
        <Group gap={8} wrap="wrap">
          <Text fz="xs" c="dimmed">
            {t('ops:detail.last_stage')}
          </Text>
          <Code>{String(safe.last_stage ?? '—')}</Code>
          {stuckMinutes !== null && (
            <Badge
              size="xs"
              variant="light"
              color={stuckMinutes > 15 ? 'red' : 'yellow'}
              data-testid="stuck-case-panel-stuck-minutes"
            >
              {t('ops:detail.stuck_minutes', { minutes: stuckMinutes.toFixed(1) })}
            </Badge>
          )}
        </Group>
        {safe.error_slug ? (
          <Group gap={8} wrap="wrap">
            <Text fz="xs" c="dimmed">
              {t('ops:detail.error_slug')}
            </Text>
            <Code>{String(safe.error_slug)}</Code>
          </Group>
        ) : null}
      </Stack>

      <Divider label={t('ops:detail.model_versions')} labelPosition="left" />
      <Code block fz="xs">
        {JSON.stringify(safe.model_versions ?? {}, null, 2)}
      </Code>

      <Divider />

      <Group gap="xs" wrap="wrap">
        <EMRButton
          leftSection={<IconRefresh size={16} />}
          variant="secondary"
          loading={isMutating && confirmAction === 'retry'}
          disabled={isMutating}
          onClick={() => setConfirmAction('retry')}
          data-testid="stuck-case-retry-btn"
        >
          {t('ops:actions.retry')}
        </EMRButton>
        <EMRButton
          leftSection={<IconXboxX size={16} />}
          variant="ghost"
          loading={isMutating && confirmAction === 'cancel'}
          disabled={isMutating}
          onClick={() => setConfirmAction('cancel')}
          data-testid="stuck-case-cancel-btn"
        >
          {t('ops:actions.cancel')}
        </EMRButton>
        <EMRButton
          leftSection={<IconBan size={16} />}
          variant="danger"
          loading={isMutating && confirmAction === 'mark-blocked'}
          disabled={isMutating}
          onClick={() => setConfirmAction('mark-blocked')}
          data-testid="stuck-case-mark-blocked-btn"
        >
          {t('ops:actions.mark_blocked')}
        </EMRButton>
        {onClose ? (
          <EMRButton variant="ghost" onClick={onClose}>
            {t('common:close')}
          </EMRButton>
        ) : null}
      </Group>

      <EMRConfirmationModal
        opened={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleConfirm}
        title={
          confirmAction === 'retry'
            ? t('ops:confirm.retry_title')
            : confirmAction === 'cancel'
              ? t('ops:confirm.cancel_title')
              : t('ops:confirm.mark_blocked_title')
        }
        confirmLabel={t('common:confirm')}
        cancelLabel={t('common:cancel')}
      >
        <Stack gap="sm">
          <Text>
            {confirmAction === 'retry'
              ? t('ops:confirm.retry_body')
              : confirmAction === 'cancel'
                ? t('ops:confirm.cancel_body')
                : t('ops:confirm.mark_blocked_body')}
          </Text>
          {confirmAction === 'mark-blocked' ? (
            <EMRTextarea
              label={t('ops:confirm.mark_blocked_note_label')}
              description={t('ops:confirm.mark_blocked_note_help')}
              placeholder={t('ops:confirm.mark_blocked_note_placeholder')}
              minRows={3}
              value={note}
              onChange={(val) => setNote(val)}
              data-testid="stuck-case-mark-blocked-note"
            />
          ) : null}
        </Stack>
      </EMRConfirmationModal>
    </Stack>
  );
}

export default StuckCasePanel;
