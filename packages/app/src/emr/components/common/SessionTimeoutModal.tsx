// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session Timeout Warning Modal
 *
 * HIPAA-compliant modal that warns users before session timeout.
 * Features:
 * - Countdown timer display
 * - Non-dismissible (requires user action)
 * - Focus trap for accessibility
 * - Screen reader announcements
 * - Stay Logged In and Logout Now buttons
 *
 * @module components/common/SessionTimeoutModal
 */

import React, { useEffect, useRef } from 'react';
import { Modal, Stack, Text, Group, Progress, Box } from '@mantine/core';
import { useFocusTrap } from '@mantine/hooks';
import { IconClock, IconLogout, IconRefresh } from '@tabler/icons-react';
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
  /**
   * Whether the modal is currently open
   */
  opened: boolean;

  /**
   * Remaining seconds until auto-logout
   */
  remainingSeconds: number;

  /**
   * Total warning duration in seconds (for progress bar)
   */
  warningDurationSeconds?: number;

  /**
   * Handler for "Stay Logged In" action
   */
  onExtend: () => void;

  /**
   * Handler for "Logout Now" action
   */
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
  const focusTrapRef = useFocusTrap(opened);
  const liveRegionRef = useRef<HTMLDivElement>(null);

  // Calculate progress percentage (inverted - decreases as time runs out)
  const progressPercent = Math.max(
    0,
    (remainingSeconds / warningDurationSeconds) * 100
  );

  // Get progress bar color based on remaining time
  const getProgressColor = (): string => {
    if (remainingSeconds <= 30) return 'red';
    if (remainingSeconds <= 60) return 'orange';
    return 'yellow';
  };

  // Announce countdown to screen readers at key intervals
  useEffect(() => {
    if (!opened || !liveRegionRef.current) return;

    // Announce at specific intervals
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

      <Modal
        opened={opened}
        onClose={() => {}} // Non-dismissible - empty handler
        closeOnClickOutside={false}
        closeOnEscape={false}
        withCloseButton={false}
        centered
        size="sm"
        padding="xl"
        radius="md"
        trapFocus
        returnFocus
        lockScroll
        zIndex={10000}
        classNames={{
          root: styles.modalRoot,
          content: styles.modalContent,
          body: styles.modalBody,
          overlay: styles.modalOverlay,
        }}
        aria-labelledby="session-timeout-title"
        aria-describedby="session-timeout-description"
      >
        <div ref={focusTrapRef}>
          <Stack gap="lg" align="center">
            {/* Icon */}
            <Box className={styles.iconContainer}>
              <IconClock size={48} className={styles.icon} />
            </Box>

            {/* Title */}
            <Text
              id="session-timeout-title"
              size="xl"
              fw={700}
              ta="center"
              className={styles.title}
            >
              {t('session.timeout.title', 'Session Expiring')}
            </Text>

            {/* Countdown display */}
            <Box className={styles.countdownContainer}>
              <Text
                className={styles.countdown}
                aria-label={t(
                  'session.timeout.remainingTime',
                  `${remainingSeconds} seconds remaining`
                )}
              >
                {formatRemainingTime(remainingSeconds)}
              </Text>
            </Box>

            {/* Progress bar */}
            <Progress
              value={progressPercent}
              color={getProgressColor()}
              size="lg"
              radius="xl"
              w="100%"
              animated={remainingSeconds <= 30}
              aria-label={t('session.timeout.progressLabel', 'Time remaining')}
            />

            {/* Description */}
            <Text
              id="session-timeout-description"
              size="sm"
              c="dimmed"
              ta="center"
              className={styles.description}
            >
              {t(
                'session.timeout.description',
                'Your session will expire due to inactivity. Click "Stay Logged In" to continue working, or "Logout Now" to end your session.'
              )}
            </Text>

            {/* Action buttons */}
            <Group gap="md" justify="center" w="100%" mt="md">
              <EMRButton
                variant="ghost"
                icon={IconLogout}
                onClick={onLogout}
                className={styles.logoutButton}
              >
                {t('session.timeout.logoutNow', 'Logout Now')}
              </EMRButton>

              <EMRButton
                variant="primary"
                icon={IconRefresh}
                onClick={onExtend}
                className={styles.extendButton}
              >
                {t('session.timeout.stayLoggedIn', 'Stay Logged In')}
              </EMRButton>
            </Group>

            {/* HIPAA compliance note */}
            <Text size="xs" c="dimmed" ta="center" className={styles.hipaaNote}>
              {t(
                'session.timeout.hipaaNote',
                'For security, sessions timeout after 15 minutes of inactivity.'
              )}
            </Text>
          </Stack>
        </div>
      </Modal>
    </>
  );
}

export default SessionTimeoutModal;
