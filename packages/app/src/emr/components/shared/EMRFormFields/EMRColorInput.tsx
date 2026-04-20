// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React, { useId, forwardRef, useCallback } from 'react';
import { ColorInput } from '@mantine/core';
import type { EMRColorInputProps } from './EMRFieldTypes';
import { EMRFieldWrapper } from './EMRFieldWrapper';
import './emr-fields.css';

/**
 * Default color swatches for EMR system
 */
const DEFAULT_SWATCHES = [
  // eslint-disable-next-line liverra/no-hardcoded-color -- user-facing color palette value
  '#1a365d', // Deep blue
  // eslint-disable-next-line liverra/no-hardcoded-color -- user-facing color palette value
  '#2b6cb0', // Primary blue
  // eslint-disable-next-line liverra/no-hardcoded-color -- user-facing color palette value
  '#38a169', // Success green
  // eslint-disable-next-line liverra/no-hardcoded-color -- user-facing color palette value
  '#d69e2e', // Warning yellow
  // eslint-disable-next-line liverra/no-hardcoded-color -- user-facing color palette value
  '#e53e3e', // Error red
  // eslint-disable-next-line liverra/no-hardcoded-color -- user-facing color palette value
  '#805ad5', // Purple
  // eslint-disable-next-line liverra/no-hardcoded-color -- user-facing color palette value
  '#00b5d8', // Cyan
  // eslint-disable-next-line liverra/no-hardcoded-color -- user-facing color palette value
  '#ed64a6', // Pink
];

/**
 * EMRColorInput component
 * A production-ready color picker with consistent styling
 */
export const EMRColorInput = forwardRef<HTMLInputElement, EMRColorInputProps>(
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
      leftSection,
      rightSection,
      className = '',
      style,
      'data-testid': dataTestId,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedBy,
      fullWidth = true,

      // ColorInput specific props
      value,
      defaultValue,
      onChange,
      onBlur,
      format = 'hex',
      swatches = DEFAULT_SWATCHES,
      swatchesPerRow = 8,
      withEyeDropper = true,
      closeOnColorSwatchClick = true,
      disallowInput = false,
    },
    ref
  ): React.JSX.Element => {
    const generatedId = useId();
    const inputId = id || generatedId;

    // Handle change event
    const handleChange = useCallback(
      (newValue: string) => {
        if (onChange) {
          onChange(newValue);
        }
      },
      [onChange]
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

    // Calculate heights based on size
    const heights = {
      xs: 30,
      sm: 36,
      md: 42,
      lg: 48,
      xl: 54,
    };

    // Build input classes
    const inputClasses = [
      'emr-input',
      'emr-color-input',
      `size-${size}`,
      state === 'error' && 'has-error',
      state === 'success' && 'has-success',
      state === 'warning' && 'has-warning',
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
      >
        <ColorInput
          ref={ref}
          id={inputId}
          name={name}
          value={value}
          defaultValue={defaultValue}
          onChange={handleChange}
          onBlur={onBlur}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          format={format}
          swatches={swatches}
          swatchesPerRow={swatchesPerRow}
          withEyeDropper={withEyeDropper}
          closeOnColorSwatchClick={closeOnColorSwatchClick}
          disallowInput={disallowInput}
          required={required}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={state === 'error'}
          data-testid={dataTestId}
          leftSection={leftSection}
          rightSection={rightSection}
          error={!!error}
          classNames={{
            input: inputClasses,
          }}
          styles={{
            input: {
              minHeight: heights[size],
              fontSize: 'var(--emr-input-font-size)',
              borderColor: state === 'error'
                ? 'var(--emr-input-error-border)'
                : state === 'success'
                ? 'var(--emr-input-success-border)'
                : state === 'warning'
                ? 'var(--emr-input-warning-border)'
                : 'var(--emr-input-border)',
              borderRadius: 'var(--emr-input-border-radius)',
              backgroundColor: state === 'error'
                ? 'var(--emr-input-error-bg)'
                : state === 'success'
                ? 'var(--emr-input-success-bg)'
                : state === 'warning'
                ? 'var(--emr-input-warning-bg)'
                : 'var(--emr-input-bg-solid)',
              transition: 'var(--emr-input-transition)',
              cursor: readOnly ? 'default' : 'pointer',
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
              '&:disabled': {
                backgroundColor: 'var(--emr-input-bg-disabled)',
                color: 'var(--emr-input-text-disabled)',
                cursor: 'not-allowed',
              },
            },
            wrapper: {
              width: fullWidth ? '100%' : undefined,
            },
            dropdown: {
              borderRadius: 'var(--emr-input-border-radius)',
              border: '1px solid var(--emr-input-border)',
              boxShadow: 'var(--emr-shadow-md)',
            },
          }}
        />
      </EMRFieldWrapper>
    );
  }
);

EMRColorInput.displayName = 'EMRColorInput';

export default EMRColorInput;
