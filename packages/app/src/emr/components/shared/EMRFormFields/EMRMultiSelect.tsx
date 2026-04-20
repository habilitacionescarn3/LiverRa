// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React, { useId, forwardRef, useCallback, useMemo } from 'react';
import type { ComboboxData } from '@mantine/core';
import { MultiSelect } from '@mantine/core';
import type { EMRMultiSelectProps, EMRSelectOption } from './EMRFieldTypes';
import { EMRFieldWrapper } from './EMRFieldWrapper';
import { useTranslation } from '../../../contexts/TranslationContext';
import './emr-fields.css';

// Simple option type
type SimpleOption = { value: string; label: string; disabled?: boolean };
type GroupedOption = { group: string; items: SimpleOption[] };

// Constants for dropdown sizing
const ITEM_HEIGHT = 40; // Height per dropdown item (includes padding)
const MIN_VISIBLE_ITEMS = 8; // Minimum items to show when dropdown has more items
const DEFAULT_MAX_DROPDOWN_HEIGHT = ITEM_HEIGHT * MIN_VISIBLE_ITEMS; // 320px

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
 * EMRMultiSelect component
 * A production-ready multi-select dropdown with consistent styling
 */
export const EMRMultiSelect = forwardRef<HTMLInputElement, EMRMultiSelectProps>(
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
      clearable = true,
      fullWidth = true,

      // MultiSelect specific props
      data,
      value,
      defaultValue,
      onChange,
      onBlur,
      searchable = true,
      nothingFoundMessage,
      maxDropdownHeight,
      maxValues,
      hidePickedOptions = false,
      dropdownPosition = 'flip',
      filter,
    },
    ref
  ): React.JSX.Element => {
    const generatedId = useId();
    const inputId = id || generatedId;
    const { t } = useTranslation();
    const finalNothingFoundMessage = nothingFoundMessage || t('common.noOptionsFound');

    // Normalize options to Mantine format
    const normalizedData = useMemo(() => normalizeOptions(data), [data]);

    // Calculate optimal dropdown height based on number of items
    // If more than MIN_VISIBLE_ITEMS, show at least MIN_VISIBLE_ITEMS
    // If fewer items, show all of them
    const calculatedDropdownHeight = useMemo(() => {
      if (maxDropdownHeight !== undefined) {
        return maxDropdownHeight; // User override
      }

      const itemCount = data.length;
      if (itemCount <= MIN_VISIBLE_ITEMS) {
        // Show all items - no need to limit height
        return itemCount * ITEM_HEIGHT + 16; // +16 for dropdown padding
      }
      return DEFAULT_MAX_DROPDOWN_HEIGHT;
    }, [data.length, maxDropdownHeight]);

    // Handle change event
    const handleChange = useCallback(
      (newValue: string[]) => {
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
      'emr-multiselect-input',
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
        <MultiSelect
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
          maxValues={maxValues}
          hidePickedOptions={hidePickedOptions}
          required={required}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={state === 'error'}
          data-testid={dataTestId}
          leftSection={leftSection}
          rightSection={rightSection}
          error={!!error}
          comboboxProps={{
            offset: 4,
            shadow: 'md',
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
            option: {
              fontSize: 'var(--emr-input-font-size)',
              padding: '10px 12px',
              borderRadius: 'var(--emr-border-radius-sm)',
            },
          }}
        />
      </EMRFieldWrapper>
    );
  }
);

EMRMultiSelect.displayName = 'EMRMultiSelect';

export default EMRMultiSelect;
