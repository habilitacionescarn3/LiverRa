// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RecordLockBanner — LiverRa record lock banner (T100).
 *
 * Plain-English: shows the surgeon how much time they have left to edit a
 * Case (seat-hold window). When the seat expires and someone else takes
 * over, it switches to a red "locked" banner. If this user has permission
 * to force-override (e.g. admin), an override button appears.
 *
 * Drives its state from the `SurgeonReview.seat_held_until` timestamp
 * (data-model §11) — passed in via props rather than read inline so this
 * component stays presentational.
 */

import type { ReactElement } from 'react';
import { Alert, Group, Text } from '@mantine/core';
import { IconLock, IconClock, IconAlertTriangle } from '@tabler/icons-react';

import { EMRButton } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';

export interface RecordLockStatus {
  /** True when seat-hold has expired and another user is editing. */
  isLocked: boolean;
  /** Milliseconds remaining in the current user's edit window. */
  timeRemainingMs: number;
  /** True when this user has permission to force-override the lock. */
  canOverride: boolean;
}

export interface RecordLockBannerProps {
  status: RecordLockStatus;
  /** Called when user clicks the override button. */
  onOverride?: () => void;
}

export function RecordLockBanner({
  status,
  onOverride,
}: RecordLockBannerProps): ReactElement | null {
  const { t } = useTranslation();

  if (!status.isLocked && status.timeRemainingMs > 0) {
    const hours = Math.floor(status.timeRemainingMs / (60 * 60 * 1000));
    const minutes = Math.floor((status.timeRemainingMs % (60 * 60 * 1000)) / (60 * 1000));

    return (
      <Alert icon={<IconClock size={16} />} color="blue" mb="md">
        <Group justify="space-between">
          <Text size="sm">
            {t('common:recordLock.timeRemaining', { hours, minutes })}
          </Text>
        </Group>
      </Alert>
    );
  }

  if (status.isLocked && !status.canOverride) {
    return (
      <Alert icon={<IconLock size={16} />} color="red" mb="md">
        <Text size="sm">{t('common:recordLock.locked')}</Text>
      </Alert>
    );
  }

  if (status.isLocked && status.canOverride) {
    return (
      <Alert icon={<IconAlertTriangle size={16} />} color="orange" mb="md">
        <Group justify="space-between">
          <Text size="sm">{t('common:recordLock.lockedWithOverride')}</Text>
          {onOverride && (
            <EMRButton size="sm" variant="outline" onClick={onOverride}>
              {t('common:recordLock.override')}
            </EMRButton>
          )}
        </Group>
      </Alert>
    );
  }

  return null;
}

export default RecordLockBanner;
