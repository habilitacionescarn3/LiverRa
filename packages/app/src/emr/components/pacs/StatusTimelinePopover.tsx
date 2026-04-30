// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// StatusTimelinePopover (LiverRa)
// ============================================================================
// Clickable status badge that opens a vertical lifecycle timeline for a
// study. Each entry shows status, timestamp, actor, and elapsed time since
// the previous step. Ported from MediMind verbatim; no Medplum deps.
// ============================================================================

import React, { memo, useMemo } from 'react';
import {
  Popover,
  Timeline,
  Text,
  Badge,
  Group,
  Stack,
  ThemeIcon,
  Box,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconCheck,
  IconClock,
  IconArrowRight,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import type {
  ImagingStudyListItem,
  ImagingStudyStatus,
  StatusTimelineEntry,
} from '../../types/pacs';
import styles from './StatusTimelinePopover.module.css';

// ============================================================================
// Props
// ============================================================================

interface StatusTimelinePopoverProps {
  /** Study row we're describing (needs status, priority, timeline). */
  study: ImagingStudyListItem;
}

// ============================================================================
// Constants
// ============================================================================

const STATUS_ORDER: ImagingStudyStatus[] = [
  'ordered',
  'scheduled',
  'in-progress',
  'images-available',
  'preliminary-read',
  'reported',
];

const STATUS_LABEL_MAP: Record<string, string> = {
  ordered: 'pacs.status.ordered',
  scheduled: 'pacs.status.scheduled',
  'in-progress': 'pacs.status.inProgress',
  'images-available': 'pacs.status.imagesAvailable',
  'preliminary-read': 'pacs.status.preliminaryRead',
  reported: 'pacs.status.reported',
};

/** STAT studies are overdue once images-available is >30 min after ordered. */
const STAT_OVERDUE_MINUTES = 30;

// ============================================================================
// Helpers
// ============================================================================

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return iso;
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function getElapsedText(fromIso: string, toIso: string): string | null {
  try {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    if (isNaN(from) || isNaN(to)) return null;

    const diffMs = to - from;
    if (diffMs < 0) return null;

    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return '< 1 min';
    if (mins < 60) return `${mins} min`;

    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    if (hours < 24) {
      return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
    }

    const days = Math.floor(hours / 24);
    const remainHours = hours % 24;
    return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
  } catch {
    return null;
  }
}

function getEntryColor(index: number, currentIndex: number): string {
  if (index === currentIndex) return 'blue';
  if (index < currentIndex) return 'green';
  return 'gray';
}

// ============================================================================
// Component
// ============================================================================

export const StatusTimelinePopover = memo(function StatusTimelinePopover({
  study,
}: StatusTimelinePopoverProps): React.ReactElement {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);

  const isStatOverdue = useMemo(() => {
    if (study.priority !== 'stat' || !study.timeline) return false;
    const ordered = study.timeline.find((e) => e.status === 'ordered');
    const imagesAvailable = study.timeline.find(
      (e) => e.status === 'images-available'
    );
    if (!ordered || !imagesAvailable) return false;
    const diffMs =
      new Date(imagesAvailable.timestamp).getTime() -
      new Date(ordered.timestamp).getTime();
    return diffMs > STAT_OVERDUE_MINUTES * 60000;
  }, [study.priority, study.timeline]);

  const currentStatusIndex = STATUS_ORDER.indexOf(study.status);

  const timelineEntries = useMemo((): StatusTimelineEntry[] => {
    return study.timeline || [];
  }, [study.timeline]);

  const badgeClassName = `${styles.triggerBadge} ${
    styles[`status-${study.status}`] || ''
  }`;

  return (
    <Popover
      opened={opened}
      onClose={close}
      position="bottom"
      withArrow
      shadow="md"
      width={320}
    >
      <Popover.Target>
        <button
          className={badgeClassName}
          onClick={(e) => {
            e.stopPropagation();
            opened ? close() : open();
          }}
          aria-label={t('pacs.timeline.viewTimeline')}
          aria-expanded={opened}
          aria-haspopup="true"
          data-testid="status-timeline-trigger"
        >
          {t(STATUS_LABEL_MAP[study.status] || 'pacs.status.ordered')}
          {study.priority === 'stat' && (
            <span className={styles.statIndicator}>{t('pacs.priority.stat')}</span>
          )}
          {study.priority === 'urgent' && (
            <span className={styles.urgentIndicator}>
              {t('pacs.priority.urgent')}
            </span>
          )}
        </button>
      </Popover.Target>

      <Popover.Dropdown>
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Text
              fw="var(--emr-font-semibold)"
              fz="var(--emr-font-sm)"
              c="var(--emr-text-primary)"
            >
              {t('pacs.timeline.title')}
            </Text>
            {isStatOverdue && (
              <Badge
                size="xs"
                color="red"
                variant="filled"
                leftSection={<IconAlertTriangle size={10} />}
              >
                {t('pacs.timeline.statOverdue')}
              </Badge>
            )}
          </Group>

          {timelineEntries.length === 0 ? (
            <Text
              fz="var(--emr-font-xs)"
              c="var(--emr-text-secondary)"
              ta="center"
              py="sm"
            >
              {t('pacs.timeline.noHistory')}
            </Text>
          ) : (
            <Timeline
              active={timelineEntries.length - 1}
              bulletSize={24}
              lineWidth={2}
              data-testid="status-timeline"
              styles={{
                itemTitle: { fontSize: 'var(--emr-font-xs)' },
                itemBody: { fontSize: 'var(--emr-font-xs)' },
              }}
            >
              {timelineEntries.map((entry, index) => {
                const entryStatusIndex = STATUS_ORDER.indexOf(
                  entry.status as ImagingStudyStatus
                );
                const isCurrent = entry.status === study.status;
                const isPast =
                  entryStatusIndex < currentStatusIndex &&
                  entryStatusIndex >= 0;

                const elapsed =
                  index > 0
                    ? getElapsedText(
                        timelineEntries[index - 1].timestamp,
                        entry.timestamp
                      )
                    : null;

                let bulletIcon: React.ReactElement;
                if (isCurrent) {
                  bulletIcon = <IconArrowRight size={12} />;
                } else if (isPast) {
                  bulletIcon = <IconCheck size={12} />;
                } else {
                  bulletIcon = <IconClock size={12} />;
                }

                const color = isCurrent
                  ? 'blue'
                  : isPast
                    ? 'green'
                    : getEntryColor(index, timelineEntries.length - 1);

                return (
                  <Timeline.Item
                    key={`${entry.status}-${index}`}
                    data-testid={`timeline-entry-${index}`}
                    bullet={
                      <ThemeIcon
                        size={24}
                        variant={isCurrent ? 'filled' : 'light'}
                        radius="xl"
                        color={color}
                        style={
                          isCurrent
                            ? { background: 'var(--emr-gradient-primary)' }
                            : undefined
                        }
                      >
                        {bulletIcon}
                      </ThemeIcon>
                    }
                    title={
                      <Group gap={6} wrap="wrap" align="center">
                        <Badge
                          size="xs"
                          variant={isCurrent ? 'filled' : 'light'}
                          color={isCurrent ? 'blue' : isPast ? 'teal' : 'gray'}
                        >
                          {t(STATUS_LABEL_MAP[entry.status] || entry.status)}
                        </Badge>
                        <Text
                          fz="var(--emr-font-xs)"
                          c="var(--emr-text-secondary)"
                        >
                          {formatTimestamp(entry.timestamp)}
                        </Text>
                      </Group>
                    }
                  >
                    <Box mt={2}>
                      {entry.actor && (
                        <Text
                          fz="var(--emr-font-xs)"
                          c="var(--emr-text-secondary)"
                        >
                          {entry.actor}
                        </Text>
                      )}
                      {elapsed && (
                        <Text fz="var(--emr-font-xs)" c="dimmed" mt={2}>
                          <IconClock
                            size={10}
                            style={{
                              verticalAlign: 'middle',
                              marginRight: 3,
                            }}
                          />
                          {elapsed}
                        </Text>
                      )}
                    </Box>
                  </Timeline.Item>
                );
              })}
            </Timeline>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
});

export default StatusTimelinePopover;
