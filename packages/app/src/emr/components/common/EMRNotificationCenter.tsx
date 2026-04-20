// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRNotificationCenter Component
 *
 * Notification center accessible from header showing recent alerts and updates.
 * Features:
 * - Bell icon with unread count badge
 * - Dropdown/popover with notification list
 * - Mark as read functionality
 * - Mobile-responsive design
 *
 * @example
 * ```tsx
 * <EMRNotificationCenter
 *   notifications={notifications}
 *   unreadCount={3}
 *   onRead={handleMarkAsRead}
 *   onReadAll={handleMarkAllAsRead}
 *   onNotificationClick={handleNotificationClick}
 * />
 * ```
 */

import React, { useState, useCallback } from 'react';
import {
  ActionIcon,
  Indicator,
  Popover,
  ScrollArea,
  Stack,
  Group,
  Text,
  Button,
  Box,
  UnstyledButton,
  ThemeIcon,
  Tooltip,
  Badge,
  Center,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconBell,
  IconBellOff,
  IconChecks,
  IconAlertCircle,
  IconInfoCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconMessage,
  IconCalendar,
  IconUserPlus,
  IconStethoscope,
  IconFlask,
  IconX,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import { formatRelativeTime } from '../../services/localeService';

// ============================================================================
// Types
// ============================================================================

export type NotificationType =
  | 'alert'
  | 'info'
  | 'warning'
  | 'success'
  | 'message'
  | 'appointment'
  | 'patient'
  | 'lab'
  | 'clinical';

export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface EMRNotification {
  /** Unique identifier */
  id: string;
  /** Notification type */
  type: NotificationType;
  /** Priority level */
  priority?: NotificationPriority;
  /** Title */
  title: string;
  /** Description/body */
  description?: string;
  /** Timestamp */
  timestamp: Date;
  /** Whether the notification has been read */
  isRead: boolean;
  /** Optional link to navigate to */
  href?: string;
  /** Optional associated resource ID */
  resourceId?: string;
  /** Optional associated resource type */
  resourceType?: string;
}

export interface EMRNotificationCenterProps {
  /** Array of notifications */
  notifications: EMRNotification[];
  /** Number of unread notifications (can differ from filtered list) */
  unreadCount?: number;
  /** Mark a single notification as read */
  onRead?: (id: string) => void;
  /** Mark all notifications as read */
  onReadAll?: () => void;
  /** Handle notification click */
  onNotificationClick?: (notification: EMRNotification) => void;
  /** Handle dismiss notification */
  onDismiss?: (id: string) => void;
  /** Maximum notifications to show */
  maxVisible?: number;
  /** Handle "View All" button click */
  onViewAll?: () => void;
  /** Loading state */
  isLoading?: boolean;
  /** Disabled state */
  disabled?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const TYPE_ICONS: Record<NotificationType, React.FC<{ size?: number | string }>> = {
  alert: IconAlertCircle,
  info: IconInfoCircle,
  warning: IconAlertTriangle,
  success: IconCircleCheck,
  message: IconMessage,
  appointment: IconCalendar,
  patient: IconUserPlus,
  lab: IconFlask,
  clinical: IconStethoscope,
};

const TYPE_COLORS: Record<NotificationType, string> = {
  alert: 'red',
  info: 'blue',
  warning: 'orange',
  success: 'green',
  message: 'cyan',
  appointment: 'violet',
  patient: 'teal',
  lab: 'grape',
  clinical: 'pink',
};

// ============================================================================
// Styles
// ============================================================================

const styles = {
  bellButton: {
    color: 'var(--emr-text-primary)',
    transition: 'all 0.2s',
  },
  popoverDropdown: {
    padding: 0,
    border: '1px solid var(--emr-border-color)',
    boxShadow: 'var(--emr-shadow-lg)',
    maxWidth: '400px',
    width: '100%',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--emr-border-color)',
    background: 'var(--emr-bg-hover)',
  },
  notificationItem: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--emr-border-color)',
    cursor: 'pointer',
    transition: 'background 0.2s',
    '&:hover': {
      background: 'var(--emr-bg-hover)',
    },
    '&:last-child': {
      borderBottom: 'none',
    },
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--emr-primary)',
    flexShrink: 0,
  },
  emptyState: {
    padding: '32px 16px',
    textAlign: 'center' as const,
  },
  footer: {
    padding: '12px 16px',
    borderTop: '1px solid var(--emr-border-color)',
    background: 'var(--emr-bg-hover)',
  },
} as const;

