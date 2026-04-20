// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React, { useId, forwardRef, memo, useCallback, useMemo } from 'react';
import type { ComboboxData, ComboboxItem } from '@mantine/core';
import { Select, Text } from '@mantine/core';
import type { EMRSelectProps, EMRSelectOption } from './EMRFieldTypes';
import { EMRFieldWrapper } from './EMRFieldWrapper';
import { useTranslation } from '../../../contexts/TranslationContext';
import './emr-fields.css';

/**
 * Custom render function for dropdown options
 * Uses explicit inline styles to ensure text is ALWAYS visible
 * @param root0
 * @param root0.option
 */
function renderSelectOption({ option }: { option: ComboboxItem }): React.ReactNode {
  return (
    <Text
      size="sm"
      style={{
        color: 'var(--emr-text-primary)',
        fontWeight: 'var(--emr-font-normal)',
      }}
    >
      {option.label}
    </Text>
  );
}

// Simple option type
type SimpleOption = { value: string; label: string; disabled?: boolean };
type GroupedOption = { group: string; items: SimpleOption[] };

/**
 * Convert EMRSelectOption[] or string[] to Mantine ComboboxData format
 * @param data
 */
function normalizeOptions(data: EMRSelectOption[] | string[]): ComboboxData {
  if (data.length === 0) {return [];}

  // Check if it's string array
  if (typeof data[0] === 'string') {
    return (data as string[]).map((item) => ({ value: item, label: item }));
  }

  // It's EMRSelectOption[]
  const options = data as EMRSelectOption[];

  // Group options if they have group property
  const hasGroups = options.some((opt) => opt.group);

  if (hasGroups) {
    const groups: Record<string, SimpleOption[]> = {};
    const ungrouped: SimpleOption[] = [];

    options.forEach((opt) => {
      const item: SimpleOption = { value: opt.value, label: opt.label, disabled: opt.disabled };
      if (opt.group) {
        if (!groups[opt.group]) {
          groups[opt.group] = [];
        }
        groups[opt.group].push(item);
      } else {
        ungrouped.push(item);
      }
    });

    const result: (SimpleOption | GroupedOption)[] = [...ungrouped];

    // Add grouped items
    Object.entries(groups).forEach(([group, items]) => {
      result.push({ group, items });
    });

    return result;
  }

  // No groups, just return options
  return options.map((opt) => ({
    value: opt.value,
    label: opt.label,
    disabled: opt.disabled,
  }));
}

/**
 * EMRSelect component
 * A production-ready dropdown select with consistent styling
 */
export const EMRSelect = memo(forwardRef<HTMLInputElement, EMRSelectProps>(
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
      rightSection,
      className = '',
      style,
      'data-testid': dataTestId,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedBy,
      clearable = true,
      fullWidth = true,

      // Select specific props
      data,
      value,
      defaultValue,
      onChange,
      onBlur,
      searchable = false,
      nothingFoundMessage,
      maxDropdownHeight,
      allowDeselect = true,
      checkIconPosition = 'right',
      dropdownPosition = 'flip',
      filter,
      renderOption: customRenderOption,
      onSearchChange,
    },
    ref
  ): React.JSX.Element => {
    const generatedId = useId();
    const inputId = id || generatedId;
    const { t } = useTranslation();
    const finalNothingFoundMessage = nothingFoundMessage || t('common.noOptionsFound');

    // Use description if provided, otherwise use helpText
    const helpTextValue = description || helpText;

    // Normalize options to Mantine format
    const normalizedData = useMemo(() => normalizeOptions(data), [data]);

    // Set very generous height to avoid clipping - CSS will handle final constraints
    // Mantine defaults to 250px which clips Georgian text
    const calculatedDropdownHeight = maxDropdownHeight ?? 600;

    // Handle change event
    const handleChange = useCallback(
      (newValue: string | null) => {
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

    // Build aria-describedby: link to the wrapper's error/message element
    const hasMessage = (state === 'error' && typeof error === 'string') ||
      (state === 'success' && !!successMessage) ||
      (state === 'warning' && !!warningMessage) ||
      (state === 'default' && !!helpTextValue);
    const messageElementId = hasMessage ? `${inputId}-${state === 'default' ? 'help' : state}` : undefined;
    const computedAriaDescribedBy = ariaDescribedBy || messageElementId;

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
      'emr-select-input',
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
        fieldId={inputId}
      >
        <Select
          ref={ref}
          id={inputId}
          name={name}
          data={normalizedData}
          value={value}
          defaultValue={defaultValue}
          onChange={handleChange}
          onBlur={onBlur}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          searchable={searchable}
          nothingFoundMessage={finalNothingFoundMessage}
          maxDropdownHeight={calculatedDropdownHeight}
          clearable={clearable}
          allowDeselect={allowDeselect}
          checkIconPosition={checkIconPosition}
          required={required}
          aria-label={ariaLabel}
          aria-describedby={computedAriaDescribedBy}
          aria-invalid={state === 'error'}
          data-testid={dataTestId}
          leftSection={leftSection}
          rightSection={rightSection}
          error={!!error}
          filter={filter as Parameters<typeof Select>[0]['filter']}
          onSearchChange={onSearchChange}
          renderOption={customRenderOption || renderSelectOption}
          comboboxProps={{
            offset: 8,
            shadow: 'md',
            withinPortal: true,
            zIndex: 10000,
            position: 'bottom-start',
            middlewares: { flip: true, shift: true },
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

EMRSelect.displayName = 'EMRSelect';

export default EMRSelect;
