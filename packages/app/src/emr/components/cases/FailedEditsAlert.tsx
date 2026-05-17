// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FailedEditsAlert — surfaces offline-queue edits the sync worker has
 * given up on (Phase H4).
 *
 * Plain-English analogy: imagine your outbox folder had a "letters
 * marked return-to-sender" sub-folder you never opened. This alert is
 * the notification badge — it tells you the letter never made it, and
 * gives you one button to throw it away and one to ask the postman to
 * try again.
 *
 * Concretely: when the sync worker hits 404 on an edit (e.g. the
 * analysis was deleted out from under us, or the row was tenant-purged),
 * it now calls `offlineQueue.markFailed(...)` which bumps the edit's
 * `attempt_count` to `MAX_ATTEMPTS` and stores the reason. Without this
 * UI, the edit sits in IndexedDB invisible to the user.
 *
 * Refresh strategy: the component re-reads `offlineQueue.listFailed()`
 * on every sync-worker tick (the worker dispatches
 * `SYNC_WORKER_EVENT` every ~15s and on every flush). No polling.
 *
 * Mounted in RefinementView just below `RecordLockBanner`.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh, IconTrash } from '@tabler/icons-react';

import { offlineQueue, type OfflineEdit } from '../../services/offline/offlineQueue';
import { SYNC_WORKER_EVENT } from '../../contexts/SyncContext';
import { EMRAlert } from '../common/EMRAlert';
import { EMRButton } from '../common/EMRButton';
import { useTranslation } from '../../contexts/TranslationContext';

export interface FailedEditsAlertProps {
  /** Optional — when set, only show failed edits for this analysis. */
  analysisId?: string;
  'data-testid'?: string;
}

export function FailedEditsAlert({
  analysisId,
  'data-testid': testId = 'failed-edits-alert',
}: FailedEditsAlertProps): ReactElement | null {
  const { t } = useTranslation();
  const [failed, setFailed] = useState<OfflineEdit[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    // Best-effort — when IndexedDB is unavailable (SSR, jsdom test env, or
    // privacy-mode Safari blocking storage), we simply render nothing
    // rather than crashing the host view.
    try {
      const rows = await offlineQueue.listFailed();
      const scoped = analysisId
        ? rows.filter((r) => r.analysis_id === analysisId)
        : rows;
      setFailed(scoped);
    } catch {
      setFailed([]);
    }
  }, [analysisId]);

  useEffect(() => {
    void refresh();
    const onTick = (): void => {
      void refresh();
    };
    window.addEventListener(SYNC_WORKER_EVENT, onTick);
    return () => window.removeEventListener(SYNC_WORKER_EVENT, onTick);
  }, [refresh]);

  const discardAll = useCallback(async () => {
    setBusy(true);
    try {
      for (const edit of failed) {
        await offlineQueue.dequeue(edit.id);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [failed, refresh]);

  const retryAll = useCallback(async () => {
    setBusy(true);
    try {
      for (const edit of failed) {
        await offlineQueue.retryFailed(edit.id);
      }
      // Nudge the sync worker to flush immediately.
      window.dispatchEvent(new CustomEvent(`${SYNC_WORKER_EVENT}:nudge`));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [failed, refresh]);

  if (failed.length === 0) return null;

  const sampleError = failed[0]?.last_error ?? '';

  return (
    <Box px="md" pt="xs" data-testid={testId}>
      <EMRAlert
        variant="warning"
        title={t('refine:failedEdits.title', { count: failed.length })}
        icon={IconAlertTriangle}
      >
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            {sampleError
              ? `${t('refine:failedEdits.body')} (${sampleError})`
              : t('refine:failedEdits.body')}
          </Text>
          <Group gap="xs">
            <EMRButton
              size="sm"
              variant="secondary"
              icon={IconRefresh}
              onClick={retryAll}
              loading={busy}
              data-testid={`${testId}-retry`}
            >
              {t('refine:failedEdits.retry')}
            </EMRButton>
            <EMRButton
              size="sm"
              variant="danger"
              icon={IconTrash}
              onClick={discardAll}
              loading={busy}
              data-testid={`${testId}-discard`}
            >
              {t('refine:failedEdits.discardAll')}
            </EMRButton>
          </Group>
        </Stack>
      </EMRAlert>
    </Box>
  );
}

export default FailedEditsAlert;
