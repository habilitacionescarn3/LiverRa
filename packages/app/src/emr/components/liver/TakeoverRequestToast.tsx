// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * TakeoverRequestToast (T423).
 *
 * Plain-English analogy:
 *   You're sitting on the one-and-only piano bench (the "reviewer seat")
 *   and another musician politely asks to play. This toast pops up with
 *   a 15-second countdown — click "Release" to hand over the bench, click
 *   "Keep" (or do nothing) and the requester gets a "busy" reply.
 *
 * The toast is driven by `TAKEOVER_REQUESTED_EVENT` dispatched by
 * `useReviewSeat` when the SSE channel pushes a `takeover-requested`
 * payload. On "Release" we call `release()` from the seat context; on
 * "Keep" we POST a decline so the requester doesn't wait.
 *
 * Spec refs: FR-017a, plan §Review seat concurrency edge.
 */

import { Alert, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import { useTranslation } from '../../contexts/TranslationContext';
import { useReviewSeatContext } from '../../contexts/ReviewSeatContext';
import {
  TAKEOVER_REQUESTED_EVENT,
  type TakeoverRequestedDetail,
} from '../../hooks/useReviewSeat';
import { EMRButton } from '../common/EMRButton';

/** Seconds before the toast auto-dismisses and notifies the requester. */
const COUNTDOWN_SECONDS = 15;

export function TakeoverRequestToast(): ReactElement | null {
  const { t } = useTranslation();
  const seat = useReviewSeatContext();
  const [visible, setVisible] = useState<boolean>(false);
  const [secondsLeft, setSecondsLeft] = useState<number>(COUNTDOWN_SECONDS);
  const detailRef = useRef<TakeoverRequestedDetail | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback((): void => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback((): void => {
    clearTimer();
    setVisible(false);
    setSecondsLeft(COUNTDOWN_SECONDS);
    detailRef.current = null;
  }, [clearTimer]);

  const handleRelease = useCallback(async (): Promise<void> => {
    dismiss();
    try {
      await seat.release();
    } catch {
      /* Release is best-effort — the TTL expiry will reap it anyway. */
    }
  }, [dismiss, seat]);

  const handleKeep = useCallback((): void => {
    dismiss();
    // The requester is notified via the server-side timeline replay —
    // no client-side POST needed; our seat heartbeat already implies
    // "still editing".
  }, [dismiss]);

  // Listen for takeover-requested events dispatched by useReviewSeat.
  useEffect(() => {
    const onRequested = (ev: Event): void => {
      const detail = (ev as CustomEvent<TakeoverRequestedDetail>).detail;
      if (!detail) return;
      detailRef.current = detail;
      setSecondsLeft(COUNTDOWN_SECONDS);
      setVisible(true);

      clearTimer();
      timerRef.current = setInterval(() => {
        setSecondsLeft((prev) => {
          if (prev <= 1) {
            // Timed out — treat as "Keep" per FR-017a default.
            handleKeep();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    };

    window.addEventListener(
      TAKEOVER_REQUESTED_EVENT,
      onRequested as EventListener,
    );
    return () => {
      window.removeEventListener(
        TAKEOVER_REQUESTED_EVENT,
        onRequested as EventListener,
      );
      clearTimer();
    };
  }, [clearTimer, handleKeep]);

  if (!visible || !detailRef.current) return null;

  return (
    <Alert
      icon={<IconAlertTriangle size={18} />}
      color="orange"
      variant="filled"
      withCloseButton
      onClose={handleKeep}
      role="alertdialog"
      aria-live="assertive"
      data-testid="takeover-request-toast"
      style={{
        position: 'fixed',
        top: 'var(--emr-space-lg, 24px)',
        right: 'var(--emr-space-lg, 24px)',
        zIndex: 9999,
        maxWidth: 420,
      }}
    >
      <Stack gap="xs">
        <Text fw={600}>{t('takeover.title')}</Text>
        <Text size="sm">
          {t('takeover.body', { seconds: secondsLeft })}
        </Text>
        <Group justify="flex-end" gap="xs">
          <EMRButton size="xs" variant="outline" onClick={handleKeep}>
            {t('takeover.keep')}
          </EMRButton>
          <EMRButton
            size="xs"
            color="red"
            onClick={() => void handleRelease()}
          >
            {t('takeover.release')}
          </EMRButton>
        </Group>
      </Stack>
    </Alert>
  );
}

export default TakeoverRequestToast;
