// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session Timeout Warning Modal
 *
 * HIPAA-compliant modal that warns users before session timeout.
 * Built on EMRModal wrapper (H-DS-2 fix — was raw Mantine Modal).
 * Features:
 * - Countdown timer display
 * - Non-dismissible (closeOnClickOutside={false}, closeOnEscape={false})
 * - Focus trap via EMRModal's built-in trapFocus
 * - Screen reader announcements
 * - Stay Logged In and Logout Now buttons
 *
 * @module components/common/SessionTimeoutModal
 */

import React, { useEffect, useRef } from 'react';
import { Stack, Text, Box, Progress } from '@mantine/core';
import { IconClock, IconLogout, IconRefresh } from '@tabler/icons-react';
import { EMRModal } from './EMRModal';
import { EMRButton } from './EMRButton';
import { useTranslation } from '../../contexts/TranslationContext';
import styles from './SessionTimeoutModal.module.css';

/**
 * Format seconds as "M:SS" countdown string (inlined — LiverRa uses
 * the `useIdleTimeout` hook which dispatches `liverra:session-timeout`
 * DOM events rather than exposing a formatter helper).
 */
function formatRemainingTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/**
 * Props for SessionTimeoutModal
 */
export interface SessionTimeoutModalProps {
  /** Whether the modal is currently open */
  opened: boolean;
  /** Remaining seconds until auto-logout */
  remainingSeconds: number;
  /** Total warning duration in seconds (for progress bar) */
  warningDurationSeconds?: number;
  /** Handler for "Stay Logged In" action */
  onExtend: () => void;
  /** Handler for "Logout Now" action */
  onLogout: () => void;
}

/**
 * Session Timeout Warning Modal
 *
 * Displays a non-dismissible warning when the user's session is about to expire.
 * Includes a countdown timer, progress bar, and action buttons.
 *
 * @example
 * ```tsx
 * const { showWarning, remainingSeconds, extendSession, logout } = useSessionTimeout();
 *
 * <SessionTimeoutModal
 *   opened={showWarning}
 *   remainingSeconds={remainingSeconds}
 *   onExtend={extendSession}
 *   onLogout={logout}
 * />
 * ```
 */
export function SessionTimeoutModal({
  opened,
  remainingSeconds,
  warningDurationSeconds = 120,
  onExtend,
  onLogout,
}: SessionTimeoutModalProps): React.JSX.Element {
  const { t } = useTranslation();
  const liveRegionRef = useRef<HTMLDivElement>(null);

  // Calculate progress percentage (decreases as time runs out)
  const progressPercent = Math.max(
    0,
    (remainingSeconds / warningDurationSeconds) * 100
  );

  // Map progress to semantic color tokens (no hardcoded colors).
  const getProgressColorVar = (): string => {
    if (remainingSeconds <= 30) return 'var(--emr-error)';
    if (remainingSeconds <= 60) return 'var(--emr-warning)';
    return 'var(--emr-info)';
  };

  // Announce countdown to screen readers at key intervals
  useEffect(() => {
    if (!opened || !liveRegionRef.current) return;
    if (
      remainingSeconds === 120 ||
      remainingSeconds === 60 ||
      remainingSeconds === 30 ||
      remainingSeconds === 10 ||
      remainingSeconds <= 5
    ) {
      liveRegionRef.current.textContent = t(
        'session.timeout.announcement',
        `Session expiring in ${remainingSeconds} seconds`
      ).replace('{{seconds}}', String(remainingSeconds));
    }
  }, [remainingSeconds, opened, t]);

  // Announce modal opening
  useEffect(() => {
    if (opened && liveRegionRef.current) {
      liveRegionRef.current.textContent = t(
        'session.timeout.warningAnnouncement',
        'Warning: Your session is about to expire due to inactivity'
      );
    }
  }, [opened, t]);

  // Custom footer — two side-by-side actions (Logout / Stay Logged In).
  const footer = (
    <Box style={{ display: 'flex', gap: 12, justifyContent: 'center', width: '100%' }}>
      <EMRButton
        variant="ghost"
        icon={IconLogout}
        onClick={onLogout}
        className={styles.logoutButton}
      >
        {t('session.timeout.logoutNow')}
      </EMRButton>
      <EMRButton
        variant="primary"
        icon={IconRefresh}
        onClick={onExtend}
        className={styles.extendButton}
      >
        {t('session.timeout.stayLoggedIn')}
      </EMRButton>
    </Box>
  );

  return (
    <>
      {/* Screen reader live region for announcements */}
      <div
        ref={liveRegionRef}
        role="status"
        aria-live="assertive"
        aria-atomic="true"
        className={styles.srOnly}
      />

      <EMRModal
        opened={opened}
        // Non-dismissible: empty onClose handler.
        onClose={() => {}}
        title={t('session.timeout.title')}
        icon={IconClock}
        size="sm"
        closeOnClickOutside={false}
        closeOnEscape={false}
        withCloseButton={false}
        footer={footer}
        showFooter
        zIndex={10000}
        testId="session-timeout-modal"
      >
        <Stack gap="lg" align="center">
          {/* Countdown display */}
          <Box className={styles.countdownContainer}>
            <Text
              className={styles.countdown}
              aria-label={t('session.timeout.remainingTime', { seconds: remainingSeconds })}
            >
              {formatRemainingTime(remainingSeconds)}
            </Text>
          </Box>

          {/* Progress bar — color via inline style targets the bar element. */}
          <Progress
            value={progressPercent}
            size="lg"
            radius="xl"
            w="100%"
            animated={remainingSeconds <= 30}
            aria-label={t('session.timeout.progressLabel')}
            styles={{ section: { backgroundColor: getProgressColorVar() } }}
          />

          {/* Description */}
          <Text
            size="sm"
            c="var(--emr-text-secondary)"
            ta="center"
            className={styles.description}
          >
            {t(
              'session.timeout.description',
              'Your session will expire due to inactivity. Click "Stay Logged In" to continue working, or "Logout Now" to end your session.'
            )}
          </Text>

          {/* HIPAA compliance note */}
          <Text size="xs" c="var(--emr-text-secondary)" ta="center" className={styles.hipaaNote}>
            {t(
              'session.timeout.hipaaNote',
              'For security, sessions timeout after 15 minutes of inactivity.'
            )}
          </Text>
        </Stack>
      </EMRModal>
    </>
  );
}

export default SessionTimeoutModal;
