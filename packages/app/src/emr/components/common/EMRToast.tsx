// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { notifications } from '@mantine/notifications';
import {
  IconCheck,
  IconX,
  IconAlertTriangle,
  IconInfoCircle,
} from '@tabler/icons-react';
import type { ComponentType } from 'react';

/** Icon props type for Tabler icons */
interface IconProps {
  size?: number | string;
  stroke?: number;
  color?: string;
}

/** Toast notification variants */
export type EMRToastVariant = 'success' | 'error' | 'warning' | 'info';

/** Toast notification position */
export type EMRToastPosition =
  | 'top-left'
  | 'top-right'
  | 'top-center'
  | 'bottom-left'
  | 'bottom-right'
  | 'bottom-center';

/** Toast notification options */
export interface EMRToastOptions {
  /** Unique ID for the notification (for updates) */
  id?: string;
  /** Toast title */
  title?: string;
  /** Toast message (required) */
  message: string;
  /** Toast variant: success, error, warning, info */
  variant?: EMRToastVariant;
  /** Custom icon (overrides variant default) */
  icon?: ComponentType<IconProps>;
  /** Auto-close delay in ms (0 to disable) */
  autoClose?: number | false;
  /** Whether the toast can be manually closed */
  withCloseButton?: boolean;
  /** Callback when toast is closed */
  onClose?: () => void;
  /** Whether to show a loading state */
  loading?: boolean;
}

/** Configuration for EMRToast */
export interface EMRToastConfig {
  /** Default position for toasts */
  position?: EMRToastPosition;
  /** Default auto-close delay */
  autoClose?: number;
  /** Max number of toasts to show at once */
  limit?: number;
}

/** Default icons for each variant */
const variantIcons: Record<EMRToastVariant, ComponentType<IconProps>> = {
  success: IconCheck,
  error: IconX,
  warning: IconAlertTriangle,
  info: IconInfoCircle,
};

/** Colors for each variant */
const variantColors: Record<EMRToastVariant, string> = {
  success: 'green',
  error: 'red',
  warning: 'yellow',
  info: 'blue',
};

/** Icon background colors for each variant */
const variantBgColors: Record<EMRToastVariant, string> = {
  success: 'var(--emr-success)',
  error: 'var(--emr-error)',
  warning: 'var(--emr-warning)',
  info: 'var(--emr-info)',
};

/**
 * EMRToast - Centralized toast notification system for EMR
 *
 * Features:
 * - Consistent styling across all notifications
 * - Four variants: success, error, warning, info
 * - Theme-aware colors
 * - Mobile-friendly positioning
 * - Auto-close with customizable duration
 * - Loading state support
 *
 * @example
 * ```tsx
 * // Success toast
 * EMRToast.success('Patient registered successfully');
 *
 * // Error toast with title
 * EMRToast.error({ title: 'Error', message: 'Failed to save changes' });
 *
 * // Warning toast
 * EMRToast.warning('Session will expire in 5 minutes');
 *
 * // Info toast with custom duration
 * EMRToast.info({ message: 'New updates available', autoClose: 10000 });
 *
 * // Show loading toast, then update it
 * EMRToast.loading('Saving...', { id: 'save-toast' });
 * // Later:
 * EMRToast.success({ id: 'save-toast', message: 'Saved!' });
 * ```
 */
