// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React, { useId, forwardRef, memo, useCallback } from 'react';
import { Radio, Group, Stack } from '@mantine/core';
import type { EMRRadioGroupProps, EMRInputSize } from './EMRFieldTypes';
import { EMRFieldWrapper } from './EMRFieldWrapper';
import './emr-fields.css';

/**
 * EMRRadioGroup component
 * A production-ready radio group with consistent styling
 */
export const EMRRadioGroup = memo(forwardRef<HTMLDivElement, EMRRadioGroupProps>(
  (
    {
      // Field wrapper props
      id,
      name,
      label,
      helpText,
      error,
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

      // RadioGroup specific props
      options,
      value,
      defaultValue,
      onChange,
      orientation = 'vertical',
      spacing = 'sm',
      color,
    },
    ref
  ): React.JSX.Element => {
    const generatedId = useId();
    const groupId = id || generatedId;

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
      return 'default';
    };

    const state = getValidationState();
    const hasError = state === 'error';

    // Spacing values
    const spacingValues: Record<EMRInputSize, number> = {
      xs: 6,
      sm: 8,
      md: 12,
      lg: 16,
      xl: 20,
    };

    // Render options
    const renderOptions = () => {
      return options.map((option) => (
        <Radio
          key={option.value}
          value={option.value}
          label={option.label}
          description={option.description}
          disabled={disabled || readOnly || option.disabled}
          styles={{
            root: {
              width: orientation === 'vertical' ? '100%' : 'auto',
            },
            radio: {
              cursor: disabled || option.disabled ? 'not-allowed' : 'pointer',
              borderColor: hasError ? 'var(--emr-input-error-border)' : 'var(--emr-input-border)',
              transition: 'var(--emr-input-transition)',
              '&:checked': {
                backgroundColor: color || 'var(--emr-secondary)',
                borderColor: color || 'var(--emr-secondary)',
              },
              '&:focus': {
                boxShadow: hasError
                  ? 'var(--emr-input-error-glow)'
                  : 'var(--emr-input-focus-ring)',
              },
            },
            label: {
              fontSize: 'var(--emr-input-font-size)',
              color: 'var(--emr-input-text)',
              fontWeight: 'normal',
              cursor: disabled || option.disabled ? 'not-allowed' : 'pointer',
            },
            description: {
              fontSize: 'var(--emr-input-help-size)',
              color: 'var(--emr-input-help-color)',
            },
          }}
        />
      ));
    };

    // Container component based on orientation
    const Container = orientation === 'horizontal' ? Group : Stack;

    return (
      <EMRFieldWrapper
        label={label}
        required={required}
        helpText={helpText}
        error={error}
        validationState={validationState}
        size={size}
        fullWidth={fullWidth}
        className={className}
        style={style}
        htmlFor={groupId}
      >
        <Radio.Group
          ref={ref}
          id={groupId}
          name={name || groupId}
          value={value}
          defaultValue={defaultValue}
          onChange={handleChange}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={hasError}
          data-testid={dataTestId}
        >
          <Container gap={spacingValues[spacing]}>
            {renderOptions()}
          </Container>
        </Radio.Group>
      </EMRFieldWrapper>
    );
  }
));

EMRRadioGroup.displayName = 'EMRRadioGroup';

export default EMRRadioGroup;
