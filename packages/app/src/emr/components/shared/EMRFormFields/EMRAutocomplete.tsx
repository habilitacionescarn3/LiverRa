// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React, { useId, forwardRef, memo, useCallback, useMemo } from 'react';
import { Autocomplete, Text, Loader } from '@mantine/core';
import type { EMRFieldBaseProps, EMRInputSize } from './EMRFieldTypes';
import { EMRFieldWrapper } from './EMRFieldWrapper';
import './emr-fields.css';

/**
 * Option type for EMRAutocomplete
 */
export interface EMRAutocompleteOption {
  /** Option value (unique identifier) */
  value: string;
  /** Display label */
  label: string;
  /** Whether option is disabled */
  disabled?: boolean;
}

/**
 * EMRAutocomplete specific props
 */
export interface EMRAutocompleteProps extends EMRFieldBaseProps {
  /** Autocomplete options */
  data: EMRAutocompleteOption[] | string[];

  /** Current value */
  value?: string;

  /** Default value (uncontrolled) */
  defaultValue?: string;

  /** Change handler - called on every input change */
  onChange?: (value: string) => void;

  /** Option submit handler - called when an option is selected from dropdown */
  onOptionSubmit?: (value: string) => void;

  /** Blur handler */
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;

  /** Focus handler */
  onFocus?: (event: React.FocusEvent<HTMLInputElement>) => void;

  /** Loading state (shows spinner in right section) */
  loading?: boolean;

  /** Nothing found message */
  nothingFoundMessage?: string;

  /** Maximum dropdown height */
  maxDropdownHeight?: number;

  /** Limit number of options shown */
  limit?: number;

  /** Description text (alias for helpText, for backward compatibility) */
  description?: string;

  /** Width of left section (controls input padding) */
  leftSectionWidth?: number;

  /** Custom styles (for backward compatibility, ignored in new design) */
  styles?: Record<string, unknown>;

  /** Custom filter function. Pass `({ options }) => options` to disable client-side filtering (for server-side search). */
  filter?: (params: { options: Array<{ value: string; label: string }>; search: string }) => Array<{ value: string; label: string }>;
}

/**
 * Custom render function for dropdown options
 * Uses explicit inline styles to ensure text is ALWAYS visible
 */
function renderAutocompleteOption({ option }: { option: { value: string; label?: string } }): React.ReactNode {
  return (
    <Text
      size="sm"
      style={{
        color: 'var(--emr-text-primary)',
        fontWeight: 'var(--emr-font-normal)',
      }}
    >
      {option.label || option.value}
    </Text>
  );
}

/**
 * Convert EMRAutocompleteOption[] or string[] to Mantine format
 */
function normalizeOptions(data: EMRAutocompleteOption[] | string[]): Array<{ value: string; label: string; disabled?: boolean }> {
  if (data.length === 0) {return [];}

  // Check if it's string array
  if (typeof data[0] === 'string') {
    return (data as string[]).map((item) => ({ value: item, label: item }));
  }

  // It's EMRAutocompleteOption[]
  return (data as EMRAutocompleteOption[]).map((opt) => ({
    value: opt.value,
    label: opt.label,
    disabled: opt.disabled,
  }));
}

/**
 * EMRAutocomplete component
 * A production-ready autocomplete input with EMR styling
 * Supports async loading and custom option rendering
 */
export const EMRAutocomplete = memo(forwardRef<HTMLInputElement, EMRAutocompleteProps>(
  (
    {
      // Field wrapper props
      id,
      name,
      label,
      placeholder,
      helpText,
      description,
      error,
      successMessage,
      warningMessage,
      size = 'md',
      required,
      disabled,
      readOnly,
      validationState,
      leftSection,
      leftSectionWidth,
      rightSection,
      className = '',
      style,
      'data-testid': dataTestId,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedBy,
      fullWidth = true,

      // Autocomplete specific props
      data,
      value,
      defaultValue,
      onChange,
      onOptionSubmit,
      onBlur,
      onFocus,
      loading = false,
      nothingFoundMessage,
      maxDropdownHeight,
      limit,
      filter: filterProp,
    },
    ref
  ): React.JSX.Element => {
    const generatedId = useId();
    const inputId = id || generatedId;

    // Use description if provided, otherwise use helpText
    const helpTextValue = description || helpText;

    // Normalize options to Mantine format
    const normalizedData = useMemo(() => normalizeOptions(data), [data]);

    // Set generous height to avoid clipping Georgian text
    const calculatedDropdownHeight = maxDropdownHeight ?? 400;

    // Handle change event
    const handleChange = useCallback(
      (newValue: string) => {
        if (onChange) {
          onChange(newValue);
        }
      },
      [onChange]
    );

    // Handle option submit
    const handleOptionSubmit = useCallback(
      (selectedValue: string) => {
        if (onOptionSubmit) {
          onOptionSubmit(selectedValue);
        }
      },
      [onOptionSubmit]
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
    const heights: Record<EMRInputSize, number> = {
      xs: 30,
      sm: 36,
      md: 42,
      lg: 48,
      xl: 54,
    };

    // Build input classes
    const inputClasses = [
      'emr-input',
      'emr-autocomplete-input',
      `size-${size}`,
      state === 'error' && 'has-error',
      state === 'success' && 'has-success',
      state === 'warning' && 'has-warning',
    ]
      .filter(Boolean)
      .join(' ');

    // Determine right section (loading spinner or custom)
    const effectiveRightSection = loading ? <Loader size={16} /> : rightSection;

    return (
      <EMRFieldWrapper
        label={label}
        required={required}
        helpText={helpTextValue}
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
        <Autocomplete
          ref={ref}
          id={inputId}
          name={name}
          data={normalizedData}
          value={value}
          defaultValue={defaultValue}
          onChange={handleChange}
          onOptionSubmit={handleOptionSubmit}
          onBlur={onBlur}
          onFocus={onFocus}
          placeholder={placeholder}
          disabled={disabled || readOnly}
          maxDropdownHeight={calculatedDropdownHeight}
          limit={limit}
          filter={filterProp as /* any-ok: Mantine's internal filter type varies across subcomponents */ any}
          required={required}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={state === 'error'}
          data-testid={dataTestId}
          leftSection={leftSection}
          leftSectionWidth={leftSectionWidth}
          rightSection={effectiveRightSection}
          error={!!error}
          renderOption={renderAutocompleteOption}
          comboboxProps={{
            offset: 4,
            shadow: 'md',
            withinPortal: true,
            zIndex: 10000,
          }}
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
            option: {
              fontSize: 'var(--emr-input-font-size)',
              padding: '10px 12px',
              borderRadius: 'var(--emr-border-radius-sm)',
              color: 'var(--emr-text-primary)',
            },
          }}
        />
      </EMRFieldWrapper>
    );
  }
));

EMRAutocomplete.displayName = 'EMRAutocomplete';

export default EMRAutocomplete;