// ============================================================================
// Helper Functions
// ============================================================================


// ============================================================================
// Sub-components
// ============================================================================

/**
 * Single notification item
 */
interface NotificationItemProps {
  notification: EMRNotification;
  onRead?: (id: string) => void;
  onClick?: (notification: EMRNotification) => void;
  onDismiss?: (id: string) => void;
  t: (key: string) => string;
  lang?: 'ka' | 'en' | 'ru';
}

const NotificationItem = React.memo(function NotificationItem({
  notification,
  onRead,
  onClick,
  onDismiss,
  t,
  lang = 'ka',
}: NotificationItemProps): React.ReactElement {
  const Icon = TYPE_ICONS[notification.type] || IconInfoCircle;
  const color = TYPE_COLORS[notification.type] || 'blue';

  const handleClick = useCallback(() => {
    if (!notification.isRead && onRead) {
      onRead(notification.id);
    }
    onClick?.(notification);
  }, [notification, onRead, onClick]);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDismiss?.(notification.id);
  }, [notification.id, onDismiss]);

  return (
    <UnstyledButton
      onClick={handleClick}
      style={{
        ...styles.notificationItem,
        opacity: notification.isRead ? 0.7 : 1,
        background: notification.isRead ? 'transparent' : 'var(--emr-bg-card)',
      }}
      w="100%"
    >
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon
          size="md"
          variant="light"
          color={color}
          radius="xl"
          style={{ flexShrink: 0 }}
        >
          <Icon size={16} />
        </ThemeIcon>

        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs" wrap="nowrap" justify="space-between">
            <Text size="sm" fw={notification.isRead ? 400 : 600} lineClamp={1}>
              {notification.title}
            </Text>
            {!notification.isRead && <Box style={styles.unreadDot} />}
          </Group>

          {notification.description && (
            <Text size="xs" c="dimmed" lineClamp={2}>
              {notification.description}
            </Text>
          )}

          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {formatRelativeTime(notification.timestamp, { locale: lang })}
            </Text>
            {notification.priority === 'urgent' && (
              <Badge size="xs" color="red" variant="light">
                {t('notifications.urgent')}
              </Badge>
            )}
            {notification.priority === 'high' && (
              <Badge size="xs" color="orange" variant="light">
                {t('notifications.high')}
              </Badge>
            )}
          </Group>
        </Stack>

        {onDismiss && (
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={handleDismiss}
            aria-label="Dismiss notification"
          >
            <IconX size={14} />
          </ActionIcon>
        )}
      </Group>
    </UnstyledButton>
  );
});

// ============================================================================
// Main Component
// ============================================================================

/**
 * EMRNotificationCenter - Header notification center with bell icon and dropdown
 */
