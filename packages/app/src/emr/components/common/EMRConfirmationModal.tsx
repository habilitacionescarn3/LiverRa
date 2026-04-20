// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconTrash,
} from '@tabler/icons-react';
import type { ComponentType, ReactNode } from 'react';
import { EMRModal } from './EMRModal';
import type { EMRModalSize } from './EMRModal';
import { useTranslation } from '../../contexts/TranslationContext';

/** Icon props type for Tabler icons */
interface IconProps {
  size: number;
  color: string;
}

/** Variant options for confirmation modal */
export type EMRConfirmationVariant = 'danger' | 'warning' | 'info' | 'success';

/**
 * Props for EMRConfirmationModal component
 */
export interface EMRConfirmationModalProps {
  /** Modal open state */
  opened: boolean;
  /** Callback to close modal */
  onClose: () => void;
  /** Callback when confirmation is clicked */
  onConfirm: () => Promise<void> | void;
  /** Modal title */
  title: string;
  /** Confirmation message */
  message: string | ReactNode;
  /** Item name to display as subtitle (e.g., what's being deleted) */
  itemName?: string;
  /** Confirm button label (default based on variant) */
  confirmLabel?: string;
  /** Cancel button label (default: "Cancel") */
  cancelLabel?: string;
  /** Visual variant: danger (red), warning (orange), info (blue) */
  variant?: EMRConfirmationVariant;
  /** Custom icon (overrides variant default) */
  icon?: ComponentType<IconProps>;
  /** Loading state during confirmation */
  loading?: boolean;
  /** Modal size (default: sm) */
  size?: EMRModalSize;
  /** Test ID for testing */
  'data-testid'?: string;
}

/** Default icons for each variant */
const defaultIcons: Record<EMRConfirmationVariant, ComponentType<IconProps>> = {
  danger: IconTrash,
  warning: IconAlertTriangle,
  info: IconInfoCircle,
  success: IconCheck,
};

/** Default confirm labels for each variant */
const _defaultConfirmLabels: Record<EMRConfirmationVariant, string> = {
  danger: 'Delete',
  warning: 'Confirm',
  info: 'OK',
  success: 'OK',
};

/**
 * EMRConfirmationModal - Reusable confirmation dialog for deletions and destructive actions
 *
 * Features:
 * - Three variants: danger (delete), warning, info
 * - Appropriate icons and colors for each variant
 * - Loading state during async operations
 * - Wraps EMRModal for consistent styling
 * - Replaces multiple duplicated deletion modals
 *
 * @param root0
 * @param root0.opened
 * @param root0.onClose
 * @param root0.onConfirm
 * @param root0.title
 * @param root0.message
 * @param root0.itemName
 * @param root0.confirmLabel
 * @param root0.cancelLabel
 * @param root0.variant
 * @param root0.icon
 * @param root0.loading
 * @param root0.size
 * @param root0.'data-testid'
 * @example
 * ```tsx
 * // Danger variant for deletion
 * <EMRConfirmationModal
 *   opened={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   onConfirm={handleDelete}
 *   title="Delete Patient"
 *   itemName={patient.name}
 *   message="Are you sure you want to delete this patient? This action cannot be undone."
 *   variant="danger"
 *   loading={isDeleting}
 * />
 *
 * // Warning variant for confirmation
 * <EMRConfirmationModal
 *   opened={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   onConfirm={handleDischarge}
 *   title="Discharge Patient"
 *   message="Are you sure you want to discharge this patient?"
 *   variant="warning"
 * />
 *
 * // Info variant for acknowledgment
 * <EMRConfirmationModal
 *   opened={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   onConfirm={() => setIsOpen(false)}
 *   title="Information"
 *   message="The report has been generated successfully."
 *   variant="info"
 *   confirmLabel="Got it"
 * />
 * ```
 */
export function EMRConfirmationModal({
  opened,
  onClose,
  onConfirm,
  title,
  message,
  itemName,
  confirmLabel,
  cancelLabel,
  variant = 'danger',
  icon,
  loading = false,
  size = 'sm',
  'data-testid': testId,
}: EMRConfirmationModalProps): React.ReactElement {
  const { t } = useTranslation();
  const IconComponent = icon || defaultIcons[variant];
  const translatedConfirmLabels: Record<EMRConfirmationVariant, string> = {
    danger: t('common.delete'),
    warning: t('common.confirm'),
    info: t('common.ok'),
    success: t('common.ok'),
  };
  const finalConfirmLabel = confirmLabel || translatedConfirmLabels[variant];
  const finalCancelLabel = cancelLabel || t('common.cancel');

  const handleConfirm = async (): Promise<void> => {
    await onConfirm();
  };

  return (
    <EMRModal
      opened={opened}
      onClose={onClose}
      size={size}
      icon={IconComponent}
      title={title}
      subtitle={itemName}
      cancelLabel={finalCancelLabel}
      submitLabel={finalConfirmLabel}
      onSubmit={handleConfirm}
      submitLoading={loading}
      testId={testId}
    >
      {typeof message === 'string' ? (
        <Text
          style={{
            fontSize: 'var(--emr-font-base)',
            color: 'var(--emr-text-primary)',
            lineHeight: 'var(--emr-line-height-1-6)',
          }}
        >
          {message}
        </Text>
      ) : (
        message
      )}
    </EMRModal>
  );
}

export default EMRConfirmationModal;