export const EMRToast = {
  /**
   * Show a toast notification
   */
  show: (options: EMRToastOptions): string => {
    const {
      id,
      title,
      message,
      variant = 'info',
      icon,
      autoClose = 5000,
      withCloseButton = true,
      onClose,
      loading = false,
    } = options;

    const IconComponent = icon || variantIcons[variant];
    const color = variantColors[variant];

    return notifications.show({
      id,
      title,
      message,
      color,
      icon: loading ? undefined : <IconComponent size={20} stroke={2} />,
      loading,
      autoClose: loading ? false : autoClose,
      withCloseButton,
      onClose,
      styles: {
        root: {
          backgroundColor: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-border-default)',
          borderRadius: 12,
          boxShadow: 'var(--emr-shadow-lg)',
          padding: '12px 16px',
        },
        icon: {
          backgroundColor: variantBgColors[variant],
          borderRadius: 8,
          padding: 8,
        },
        title: {
          color: 'var(--emr-text-primary)',
          fontWeight: 'var(--emr-font-semibold)',
          fontSize: 'var(--emr-font-base)',
        },
        description: {
          color: 'var(--emr-text-secondary)',
          fontSize: 'var(--emr-font-sm)',
        },
        closeButton: {
          color: 'var(--emr-text-secondary)',
          '&:hover': {
            backgroundColor: 'var(--emr-bg-hover)',
          },
        },
      },
    });
  },

  /**
   * Show a success toast
   */
  success: (options: string | Omit<EMRToastOptions, 'variant'>): string => {
    const opts = typeof options === 'string' ? { message: options } : options;
    return EMRToast.show({ ...opts, variant: 'success' });
  },

  /**
   * Show an error toast
   */
  error: (options: string | Omit<EMRToastOptions, 'variant'>): string => {
    const opts = typeof options === 'string' ? { message: options } : options;
    // Errors should stay longer by default
    return EMRToast.show({ autoClose: 8000, ...opts, variant: 'error' });
  },

  /**
   * Show a warning toast
   */
  warning: (options: string | Omit<EMRToastOptions, 'variant'>): string => {
    const opts = typeof options === 'string' ? { message: options } : options;
    return EMRToast.show({ ...opts, variant: 'warning' });
  },

  /**
   * Show an info toast
   */
  info: (options: string | Omit<EMRToastOptions, 'variant'>): string => {
    const opts = typeof options === 'string' ? { message: options } : options;
    return EMRToast.show({ ...opts, variant: 'info' });
  },

  /**
   * Show a loading toast
   */
  loading: (
    message: string,
    options?: Omit<EMRToastOptions, 'message' | 'variant' | 'loading'>
  ): string => {
    return EMRToast.show({
      ...options,
      message,
      variant: 'info',
      loading: true,
    });
  },

  /**
   * Update an existing toast
   */
  update: (id: string, options: Omit<EMRToastOptions, 'id'>): void => {
    const {
      title,
      message,
      variant = 'info',
      icon,
      autoClose = 5000,
      withCloseButton = true,
      onClose,
      loading = false,
    } = options;

    const IconComponent = icon || variantIcons[variant];
    const color = variantColors[variant];

    notifications.update({
      id,
      title,
      message,
      color,
      icon: loading ? undefined : <IconComponent size={20} stroke={2} />,
      loading,
      autoClose: loading ? false : autoClose,
      withCloseButton,
      onClose,
      styles: {
        root: {
          backgroundColor: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-border-default)',
          borderRadius: 12,
          boxShadow: 'var(--emr-shadow-lg)',
          padding: '12px 16px',
        },
        icon: {
          backgroundColor: variantBgColors[variant],
          borderRadius: 8,
          padding: 8,
        },
        title: {
          color: 'var(--emr-text-primary)',
          fontWeight: 'var(--emr-font-semibold)',
          fontSize: 'var(--emr-font-base)',
        },
        description: {
          color: 'var(--emr-text-secondary)',
          fontSize: 'var(--emr-font-sm)',
        },
        closeButton: {
          color: 'var(--emr-text-secondary)',
          '&:hover': {
            backgroundColor: 'var(--emr-bg-hover)',
          },
        },
      },
    });
  },

  /**
   * Hide a specific toast by ID
   */
  hide: (id: string): void => {
    notifications.hide(id);
  },

  /**
   * Hide all toasts
   */
  hideAll: (): void => {
    notifications.clean();
  },

  /**
   * Update loading toast to success
   */
  updateToSuccess: (id: string, message: string, title?: string): void => {
    EMRToast.update(id, { message, title, variant: 'success', loading: false });
  },

  /**
   * Update loading toast to error
   */
  updateToError: (id: string, message: string, title?: string): void => {
    EMRToast.update(id, { message, title, variant: 'error', loading: false });
  },
};

export default EMRToast;
