// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Alert } from '@mantine/core';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
} from '@tabler/icons-react';
import type { ComponentType, ReactNode } from 'react';
import './EMRAlert.css';

/** Icon props type for Tabler icons */
interface IconProps {
  size?: number | string;
  stroke?: number;
}

/** Alert variant options */
export type EMRAlertVariant = 'error' | 'warning' | 'success' | 'info';

/**
 * Props for EMRAlert component
 */
export interface EMRAlertProps {
  /** The alert message content */
  children: ReactNode;
  /** Visual variant: error (red), warning (orange), success (green), info (blue) */
  variant?: EMRAlertVariant;
  /** Alert title (optional) */
  title?: string;
  /** Custom icon (overrides variant default) */
  icon?: ComponentType<IconProps>;
  /** Show close button */
  withCloseButton?: boolean;
  /** Callback when close button is clicked */
  onClose?: () => void;
  /** Test ID for testing */
  'data-testid'?: string;
}

/** Default icons for each variant */
const defaultIcons: Record<EMRAlertVariant, ComponentType<IconProps>> = {
  error: IconAlertCircle,
  warning: IconAlertTriangle,
  success: IconCircleCheck,
  info: IconInfoCircle,
};

/**
 * EMRAlert - Standardized alert component with consistent styling
 *
 * Features:
 * - Four variants with appropriate icons and colors
 * - Theme-aware colors via CSS variables
 * - Optional title and close button
 * - Dark mode support
 *
 * @param root0
 * @param root0.children
 * @param root0.variant
 * @param root0.title
 * @param root0.icon
 * @param root0.withCloseButton
 * @param root0.onClose
 * @param root0.'data-testid'
 * @example
 * ```tsx
 * // Error alert with close button
 * <EMRAlert variant="error" withCloseButton onClose={handleClose}>
 *   File upload failed. Please try again.
 * </EMRAlert>
 *
 * // Success alert with title
 * <EMRAlert variant="success" title="Upload Complete">
 *   Your file has been uploaded successfully.
 * </EMRAlert>
 *
 * // Warning alert
 * <EMRAlert variant="warning">
 *   This action cannot be undone.
 * </EMRAlert>
 *
 * // Info alert
 * <EMRAlert variant="info">
 *   Tip: You can drag and drop files here.
 * </EMRAlert>
 * ```
 */
export function EMRAlert({
  children,
  variant = 'info',
  title,
  icon,
  withCloseButton = false,
  onClose,
  'data-testid': testId,
}: EMRAlertProps): React.ReactElement {
  const IconComponent = icon || defaultIcons[variant];

  return (
    <Alert
      icon={<IconComponent size={16} />}
      title={title}
      withCloseButton={withCloseButton}
      onClose={onClose}
      closeButtonLabel="Close"
      className={`emr-alert emr-alert-${variant}`}
      data-testid={testId}
      styles={{
        root: {
          borderRadius: 'var(--emr-border-radius-lg)',
        },
        icon: {
          marginRight: '12px',
        },
        title: {
          fontWeight: 'var(--emr-font-semibold)',
          fontSize: 'var(--emr-font-sm)',
        },
        message: {
          fontSize: 'var(--emr-font-sm)',
        },
        closeButton: {
          color: 'inherit',
          '&:hover': {
            background: 'var(--emr-black-alpha-05)',
          },
        },
      }}
    >
      {children}
    </Alert>
  );
}

export default EMRAlert;
