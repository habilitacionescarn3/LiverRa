// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React, { useId, forwardRef, useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { Box, Text, Group, Popover } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import type { EMRTimeInputProps, EMRInputSize } from './EMRFieldTypes';
import { useTranslation } from '../../../contexts/TranslationContext';
import './emr-fields.css';

/**
 * EMRTimeInput component
 * A premium, production-ready time picker with elegant styling and a custom
 * themed popover (replaces the browser-native time picker so the selected
 * highlight uses the EMR theme colors instead of the OS accent color).
 */
export const EMRTimeInput = forwardRef<HTMLInputElement, EMRTimeInputProps>(
  (
    {
      // Field props
      id,
      name,
      label,
      placeholder = 'HH:MM',
      helpText,
      error,
      size = 'md',
      required,
      disabled,
      readOnly,
      className = '',
      style,
      'data-testid': dataTestId,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedBy,

      // TimeInput specific props
      value,
      defaultValue,
      onChange,
      onBlur,
      withSeconds = false,
    },
    ref
  ): React.JSX.Element => {
    const { t } = useTranslation();
    const generatedId = useId();
    const inputId = id || generatedId;
    const inputRef = useRef<HTMLInputElement>(null);

    // Internal state
    const [internalValue, setInternalValue] = useState(defaultValue || '');
    const [isFocused, setIsFocused] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [popoverOpen, setPopoverOpen] = useState(false);

    const currentValue = value !== undefined ? value : internalValue;

    // Parse "HH:MM" or "HH:MM:SS" into parts; default to current time-ish so
    // the popover scrolls somewhere sensible on first open.
    const { selectedHour, selectedMinute, selectedSecond } = useMemo(() => {
      const parts = (currentValue || '').split(':');
      const h = Number.parseInt(parts[0] ?? '', 10);
      const m = Number.parseInt(parts[1] ?? '', 10);
      const s = Number.parseInt(parts[2] ?? '', 10);
      return {
        selectedHour: Number.isFinite(h) && h >= 0 && h < 24 ? h : null,
        selectedMinute: Number.isFinite(m) && m >= 0 && m < 60 ? m : null,
        selectedSecond: Number.isFinite(s) && s >= 0 && s < 60 ? s : null,
      };
    }, [currentValue]);

    // Size configurations
    const sizeConfig: Record<EMRInputSize, { height: number; fontSize: string; iconSize: number; padding: string }> = {
      xs: { height: 32, fontSize: 'var(--emr-font-sm)', iconSize: 14, padding: '0 10px' },
      sm: { height: 36, fontSize: 'var(--emr-font-base)', iconSize: 16, padding: '0 12px' },
      md: { height: 42, fontSize: 'var(--emr-font-md)', iconSize: 18, padding: '0 14px' },
      lg: { height: 48, fontSize: 'var(--emr-font-lg)', iconSize: 20, padding: '0 16px' },
      xl: { height: 54, fontSize: 'var(--emr-font-lg)', iconSize: 22, padding: '0 18px' },
    };

    const config = sizeConfig[size];

    // Sync ref
    useEffect(() => {
      if (ref) {
        if (typeof ref === 'function') {
          ref(inputRef.current);
        } else {
          ref.current = inputRef.current;
        }
      }
    }, [ref]);

    const fireChange = useCallback(
      (next: string) => {
        setInternalValue(next);
        if (onChange) {
          onChange(next);
        }
      },
      [onChange]
    );

    // Handle change event from native input (keyboard typing)
    const handleChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        fireChange(event.target.value);
      },
      [fireChange]
    );

    // Handle focus
    const handleFocus = useCallback(() => {
      setIsFocused(true);
    }, []);

    // Handle blur
    const handleBlur = useCallback(
      (event: React.FocusEvent<HTMLInputElement>) => {
        setIsFocused(false);
        if (onBlur) {
          onBlur(event);
        }
      },
      [onBlur]
    );

    // Open custom popover instead of native browser picker
    const handleContainerClick = useCallback(() => {
      if (!disabled && !readOnly) {
        setPopoverOpen((prev) => !prev);
      }
    }, [disabled, readOnly]);

    const buildTimeString = useCallback(
      (h: number | null, m: number | null, s: number | null): string => {
        const pad = (n: number): string => String(n).padStart(2, '0');
        const hh = pad(h ?? 0);
        const mm = pad(m ?? 0);
        if (withSeconds) {
          return `${hh}:${mm}:${pad(s ?? 0)}`;
        }
        return `${hh}:${mm}`;
      },
      [withSeconds]
    );

    const handlePickHour = useCallback(
      (h: number) => {
        fireChange(buildTimeString(h, selectedMinute, selectedSecond));
      },
      [fireChange, buildTimeString, selectedMinute, selectedSecond]
    );

    const handlePickMinute = useCallback(
      (m: number) => {
        fireChange(buildTimeString(selectedHour, m, selectedSecond));
        if (!withSeconds) {
          setPopoverOpen(false);
        }
      },
      [fireChange, buildTimeString, selectedHour, selectedSecond, withSeconds]
    );

    const handlePickSecond = useCallback(
      (s: number) => {
        fireChange(buildTimeString(selectedHour, selectedMinute, s));
        setPopoverOpen(false);
      },
      [fireChange, buildTimeString, selectedHour, selectedMinute]
    );

    const hasError = !!error;
    const hasValue = !!currentValue;

    return (
      <Box className={className} style={style}>
        {/* Label */}
        {label && (
          <Text
            component="label"
            size="sm"
            fw={600}
            c="var(--emr-text-primary)"
            mb={8}
            htmlFor={inputId}
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
          opened={popoverOpen}
          onChange={setPopoverOpen}
          position="bottom-start"
          shadow="md"
          withinPortal
          trapFocus={false}
          closeOnClickOutside
          closeOnEscape
          radius={12}
        >
          <Popover.Target>
            {/* Input Container */}
            <Box
              onClick={handleContainerClick}
              onMouseEnter={() => setIsHovered(true)}
              onMouseLeave={() => setIsHovered(false)}
              style={{
                height: config.height,
                borderRadius: 10,
                border: `2px solid ${
                  hasError
                    ? 'var(--emr-error)'
                    : isFocused
                    ? 'var(--emr-primary)'
                    : isHovered && !disabled
                    ? 'var(--emr-text-secondary)'
                    : 'var(--emr-border-default)'
                }`,
                background: disabled
                  ? 'var(--emr-bg-page)'
                  : 'linear-gradient(180deg, var(--emr-bg-card) 0%, var(--emr-bg-page) 100%)',
                display: 'flex',
                alignItems: 'center',
                padding: config.padding,
                cursor: disabled ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: isFocused
                  ? 'var(--emr-input-focus-glow)'
                  : isHovered && !disabled
                  ? 'var(--emr-input-shadow-hover)'
                  : 'var(--emr-input-shadow)',
                opacity: disabled ? 0.6 : 1,
              }}
            >
              {/* Clock Icon */}
              <Box
                style={{
                  width: config.iconSize + 12,
                  height: config.iconSize + 12,
                  borderRadius: 6,
                  background: isFocused
                    ? 'linear-gradient(135deg, var(--emr-primary) 0%, var(--emr-turquoise-dark) 100%)'
                    : 'var(--emr-bg-hover)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 12,
                  transition: 'all 0.2s ease',
                }}
              >
                <IconClock
                  size={config.iconSize}
                  strokeWidth={2}
                  color={isFocused ? 'var(--emr-bg-card)' : 'var(--emr-text-secondary)'}
                />
              </Box>

              {/* Native Time Input — kept for keyboard typing only; native
                  picker UI is suppressed via emr-fields.css. */}
              <input
                ref={inputRef}
                type="time"
                id={inputId}
                name={name}
                value={currentValue}
                onChange={handleChange}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onClick={(e) => e.stopPropagation()}
                placeholder={placeholder}
                disabled={disabled}
                readOnly={readOnly}
                required={required}
                step={withSeconds ? 1 : 60}
                aria-label={ariaLabel || (typeof label === 'string' ? label : undefined)}
                aria-describedby={ariaDescribedBy}
                aria-invalid={hasError}
                data-testid={dataTestId}
                className="emr-time-input-native"
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontSize: config.fontSize,
                  fontWeight: hasValue ? 500 : 400,
                  color: hasValue ? 'var(--emr-text-primary)' : 'var(--emr-text-secondary)',
                  letterSpacing: hasValue ? '0.02em' : 'normal',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  accentColor: 'var(--emr-primary)',
                }}
              />
            </Box>
          </Popover.Target>

          <Popover.Dropdown
            p={0}
            style={{
              background: 'var(--emr-bg-card)',
              border: '1px solid var(--emr-border-color)',
              overflow: 'hidden',
            }}
          >
            <TimePickerColumns
              selectedHour={selectedHour}
              selectedMinute={selectedMinute}
              selectedSecond={selectedSecond}
              withSeconds={withSeconds}
              onPickHour={handlePickHour}
              onPickMinute={handlePickMinute}
              onPickSecond={handlePickSecond}
              isOpen={popoverOpen}
            />
          </Popover.Dropdown>
        </Popover>

        {/* Help text */}
        {helpText && !hasError && (
          <Text size="xs" c="var(--emr-text-secondary)" mt={6}>
            {helpText}
          </Text>
        )}

        {/* Error Message */}
        {hasError && (
          <Group gap={6} mt={6}>
            <Text size="xs" c="var(--emr-error)">
              {typeof error === 'string' ? error : t('common.invalidTime')}
            </Text>
          </Group>
        )}
      </Box>
    );
  }
);

