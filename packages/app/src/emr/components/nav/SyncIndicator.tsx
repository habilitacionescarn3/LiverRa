// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * SyncIndicator (T246).
 *
 * Plain-English: the little pill in the app header that tells the user
 * whether their edits are making it to the server. Four states:
 *   - online  (green dot)
 *   - offline (grey dot with queue count)
 *   - syncing (blue spinner)
 *   - degraded = offline + queue > 0 → orange
 *
 * Clicking the pill toggles a tiny popover listing the pending edits
 * so the reviewer can see exactly what is waiting.
 *
 * Spec refs: FR-018c, plan §Offline reviewer-edit durability.
 */

import { Badge, Group, Popover, Stack, Text } from '@mantine/core';
import {
  IconCloud,
  IconCloudCheck,
  IconCloudOff,
  IconLoader,
} from '@tabler/icons-react';
import {
  useEffect,
  useState,
  type ReactElement,
} from 'react';

import { useSync } from '../../contexts/SyncContext';
import { useTranslation } from '../../contexts/TranslationContext';
import {
  offlineQueue,
  type OfflineEdit,
} from '../../services/offline/offlineQueue';

export function SyncIndicator(): ReactElement {
  const { t } = useTranslation();
  const { status, queueDepth, lastSyncAt, nudge } = useSync();
  const [open, setOpen] = useState<boolean>(false);
  const [pending, setPending] = useState<OfflineEdit[]>([]);

  useEffect(() => {
    if (!open) return;
    void offlineQueue.listPending().then(setPending);
  }, [open, queueDepth]);

  const iconMap: Record<typeof status, ReactElement> = {
    online: <IconCloudCheck size={14} />,
    offline: <IconCloudOff size={14} />,
    syncing: <IconLoader size={14} className="emr-spin" />,
  };

  const colorMap: Record<typeof status, string> = {
    online: 'teal',
    offline: queueDepth > 0 ? 'orange' : 'gray',
    syncing: 'blue',
  };

  const label =
    status === 'syncing'
      ? t('sync.syncing')
      : status === 'offline'
        ? queueDepth > 0
          ? t('sync.offlineWithQueue', { count: queueDepth })
          : t('sync.offline')
        : queueDepth > 0
          ? t('sync.onlineWithQueue', { count: queueDepth })
          : t('sync.online');

  return (
    <Popover
      opened={open}
      onChange={setOpen}
      position="bottom-end"
      withArrow
      width={320}
    >
      <Popover.Target>
        <Badge
          component="button"
          type="button"
          variant="light"
          color={colorMap[status]}
          leftSection={iconMap[status]}
          onClick={() => setOpen((o) => !o)}
          data-testid="sync-indicator"
          aria-label={label}
          style={{ cursor: 'pointer' }}
        >
          {label}
        </Badge>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Group justify="space-between">
            <Text fw={600} size="sm">
              {t('sync.pendingTitle')}
            </Text>
            <IconCloud size={14} />
          </Group>
          {pending.length === 0 ? (
            <Text size="xs" c="dimmed">
              {t('sync.noPending')}
            </Text>
          ) : (
            <Stack gap={4}>
              {pending.slice(0, 10).map((p) => (
                <Group key={p.id} justify="space-between" gap="xs">
                  <Text size="xs">
                    {t(`sync.editType.${p.edit_type}`)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {new Date(p.created_at).toLocaleTimeString()}
                  </Text>
                </Group>
              ))}
              {pending.length > 10 && (
                <Text size="xs" c="dimmed">
                  {t('sync.moreCount', { count: pending.length - 10 })}
                </Text>
              )}
            </Stack>
          )}
          {lastSyncAt && (
            <Text size="xs" c="dimmed">
              {t('sync.lastSync', {
                at: new Date(lastSyncAt).toLocaleTimeString(),
              })}
            </Text>
          )}
          <button
            type="button"
            onClick={nudge}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--emr-primary)',
              cursor: 'pointer',
              padding: 0,
              textAlign: 'left',
              font: 'inherit',
              fontSize: 'var(--emr-font-xs, 12px)',
            }}
            data-testid="sync-indicator-nudge"
          >
            {t('sync.retryNow')}
          </button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export default SyncIndicator;
