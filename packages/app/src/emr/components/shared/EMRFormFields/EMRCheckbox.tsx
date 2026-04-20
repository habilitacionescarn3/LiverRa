// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React, { useId, forwardRef, memo, useCallback } from 'react';
import { Box, Text, Group } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import type { EMRCheckboxProps } from './EMRFieldTypes';
import './emr-fields.css';

/**
 * EMRCheckbox component
 * A premium, production-ready checkbox with elegant styling
 */
export const EMRCheckbox = memo(forwardRef<HTMLInputElement, EMRCheckboxProps>(
  (
    {
      // Field props
      id,
      name,
      label,
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

      // Checkbox specific props
      checked,
      defaultChecked,
      onChange,
      onChangeEvent,
      labelPosition = 'right',
      description,
       
      styles: _styles, // Ignored - using new design
    },
    ref
  ): React.JSX.Element => {
    const generatedId = useId();
    const inputId = id || generatedId;

    // Internal state for uncontrolled mode
    const [internalChecked, setInternalChecked] = React.useState(defaultChecked || false);
    const isChecked = checked !== undefined ? checked : internalChecked;

    // Size configurations
    const sizeConfig = {
      xs: { box: 16, icon: 10, fontSize: 'var(--emr-font-sm)', gap: 8 },
      sm: { box: 18, icon: 12, fontSize: 'var(--emr-font-base)', gap: 10 },
      md: { box: 22, icon: 14, fontSize: 'var(--emr-font-md)', gap: 12 },
      lg: { box: 26, icon: 16, fontSize: 'var(--emr-font-lg)', gap: 14 },
      xl: { box: 30, icon: 18, fontSize: 'var(--emr-font-lg)', gap: 16 },
    };

    const config = sizeConfig[size] || sizeConfig.md;

    // Handle change event
    const handleChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        if (disabled || readOnly) {return;}

        const newChecked = event.target.checked;
        setInternalChecked(newChecked);

        if (onChangeEvent) {
          onChangeEvent(event);
        }
        if (onChange) {
          onChange(newChecked);
        }
      },
      [onChange, onChangeEvent, disabled, readOnly]
    );

    // Handle click on the visual checkbox
    const handleClick = useCallback(() => {
      if (disabled || readOnly) {return;}

      const newChecked = !isChecked;
      setInternalChecked(newChecked);

      if (onChange) {
        onChange(newChecked);
      }
    }, [isChecked, onChange, disabled, readOnly]);

    // Determine error state
    const hasError = !!error;

    // Use description as fallback for helpText (backward compatibility)
    const displayHelpText = helpText || description;

    return (
      <Box className={className} style={style}>
        <Group
          gap={config.gap}
          wrap="nowrap"
          style={{
            flexDirection: labelPosition === 'left' ? 'row-reverse' : 'row',
            justifyContent: labelPosition === 'left' ? 'flex-end' : 'flex-start',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          }}
          onClick={handleClick}
        >
          {/* Hidden native checkbox for form submission */}
          <input
            ref={ref}
            type="checkbox"
            id={inputId}
            name={name}
            checked={isChecked}
            onChange={handleChange}
            disabled={disabled || readOnly}
            required={required}
            aria-label={ariaLabel || (typeof label === 'string' ? label : undefined)}
            aria-describedby={ariaDescribedBy}
            aria-invalid={hasError}
            data-testid={dataTestId}
            style={{
              position: 'absolute',
              opacity: 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            }}
          />

          {/* Custom styled checkbox */}
          <Box
            style={{
              width: config.box,
              height: config.box,
              minWidth: config.box,
              borderRadius: 6,
              border: `2px solid ${
                hasError
                  ? 'var(--emr-error)'
                  : isChecked
                  ? 'var(--emr-primary)'
                  : 'var(--emr-border-color)'
              }`,
              background: isChecked
                ? 'var(--emr-gradient-primary)'
                : 'var(--emr-bg-card)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              boxShadow: isChecked
                ? 'var(--emr-shadow-md)'
                : 'var(--emr-shadow-sm)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              position: 'relative',
              overflow: 'hidden',
            }}
            onMouseEnter={(e) => {
              if (!disabled && !readOnly) {
                e.currentTarget.style.transform = 'scale(1.05)';
                if (!isChecked) {
                  e.currentTarget.style.borderColor = 'var(--emr-border-color)';
                  e.currentTarget.style.boxShadow = 'var(--emr-shadow-md)';
                }
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              if (!isChecked) {
                e.currentTarget.style.borderColor = hasError ? 'var(--emr-error)' : 'var(--emr-border-color)';
                e.currentTarget.style.boxShadow = 'var(--emr-shadow-sm)';
              }
            }}
          >
            {/* Check icon with animation */}
            <IconCheck
              size={config.icon}
              strokeWidth={3}
              color="var(--emr-text-inverse)"
              style={{
                opacity: isChecked ? 1 : 0,
                transform: isChecked ? 'scale(1)' : 'scale(0.5)',
                transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            />
          </Box>

          {/* Label - using span to avoid nested <p> tags when label contains other elements */}
          {label && (
            <Text
              component="span"
              size={config.fontSize}
              fw={500}
              c={disabled ? 'var(--emr-text-muted)' : 'var(--emr-text-primary)'}
              style={{
                cursor: disabled ? 'not-allowed' : 'pointer',
                userSelect: 'none',
                lineHeight: 1.4,
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              {label}
              {required && (
                <Text component="span" c="var(--emr-error)" ml={4}>
                  *
                </Text>
              )}
            </Text>
          )}
        </Group>

        {/* Help text */}
        {displayHelpText && !hasError && (
          <Text
            size="xs"
            c="var(--emr-text-secondary)"
            mt={6}
            ml={labelPosition === 'right' ? config.box + config.gap : 0}
          >
            {displayHelpText}
          </Text>
        )}

        {/* Error message */}
        {hasError && typeof error === 'string' && (
          <Text
            size="xs"
            c="var(--emr-error)"
            mt={6}
            ml={labelPosition === 'right' ? config.box + config.gap : 0}
          >
            {error}
          </Text>
        )}
      </Box>
    );
  }
));

EMRCheckbox.displayName = 'EMRCheckbox';

export default EMRCheckbox;