EMRTimeInput.displayName = 'EMRTimeInput';

interface TimePickerColumnsProps {
  selectedHour: number | null;
  selectedMinute: number | null;
  selectedSecond: number | null;
  withSeconds: boolean;
  onPickHour: (h: number) => void;
  onPickMinute: (m: number) => void;
  onPickSecond: (s: number) => void;
  isOpen: boolean;
}

function TimePickerColumns({
  selectedHour,
  selectedMinute,
  selectedSecond,
  withSeconds,
  onPickHour,
  onPickMinute,
  onPickSecond,
  isOpen,
}: TimePickerColumnsProps): React.JSX.Element {
  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const minutes = useMemo(() => Array.from({ length: 60 }, (_, i) => i), []);
  const seconds = useMemo(() => Array.from({ length: 60 }, (_, i) => i), []);

  return (
    <Group gap={0} align="stretch" wrap="nowrap">
      <TimeColumn values={hours} selected={selectedHour} onPick={onPickHour} isOpen={isOpen} />
      <Box style={{ width: 1, background: 'var(--emr-border-color)' }} />
      <TimeColumn values={minutes} selected={selectedMinute} onPick={onPickMinute} isOpen={isOpen} />
      {withSeconds && (
        <>
          <Box style={{ width: 1, background: 'var(--emr-border-color)' }} />
          <TimeColumn values={seconds} selected={selectedSecond} onPick={onPickSecond} isOpen={isOpen} />
        </>
      )}
    </Group>
  );
}

