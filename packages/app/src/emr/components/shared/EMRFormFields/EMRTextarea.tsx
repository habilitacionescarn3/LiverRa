// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React, { useId, forwardRef, memo, useCallback } from 'react';
import { Textarea } from '@mantine/core';
import type { EMRTextareaProps } from './EMRFieldTypes';
import { EMRFieldWrapper } from './EMRFieldWrapper';
import './emr-fields.css';

/**
 * EMRTextarea component
 * A production-ready textarea with consistent styling
 */
export const EMRTextarea = memo(forwardRef<HTMLTextAreaElement, EMRTextareaProps>(
  (
    {
      // Field wrapper props
      id,
      name,
      label,
      placeholder,
      helpText,
      error,
      successMessage,
      warningMessage,
      size = 'md',
      required,
      disabled,
      readOnly,
      validationState,
      className = '',
      style,
      'data-testid': dataTestId,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedBy,
      fullWidth = true,

      // Textarea specific props
      value,
      defaultValue,
      onChange,
      onChangeEvent,
      onBlur,
      onFocus,
      rows = 4,
      minRows,
      maxRows,
      autosize = false,
      maxLength,
      showCount = false,
      resize = 'vertical',
    },
    ref
  ): React.JSX.Element => {
    const generatedId = useId();
    const inputId = id || generatedId;

    // Handle change event
    const handleChange = useCallback(
      (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (onChangeEvent) {
          onChangeEvent(event);
        }
        if (onChange) {
          onChange(event.target.value);
        }
      },
      [onChange, onChangeEvent]
    );

    // Determine validation state
    const getValidationState = () => {
      if (validationState) {return validationState;}
      if (error) {return 'error';}
      if (successMessage) {return 'success';}
      if (warningMessage) {return 'warning';}
      return 'default';
    };

    const state = getValidationState();

    // Build aria-describedby: link to the wrapper's error/message element
    const hasMessage = (state === 'error' && typeof error === 'string') ||
      (state === 'success' && !!successMessage) ||
      (state === 'warning' && !!warningMessage) ||
      (state === 'default' && !!helpText);
    const messageElementId = hasMessage ? `${inputId}-${state === 'default' ? 'help' : state}` : undefined;
    const computedAriaDescribedBy = ariaDescribedBy || messageElementId;

    // Build input classes
    const inputClasses = [
      'emr-input',
      'emr-textarea',
      `size-${size}`,
      state === 'error' && 'has-error',
      state === 'success' && 'has-success',
      state === 'warning' && 'has-warning',
      resize === 'none' && 'no-resize',
    ]
      .filter(Boolean)
      .join(' ');

    // Character count
    const currentLength = value?.length || 0;
    const isAtLimit = maxLength && currentLength === maxLength;
    const isOverLimit = maxLength && currentLength > maxLength;

    // Count class
    const countClass = [
      'emr-textarea-counter',
      isAtLimit && 'at-limit',
      isOverLimit && 'over-limit',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <EMRFieldWrapper
        label={label}
        required={required}
        helpText={helpText}
        error={error}
        successMessage={successMessage}
        warningMessage={warningMessage}
        validationState={validationState}
        size={size}
        fullWidth={fullWidth}
        className={className}
        style={style}
        htmlFor={inputId}
        fieldId={inputId}
      >
        <Textarea
          ref={ref}
          id={inputId}
          name={name}
          value={value}
          defaultValue={defaultValue}
          onChange={handleChange}
          onBlur={onBlur}
          onFocus={onFocus}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          rows={rows}
          minRows={autosize ? minRows : undefined}
          maxRows={autosize ? maxRows : undefined}
          autosize={autosize}
          maxLength={maxLength}
          required={required}
          aria-label={ariaLabel}
          aria-describedby={computedAriaDescribedBy}
          aria-invalid={state === 'error'}
          data-testid={dataTestId}
          error={!!error}
          classNames={{
            input: inputClasses,
          }}
          styles={{
            input: {
              fontSize: 'var(--emr-input-font-size)',
              borderColor: state === 'error'
                ? 'var(--emr-input-error-border)'
                : state === 'success'
                ? 'var(--emr-input-success-border)'
                : state === 'warning'
                ? 'var(--emr-input-warning-border)'
                : 'var(--emr-input-border)',
              borderRadius: 'var(--emr-input-border-radius)',
              transition: 'var(--emr-input-transition)',
              resize: resize,
              '&:focus': {
                borderColor: state === 'error'
                  ? 'var(--emr-input-error-border)'
                  : 'var(--emr-input-border-focus)',
                boxShadow: state === 'error'
                  ? 'var(--emr-input-error-glow)'
                  : state === 'success'
                  ? 'var(--emr-input-success-glow)'
                  : state === 'warning'
                  ? 'var(--emr-input-warning-glow)'
                  : 'var(--emr-input-focus-ring)',
              },
              '&:hover:not(:disabled):not(:focus)': {
                borderColor: state === 'error'
                  ? 'var(--emr-input-error-border)'
                  : 'var(--emr-input-border-hover)',
              },
            },
            wrapper: {
              width: fullWidth ? '100%' : undefined,
            },
          }}
        />
        {showCount && maxLength && (
          <div className={countClass}>
            {currentLength}/{maxLength}
          </div>
        )}
      </EMRFieldWrapper>
    );
  }
));

EMRTextarea.displayName = 'EMRTextarea';

export default EMRTextarea;
