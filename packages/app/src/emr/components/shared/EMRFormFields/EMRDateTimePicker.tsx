// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRDateTimePicker — Date + Time picker using the custom EMRCalendar
 *
 * Same Apple-inspired architecture as EMRDatePicker (common/EMRDatePicker.tsx):
 * custom input trigger + EMRCalendar popover + a time input row below the calendar.
 *
 * Used where the user needs to pick a specific moment (e.g. order time,
 * appointment start, medication administration time).
 */

import React, { forwardRef, memo, useState, useEffect, useCallback } from 'react';
import { Box, Popover, Text, Group } from '@mantine/core';
import { IconCalendarClock, IconX, IconClock } from '@tabler/icons-react';
import { EMRCalendar } from './calendar/EMRCalendar';
import { formatDate } from './calendar/calendar.utils';

export interface EMRDateTimePickerProps {
  /** Custom label */
  label?: string;
  /** Whether field is required */
  required?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Error message */
  error?: string | boolean | null;
  /** Current value */
  value?: Date | null;
  /** Change handler */
  onChange?: (date: Date | null) => void;
  /** Minimum selectable date */
  minDate?: Date;
  /** Maximum selectable date */
  maxDate?: Date;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Disabled state */
  disabled?: boolean;
  /** Whether the input is clearable */
  clearable?: boolean;
  /** Description text shown below the label */
  description?: string;
  /** Date format string (ignored — uses internal formatting) */
  valueFormat?: string;
  /** Container style */
  style?: React.CSSProperties;
  /** Left section (ignored — built-in icon) */
  leftSection?: React.ReactNode;
  /** Test ID */
  'data-testid'?: string;
  /** Full width */
  fullWidth?: boolean;
  /** Help text */
  helpText?: string;
  /** Name for form submission */
  name?: string;
}

