// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * SessionRecoveryBanner — LiverRa session recovery notice (T110).
 *
 * Plain-English: sits at the top of the app shell. If the user has unsaved
 * draft reports (from a crash, tab close, or seat-timeout) OR currently
 * holds an editing "seat" on a SurgeonReview, we surface a gentle
 * "you have unsaved work" banner with Resume / Discard actions.
 *
 * MVP implementation uses `localStorage` as a placeholder for both the
 * draft queue (IndexedDB — real impl arrives in T242 Phase 6) and the
 * seat-hold flag (server-side TanStack Query — wired in US4).
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Alert, Group, Text } from '@mantine/core';
import { IconRefresh, IconTrash } from '@tabler/icons-react';

import { EMRButton } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';

const DRAFTS_KEY = 'liverra.pendingDrafts';
const SEAT_KEY = 'liverra.seatHeld';

function readPendingDrafts(): unknown[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readSeatHeld(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(SEAT_KEY) === 'true';
}

export interface SessionRecoveryBannerProps {
  /** Called when user clicks Resume. Default: navigates to `/cases`. */
  onResume?: () => void;
  /** Called when user clicks Discard. Clears the stub localStorage keys. */
  onDiscard?: () => void;
}

export function SessionRecoveryBanner({
  onResume,
  onDiscard,
}: SessionRecoveryBannerProps): ReactElement | null {
  const { t } = useTranslation();
  const [hasDrafts, setHasDrafts] = useState(false);
  const [seatHeld, setSeatHeld] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Re-check on mount + whenever localStorage fires a storage event.
  useEffect(() => {
    const refresh = (): void => {
      setHasDrafts(readPendingDrafts().length > 0);
      setSeatHeld(readSeatHeld());
    };
    refresh();
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);

  const handleResume = useCallback(() => {
    if (onResume) {
      onResume();
    } else if (typeof window !== 'undefined') {
      window.location.assign('/cases');
    }
    setDismissed(true);
  }, [onResume]);

  const handleDiscard = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(DRAFTS_KEY);
      window.localStorage.removeItem(SEAT_KEY);
    }
    setHasDrafts(false);
    setSeatHeld(false);
    setDismissed(true);
    onDiscard?.();
  }, [onDiscard]);

  if (dismissed || (!hasDrafts && !seatHeld)) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 40,
      }}
    >
      <Alert
        color="blue"
        icon={<IconRefresh size={16} />}
        title={t('common:sessionRecovery.title')}
        radius={0}
      >
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Text size="sm">
            {t('common:sessionRecovery.unsavedWork')}
          </Text>
          <Group gap="xs">
            <EMRButton size="sm" variant="primary" icon={IconRefresh} onClick={handleResume}>
              {t('common:sessionRecovery.resume')}
            </EMRButton>
            <EMRButton size="sm" variant="ghost" icon={IconTrash} onClick={handleDiscard}>
              {t('common:sessionRecovery.discard')}
            </EMRButton>
          </Group>
        </Group>
      </Alert>
    </div>
  );
}

export default SessionRecoveryBanner;
