// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Group } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import type { EMRFormActionsProps } from './EMRFieldTypes';
import { EMRButton } from '../../common/EMRButton';
import { useTranslation } from '../../../contexts/TranslationContext';
import './emr-fields.css';

/**
 * EMRFormActions component
 * Provides consistent submit/cancel button layout
 * @param root0
 * @param root0.submitLabel
 * @param root0.cancelLabel
 * @param root0.onSubmit
 * @param root0.onCancel
 * @param root0.loading
 * @param root0.disabled
 * @param root0.align
 * @param root0.showCancel
 * @param root0.additionalActions
 * @param root0.className
 * @param root0.style
 */
export function EMRFormActions({
  submitLabel,
  cancelLabel,
  onSubmit,
  onCancel,
  loading = false,
  disabled = false,
  align = 'right',
  showCancel = true,
  additionalActions,
  className = '',
  style,
}: EMRFormActionsProps): React.JSX.Element {
  const { t } = useTranslation();
  const resolvedSubmitLabel = submitLabel || t('common.save');
  const resolvedCancelLabel = cancelLabel || t('common.cancel');

  // Build container classes
  const containerClasses = [
    'emr-form-actions',
    `align-${align}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClasses} style={style}>
      {/* Cancel button on left when space-between */}
      {align === 'space-between' && showCancel && onCancel && (
        <EMRButton
          variant="secondary"
          onClick={onCancel}
          disabled={loading}
          icon={IconX}
        >
          {resolvedCancelLabel}
        </EMRButton>
      )}

      {/* Additional actions in the middle */}
      {additionalActions}

      {/* Primary actions group */}
      <Group gap="sm" className="emr-form-actions-primary">
        {/* Cancel button (when not space-between) */}
        {align !== 'space-between' && showCancel && onCancel && (
          <EMRButton
            variant="secondary"
            onClick={onCancel}
            disabled={loading}
            icon={IconX}
          >
            {resolvedCancelLabel}
          </EMRButton>
        )}

        {/* Submit button */}
        {onSubmit && (
          <EMRButton
            variant="primary"
            onClick={onSubmit}
            loading={loading}
            disabled={disabled}
            icon={IconCheck}
          >
            {resolvedSubmitLabel}
          </EMRButton>
        )}
      </Group>
    </div>
  );
}

export default EMRFormActions;
