// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRSlider — production-ready slider wrapper.
 *
 * Plain-English: Range slider with label, current-value pill, optional helper
 * description, and full theme integration. Uses Mantine's `Slider` internally
 * for keyboard navigation, drag, and a11y wiring (Mantine slider is a layout-
 * agnostic input primitive — analogous to how EMRTextInput wraps Mantine's
 * `TextInput`).
 *
 * Why wrap, not custom-build: the keyboard contract (Home/End/PgUp/PgDn,
 * arrows-by-step) is non-trivial to get right; reusing Mantine's a11y
 * implementation is the conservative choice. Visual styling is fully
 * overridden via `classNames` so the result matches the rest of the EMR
 * surface (theme variables only — no hardcoded colors).
 *
 * @module components/shared/EMRFormFields/EMRSlider
 */

import { memo, useId } from 'react';
import { Slider } from '@mantine/core';
import type { CSSProperties, ReactNode } from 'react';

import styles from './EMRSlider.module.css';

export interface EMRSliderProps {
  /** Current value */
  value: number;
  /** Change handler — value-first signature (matches Mantine) */
  onChange: (value: number) => void;
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Step increment */
  step?: number;
  /** Optional label rendered above the slider */
  label?: ReactNode;
  /** Optional helper description rendered below the slider */
  description?: ReactNode;
  /** Optional value formatter (default: number as-is). Receives value, returns display string. */
  formatValue?: (value: number) => string;
  /** Optional unit displayed next to the value (e.g. "HU", "mm") */
  unit?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Size variant: 'sm' (24px thumb) | 'md' (28px thumb, default) */
  size?: 'sm' | 'md';
  /** Test id */
  'data-testid'?: string;
  /** Aria label fallback if no visible label is set */
  'aria-label'?: string;
  /** Optional className appended to wrapper */
  className?: string;
  /** Optional inline style */
  style?: CSSProperties;
}

/**
 * EMRSlider — themed slider with label + value chip.
 */
export const EMRSlider = memo(function EMRSlider({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  description,
  formatValue,
  unit,
  disabled = false,
  size = 'md',
  'data-testid': dataTestId,
  'aria-label': ariaLabel,
  className,
  style,
}: EMRSliderProps) {
  const generatedId = useId();
  const labelId = label ? `${generatedId}-label` : undefined;
  const descId = description ? `${generatedId}-desc` : undefined;

  const displayValue = formatValue ? formatValue(value) : String(value);
  const valueText = unit ? `${displayValue} ${unit}` : displayValue;

  const wrapperClass = [
    styles.wrapper,
    size === 'sm' ? styles.sizeSm : styles.sizeMd,
    disabled ? styles.disabled : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperClass} style={style}>
      {(label || valueText) && (
        <div className={styles.header}>
          {label && (
            <span id={labelId} className={styles.label}>
              {label}
            </span>
          )}
          <span className={styles.valueChip} aria-hidden="true">
            {valueText}
          </span>
        </div>
      )}
      <Slider
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        label={null}
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        aria-labelledby={labelId}
        aria-describedby={descId}
        data-testid={dataTestId}
        classNames={{
          root: styles.sliderRoot,
          track: styles.sliderTrack,
          bar: styles.sliderBar,
          thumb: styles.sliderThumb,
        }}
      />
      {description && (
        <p id={descId} className={styles.description}>
          {description}
        </p>
      )}
    </div>
  );
});

export default EMRSlider;
