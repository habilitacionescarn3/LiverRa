// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Box, Popover, Text, Group } from '@mantine/core';
import { IconCalendar, IconX } from '@tabler/icons-react';
import { forwardRef, useState, useEffect } from 'react';
import { EMRCalendar } from './calendar/EMRCalendar';
import { formatDate } from './calendar/calendar.utils';

export interface EMRDatePickerProps {
  /** Custom label */
  label?: string;
  /** Whether field is required */
  required?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Error message */
  error?: string;
  /** Current value */
  value?: Date | null;
  /** Change handler */
  onChange?: (date: Date | null) => void;
  /** Minimum selectable date */
  minDate?: Date;
  /** Maximum selectable date */
  maxDate?: Date;
  /** Locale for date formatting */
  locale?: string;
  /** Custom styles to apply (will be merged with defaults) */
  customStyle?: React.CSSProperties;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Disabled state */
  disabled?: boolean;
  /** Whether the input is clearable (always true in new design) */
  clearable?: boolean;
  /** Left section element (ignored in new design - calendar icon is built-in) */
  leftSection?: React.ReactNode;
  /** Container style */
  style?: React.CSSProperties;
  /** Date format string (e.g. 'YYYY-MM-DD') */
  valueFormat?: string;
}

/**
 * Production-Ready EMR Date Picker Component
 *
 * Features:
 * - Beautiful Apple-inspired custom calendar
 * - Multi-level navigation (Day → Month → Year)
 * - Support for dates from 1900 to current year + 10
 * - Smooth animations and transitions
 * - Georgian/English/Russian locale support
 * - Premium styling matching EMR theme
 */
export const EMRDatePicker = forwardRef<HTMLInputElement, EMRDatePickerProps>(
  (
    {
      label,
      required,
      placeholder = 'dd.mm.yyyy',
      error,
      value,
      onChange,
      minDate = new Date(1900, 0, 1),
      maxDate = new Date(new Date().getFullYear() + 10, 11, 31),
      locale = 'en',
      customStyle,
      size = 'md',
      disabled = false,
       
      clearable: _clearable, // Always clearable in new design
       
      leftSection: _leftSection, // Ignored - using built-in calendar icon
      style,
    },
    ref
  ) => {
    const [opened, setOpened] = useState(false);
    const [inputValue, setInputValue] = useState(() => formatDate(value));
    const [isHovered, setIsHovered] = useState(false);

    // Size configurations
    const sizeConfig = {
      sm: { height: 36, fontSize: 'var(--emr-font-base)', iconSize: 16, padding: '0 12px' },
      md: { height: 42, fontSize: 'var(--emr-font-md)', iconSize: 18, padding: '0 14px' },
      lg: { height: 48, fontSize: 'var(--emr-font-lg)', iconSize: 20, padding: '0 16px' },
    };

    const config = sizeConfig[size];

    // Sync input value when value prop changes
    useEffect(() => {
      setInputValue(formatDate(value));
    }, [value]);

    const handleDateChange = (date: Date | null) => {
      if (date) {
        setInputValue(formatDate(date));
        onChange?.(date);
        setOpened(false);
      }
    };

    const handleClear = (e: React.MouseEvent) => {
      e.stopPropagation();
      setInputValue('');
      onChange?.(null);
    };

    const hasError = !!error;
    const hasValue = !!inputValue;

    return (
      <Box style={{ width: customStyle?.width || '100%', minWidth: 0, maxWidth: '100%', ...style }}>
        {/* Label */}
        {label && (
          <Text
            component="label"
            size="sm"
            fw={600}
            c="var(--emr-text-primary)"
            mb={8}
            style={{ display: 'block' }}
          >
            {label}
            {required && (
              <Text component="span" c="var(--emr-error)" ml={4}>
                *
              </Text>
            )}
          </Text>
        )}

        <Popover
          opened={opened && !disabled}
          onChange={setOpened}
          position="bottom-start"
          shadow="lg"
          withinPortal
          radius={12}
          trapFocus
        >
          <Popover.Target>
            <Box
              ref={ref as React.Ref<HTMLDivElement>}
              className="emr-datepicker-container"
              onClick={() => !disabled && setOpened(true)}
              onMouseEnter={() => setIsHovered(true)}
              onMouseLeave={() => setIsHovered(false)}
              style={{
                height: config.height,
                borderRadius: 10,
                border: `2px solid ${
                  hasError
                    ? 'var(--emr-error)'
                    : opened
                    ? 'var(--emr-primary)'
                    : isHovered && !disabled
                    ? 'var(--emr-text-secondary)'
                    : 'var(--emr-border-default)'
                }`,
                background: disabled
                  ? 'var(--emr-bg-page)'
                  : 'var(--emr-bg-card)',
                display: 'flex',
                alignItems: 'center',
                padding: config.padding,
                cursor: disabled ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: opened
                  ? 'var(--emr-shadow-focus)'
                  : isHovered && !disabled
                  ? 'var(--emr-shadow-sm)'
                  : 'var(--emr-shadow-xs)',
                opacity: disabled ? 0.6 : 1,
                overflow: 'hidden',
                minWidth: 0,
                maxWidth: '100%',
              }}
            >
              {/* Calendar Icon */}
              <Box
                style={{
                  width: config.iconSize + 12,
                  height: config.iconSize + 12,
                  borderRadius: 6,
                  background: opened
                    ? 'linear-gradient(135deg, var(--emr-primary) 0%, var(--emr-secondary) 100%)'
                    : 'var(--emr-bg-hover)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 8,
                  flexShrink: 0,
                  transition: 'all 0.2s ease',
                }}
              >
                <IconCalendar
                  size={config.iconSize}
                  strokeWidth={2}
                  color={opened ? 'var(--emr-bg-card)' : 'var(--emr-text-secondary)'}
                />
              </Box>

              {/* Value / Placeholder */}
              <Text
                size={config.fontSize}
                fw={hasValue ? 500 : 400}
                c={hasValue ? 'var(--emr-text-primary)' : 'var(--emr-text-secondary)'}
                style={{
                  flex: 1,
                  letterSpacing: hasValue ? '0.02em' : 'normal',
                  textAlign: 'left',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {inputValue || placeholder}
              </Text>

              {/* Clear Button */}
              {hasValue && !disabled && (
                <Box
                  onClick={handleClear}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 6,
                    background: isHovered ? 'var(--emr-error-light)' : 'var(--emr-bg-card)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    marginLeft: 8,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--emr-error-light)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--emr-bg-card)';
                  }}
                >
                  <IconX size={14} strokeWidth={2.5} color="var(--emr-error)" />
                </Box>
              )}
            </Box>
          </Popover.Target>

          <Popover.Dropdown
            style={{
              padding: 0,
              border: 'none',
              borderRadius: 16,
              boxShadow: 'var(--emr-shadow-xl)',
            }}
          >
            <EMRCalendar
              value={value}
              onChange={handleDateChange}
              minDate={minDate}
              maxDate={maxDate}
              locale={locale}
            />
          </Popover.Dropdown>
        </Popover>

        {/* Error Message */}
        {hasError && (
          <Group gap={6} mt={6}>
            <Text size="xs" c="var(--emr-error)">
              {error}
            </Text>
          </Group>
        )}
      </Box>
    );
  }
);

EMRDatePicker.displayName = 'EMRDatePicker';