/** Format a Date as "dd.mm.yyyy  HH:MM" for display */
function formatDateTime(date: Date | null | undefined): string {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    return '';
  }
  const datePart = formatDate(date);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${datePart}  ${hours}:${minutes}`;
}

export const EMRDateTimePicker = memo(forwardRef<HTMLInputElement, EMRDateTimePickerProps>(
  (
    {
      label,
      required,
      placeholder = 'dd.mm.yyyy  HH:MM',
      error,
      value,
      onChange,
      minDate = new Date(1900, 0, 1),
      maxDate = new Date(new Date().getFullYear() + 10, 11, 31),
      size = 'sm',
      disabled = false,
      description,
      style,
      'data-testid': dataTestId,
    },
    ref
  ) => {
    const [opened, setOpened] = useState(false);
    const [displayValue, setDisplayValue] = useState(() => formatDateTime(value));
    const [isHovered, setIsHovered] = useState(false);

    // Time state (hours and minutes as strings for the inputs)
    const [hours, setHours] = useState(() =>
      value ? String(value.getHours()).padStart(2, '0') : ''
    );
    const [minutes, setMinutes] = useState(() =>
      value ? String(value.getMinutes()).padStart(2, '0') : ''
    );

    // Size configurations (matches EMRDatePicker)
    const sizeConfig = {
      sm: { height: 36, fontSize: 'var(--emr-font-base)', iconSize: 14, padding: '0 10px' },
      md: { height: 42, fontSize: 'var(--emr-font-md)', iconSize: 16, padding: '0 14px' },
      lg: { height: 48, fontSize: 'var(--emr-font-lg)', iconSize: 18, padding: '0 16px' },
    };
    const config = sizeConfig[size];

    // Sync when value prop changes externally
    useEffect(() => {
      setDisplayValue(formatDateTime(value));
      if (value && value instanceof Date && !isNaN(value.getTime())) {
        setHours(String(value.getHours()).padStart(2, '0'));
        setMinutes(String(value.getMinutes()).padStart(2, '0'));
      }
    }, [value]);

    /** When a day is clicked in the calendar, merge with current time */
    const handleDateChange = useCallback((date: Date | null) => {
      if (date) {
        const h = hours ? parseInt(hours, 10) : 0;
        const m = minutes ? parseInt(minutes, 10) : 0;
        const merged = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
        setDisplayValue(formatDateTime(merged));
        onChange?.(merged);
        // Don't close — let the user adjust time if needed
      }
    }, [hours, minutes, onChange]);

    /** When time inputs change, merge with current date */
    const handleTimeChange = useCallback((newHours: string, newMinutes: string) => {
      const h = parseInt(newHours, 10) || 0;
      const m = parseInt(newMinutes, 10) || 0;
      if (value && value instanceof Date && !isNaN(value.getTime())) {
        const merged = new Date(value.getFullYear(), value.getMonth(), value.getDate(), h, m);
        setDisplayValue(formatDateTime(merged));
        onChange?.(merged);
      }
    }, [value, onChange]);

    const handleHoursChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value.replace(/\D/g, '').slice(0, 2);
      const num = parseInt(val, 10);
      if (val === '' || (num >= 0 && num <= 23)) {
        setHours(val);
        if (val.length === 2) {
          handleTimeChange(val, minutes);
        }
      }
    }, [minutes, handleTimeChange]);

    const handleMinutesChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value.replace(/\D/g, '').slice(0, 2);
      const num = parseInt(val, 10);
      if (val === '' || (num >= 0 && num <= 59)) {
        setMinutes(val);
        if (val.length === 2) {
          handleTimeChange(hours, val);
        }
      }
    }, [hours, handleTimeChange]);

    const handleClear = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      setDisplayValue('');
      setHours('');
      setMinutes('');
      onChange?.(null);
    }, [onChange]);

    /** Close and finalize */
    const handleDone = useCallback(() => {
      setOpened(false);
      // Ensure time is committed on close
      if (value && hours && minutes) {
        handleTimeChange(hours, minutes);
      }
    }, [value, hours, minutes, handleTimeChange]);

    const hasError = !!error;
    const hasValue = !!displayValue;
    const errorText = typeof error === 'string' ? error : undefined;

    return (
      <Box style={{ width: '100%', minWidth: 0, maxWidth: '100%', ...style }} data-testid={dataTestId}>
        {/* Label */}
        {label && (
          <Text
            component="label"
            size="sm"
            fw={600}
            c="var(--emr-text-primary)"
            mb={4}
            style={{ display: 'block' }}
          >
            {label}
            {required && (
              <Text component="span" c="var(--emr-error)" ml={4}>*</Text>
            )}
          </Text>
        )}

        {/* Description */}
        {description && (
          <Text size="xs" c="var(--emr-text-secondary)" mb={6} style={{ lineHeight: 1.4 }}>
            {description}
          </Text>
        )}

        <Popover
          opened={opened && !disabled}
          onChange={setOpened}
          position="bottom-start"
          shadow="lg"
          withinPortal
          radius={12}
          zIndex={10001}
        >
          <Popover.Target>
            <Box
              ref={ref as React.Ref<HTMLDivElement>}
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
                background: disabled ? 'var(--emr-bg-page)' : 'var(--emr-bg-card)',
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
              {/* Calendar-Clock Icon */}
              <Box
                style={{
                  width: config.iconSize + 10,
                  height: config.iconSize + 10,
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
                <IconCalendarClock
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
                {displayValue || placeholder}
              </Text>

              {/* Clear Button */}
              {hasValue && !disabled && (
                <Box
                  onClick={handleClear}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    background: 'var(--emr-bg-card)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    marginLeft: 8,
                    flexShrink: 0,
                  }}
                >
                  <IconX size={12} strokeWidth={2.5} color="var(--emr-error)" />
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
              overflow: 'hidden',
            }}
          >
            {/* Calendar */}
            <EMRCalendar
              value={value}
              onChange={handleDateChange}
              minDate={minDate}
              maxDate={maxDate}
            />

            {/* Time Input Row */}
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px 12px',
                borderTop: '1px solid var(--emr-border-color)',
                background: 'var(--emr-bg-card)',
              }}
            >
              <Box
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: 'var(--emr-bg-hover)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <IconClock size={14} color="var(--emr-text-secondary)" />
              </Box>
              <Text size="xs" fw={600} c="var(--emr-text-secondary)" style={{ flexShrink: 0 }}>
                Time
              </Text>
              <Group gap={4} style={{ flex: 1, justifyContent: 'flex-end' }}>
                <input
                  type="text"
                  inputMode="numeric"
                  value={hours}
                  onChange={handleHoursChange}
                  placeholder="HH"
                  maxLength={2}
                  style={{
                    width: 36,
                    height: 30,
                    borderRadius: 8,
                    border: '1.5px solid var(--emr-border-color)',
                    background: 'var(--emr-bg-page)',
                    textAlign: 'center',
                    fontSize: 'var(--emr-font-sm)',
                    fontWeight: 600,
                    color: 'var(--emr-text-primary)',
                    outline: 'none',
                    transition: 'border-color 0.15s ease',
                  }}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--emr-primary)'; }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--emr-border-color)';
                    // Pad on blur
                    if (hours && hours.length === 1) setHours(hours.padStart(2, '0'));
                  }}
                />
                <Text fw={700} c="var(--emr-text-secondary)" size="sm">:</Text>
                <input
                  type="text"
                  inputMode="numeric"
                  value={minutes}
                  onChange={handleMinutesChange}
                  placeholder="MM"
                  maxLength={2}
                  style={{
                    width: 36,
                    height: 30,
                    borderRadius: 8,
                    border: '1.5px solid var(--emr-border-color)',
                    background: 'var(--emr-bg-page)',
                    textAlign: 'center',
                    fontSize: 'var(--emr-font-sm)',
                    fontWeight: 600,
                    color: 'var(--emr-text-primary)',
                    outline: 'none',
                    transition: 'border-color 0.15s ease',
                  }}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--emr-primary)'; }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--emr-border-color)';
                    if (minutes && minutes.length === 1) setMinutes(minutes.padStart(2, '0'));
                  }}
                />
              </Group>

              {/* Done button */}
              <Box
                onClick={handleDone}
                style={{
                  padding: '4px 12px',
                  borderRadius: 8,
                  background: 'linear-gradient(135deg, var(--emr-primary) 0%, var(--emr-secondary) 100%)',
                  color: 'var(--emr-text-inverse)',
                  fontSize: 'var(--emr-font-xs)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  flexShrink: 0,
                  transition: 'opacity 0.15s ease',
                  userSelect: 'none',
                }}
              >
                OK
              </Box>
            </Box>
          </Popover.Dropdown>
        </Popover>

        {/* Error Message */}
        {hasError && errorText && (
          <Group gap={6} mt={6}>
            <Text size="xs" c="var(--emr-error)">{errorText}</Text>
          </Group>
        )}
      </Box>
    );
  }
));

EMRDateTimePicker.displayName = 'EMRDateTimePicker';
