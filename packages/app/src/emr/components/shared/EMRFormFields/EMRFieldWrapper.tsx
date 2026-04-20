// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { IconAlertCircle, IconCheck, IconAlertTriangle } from '@tabler/icons-react';
import type { EMRFieldWrapperProps, EMRValidationState } from './EMRFieldTypes';
import './emr-fields.css';

/**
 * Validation state input
 */
interface ValidationInput {
  error?: string | boolean;
  successMessage?: string;
  warningMessage?: string;
  validationState?: EMRValidationState;
  helpText?: string;
}

/**
 * Determine validation state from props
 * @param props
 */
function getValidationState(props: ValidationInput): EMRValidationState {
  if (props.validationState) {
    return props.validationState;
  }
  if (props.error) {
    return 'error';
  }
  if (props.successMessage) {
    return 'success';
  }
  if (props.warningMessage) {
    return 'warning';
  }
  return 'default';
}

/**
 * Get validation message based on state
 * @param props
 */
function getValidationMessage(props: ValidationInput): string | undefined {
  const state = getValidationState(props);
  switch (state) {
    case 'error':
      return typeof props.error === 'string' ? props.error : undefined;
    case 'success':
      return props.successMessage;
    case 'warning':
      return props.warningMessage;
    default:
      return props.helpText;
  }
}

/**
 * EMRFieldWrapper component
 * Wraps form inputs with consistent label, help text, and validation styling
 * @param root0
 * @param root0.label
 * @param root0.required
 * @param root0.helpText
 * @param root0.error
 * @param root0.successMessage
 * @param root0.warningMessage
 * @param root0.validationState
 * @param root0.size
 * @param root0.fullWidth
 * @param root0.children
 * @param root0.className
 * @param root0.style
 * @param root0.htmlFor
 */
export function EMRFieldWrapper({
  label,
  required,
  helpText,
  error,
  successMessage,
  warningMessage,
  validationState,
  size = 'md',
  fullWidth = true,
  children,
  className = '',
  style,
  htmlFor,
  fieldId,
}: EMRFieldWrapperProps): React.JSX.Element {
  const state = getValidationState({ error, successMessage, warningMessage, validationState });
  const message = getValidationMessage({ helpText, error, successMessage, warningMessage, validationState });

  // Generate accessible IDs for validation messages so inputs can reference them via aria-describedby
  const messageId = fieldId && message ? `${fieldId}-${state === 'default' ? 'help' : state}` : undefined;

  const wrapperClasses = [
    'emr-field-wrapper',
    `size-${size}`,
    fullWidth && 'full-width',
    state === 'error' && 'has-error',
    state === 'success' && 'has-success',
    state === 'warning' && 'has-warning',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperClasses} style={style}>
      {/* Label */}
      {label && (
        <label className="emr-field-label" htmlFor={htmlFor}>
          {label}
          {required && <span className="emr-field-label-required">*</span>}
        </label>
      )}

      {/* Input content */}
      {children}

      {/* Validation message / Help text */}
      {message && state === 'error' && (
        <div id={messageId} className="emr-field-error" role="alert">
          <IconAlertCircle size={14} />
          <span>{message}</span>
        </div>
      )}

      {message && state === 'success' && (
        <div id={messageId} className="emr-field-success">
          <IconCheck size={14} />
          <span>{message}</span>
        </div>
      )}

      {message && state === 'warning' && (
        <div id={messageId} className="emr-field-warning">
          <IconAlertTriangle size={14} />
          <span>{message}</span>
        </div>
      )}

      {message && state === 'default' && (
        <div id={messageId} className="emr-field-help">{message}</div>
      )}
    </div>
  );
}

export default EMRFieldWrapper;