interface TimeColumnProps {
  values: number[];
  selected: number | null;
  onPick: (v: number) => void;
  isOpen: boolean;
}

function TimeColumn({ values, selected, onPick, isOpen }: TimeColumnProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll selected cell into view when popover opens
  useEffect(() => {
    if (isOpen && selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }, [isOpen, selected]);

  return (
    <Box
      ref={containerRef}
      style={{
        width: 64,
        height: 220,
        overflowY: 'auto',
        padding: 6,
        scrollbarWidth: 'thin',
      }}
    >
      {values.map((v) => {
        const isSelected = v === selected;
        return (
          <Box
            key={v}
            ref={isSelected ? selectedRef : undefined}
            onClick={() => onPick(v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 32,
              borderRadius: 8,
              cursor: 'pointer',
              userSelect: 'none',
              fontSize: 'var(--emr-font-base)',
              fontWeight: isSelected ? 'var(--emr-font-bold)' : 'var(--emr-font-medium)',
              color: isSelected ? 'var(--emr-text-inverse)' : 'var(--emr-text-primary)',
              background: isSelected ? 'var(--emr-primary)' : 'transparent',
              transition: 'background 0.12s ease, color 0.12s ease',
              marginBottom: 2,
            }}
            onMouseEnter={(e) => {
              if (!isSelected) {
                (e.currentTarget as HTMLDivElement).style.background = 'var(--emr-bg-hover-alt)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isSelected) {
                (e.currentTarget as HTMLDivElement).style.background = 'transparent';
              }
            }}
          >
            {String(v).padStart(2, '0')}
          </Box>
        );
      })}
    </Box>
  );
}

export default EMRTimeInput;