export function EMRNotificationCenter({
  notifications,
  unreadCount,
  onRead,
  onReadAll,
  onNotificationClick,
  onDismiss,
  maxVisible = 10,
  onViewAll,
  isLoading = false,
  disabled = false,
}: EMRNotificationCenterProps): React.ReactElement {
  const { t, lang } = useTranslation();
  const [opened, setOpened] = useState(false);
  const isMobile = useMediaQuery('(max-width: 768px)');

  const effectiveUnreadCount = unreadCount ?? notifications.filter((n) => !n.isRead).length;
  const visibleNotifications = notifications.slice(0, maxVisible);
  const hasNotifications = notifications.length > 0;
  const hasMoreNotifications = notifications.length > maxVisible;

  const handleNotificationClick = useCallback((notification: EMRNotification) => {
    onNotificationClick?.(notification);
    setOpened(false);
  }, [onNotificationClick]);

  const handleMarkAllAsRead = useCallback(() => {
    onReadAll?.();
  }, [onReadAll]);

  const handleViewAll = useCallback(() => {
    setOpened(false);
    onViewAll?.();
  }, [onViewAll]);

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={isMobile ? '100vw' : 380}
      offset={8}
      shadow="lg"
    >
      <Popover.Target>
        <Tooltip label={t('notifications.title') || 'Notifications'} disabled={opened}>
          <Box style={{ position: 'relative', display: 'inline-flex' }}>
            <Indicator
              label={effectiveUnreadCount > 99 ? '99+' : effectiveUnreadCount}
              size={effectiveUnreadCount > 0 ? 18 : 0}
              color="red"
              offset={4}
              disabled={effectiveUnreadCount === 0}
            >
              <ActionIcon
                variant="subtle"
                size="lg"
                onClick={() => setOpened((o) => !o)}
                disabled={disabled}
                aria-label={
                  effectiveUnreadCount > 0
                    ? `${t('notifications.title', 'Notifications')} - ${effectiveUnreadCount} ${t('notifications.unread', 'unread')}`
                    : t('notifications.title', 'Notifications')
                }
                loading={isLoading}
                style={styles.bellButton}
              >
                {effectiveUnreadCount > 0 ? (
                  <IconBell size={22} />
                ) : (
                  <IconBellOff size={22} style={{ opacity: 0.6 }} />
                )}
              </ActionIcon>
            </Indicator>
            {/* Screen reader announcement for count changes */}
            <Box
              aria-live="polite"
              aria-atomic="true"
              style={{
                position: 'absolute',
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: 'hidden',
                clip: 'rect(0, 0, 0, 0)',
                whiteSpace: 'nowrap',
                border: 0,
              }}
            >
              {effectiveUnreadCount > 0 &&
                `${effectiveUnreadCount} ${t('notifications.unreadNotifications', 'unread notifications')}`}
            </Box>
          </Box>
        </Tooltip>
      </Popover.Target>

      <Popover.Dropdown style={styles.popoverDropdown}>
        {/* Header */}
        <Box style={styles.header}>
          <Group justify="space-between">
            <Text fw={600} size="sm">
              {t('notifications.title') || 'Notifications'}
              {effectiveUnreadCount > 0 && (
                <Text span c="dimmed" size="sm" ml="xs">
                  ({effectiveUnreadCount} {t('notifications.unread')})
                </Text>
              )}
            </Text>
            {effectiveUnreadCount > 0 && onReadAll && (
              <Button
                variant="subtle"
                size="xs"
                leftSection={<IconChecks size={14} />}
                onClick={handleMarkAllAsRead}
              >
                {t('notifications.markAllRead') || 'Mark all read'}
              </Button>
            )}
          </Group>
        </Box>

        {/* Notifications List */}
        {hasNotifications ? (
          <ScrollArea.Autosize mah={400}>
            <Stack gap={0}>
              {visibleNotifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onRead={onRead}
                  onClick={handleNotificationClick}
                  onDismiss={onDismiss}
                  t={t}
                  lang={lang}
                />
              ))}
            </Stack>
          </ScrollArea.Autosize>
        ) : (
          <Center style={styles.emptyState}>
            <Stack align="center" gap="xs">
              <ThemeIcon size="xl" variant="light" color="gray" radius="xl">
                <IconBellOff size={24} />
              </ThemeIcon>
              <Text c="dimmed" size="sm">
                {t('notifications.empty') || 'No notifications'}
              </Text>
            </Stack>
          </Center>
        )}

        {/* Footer */}
        {hasMoreNotifications && onViewAll && (
          <Box style={styles.footer}>
            <Button
              variant="subtle"
              fullWidth
              size="xs"
              onClick={handleViewAll}
            >
              {t('notifications.viewAll') || 'View all notifications'}
            </Button>
          </Box>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

export default EMRNotificationCenter;
