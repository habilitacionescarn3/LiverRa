// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { useMediaQuery } from '@mantine/hooks';
import type { ReactNode, CSSProperties, FormHTMLAttributes } from 'react';
import React, { useMemo } from 'react';
import styles from './MobileFormWrapper.module.css';

/** Gap size options */
export type MobileFormWrapperGap = 'sm' | 'md' | 'lg';

export interface MobileFormWrapperProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  /** Form content */
  children: ReactNode;
  /** Render as form element (default: true) */
  asForm?: boolean;
  /** Gap between form elements */
  gap?: MobileFormWrapperGap;
  /** Custom className */
  className?: string;
  /** Custom inline styles */
  style?: CSSProperties;
  /** Test ID for testing */
  testId?: string;
  /** Form submission handler */
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;
  /** ARIA label for the form */
  'aria-label'?: string;
}

/**
 * MobileFormWrapper - Mobile-optimized form container
 *
 * Enforces mobile-friendly form standards:
 * - 16px minimum font size (prevents iOS auto-zoom on inputs)
 * - Touch-friendly spacing between elements
 * - Proper keyboard types via context
 *
 * Usage:
 * ```tsx
 * <MobileFormWrapper asForm onSubmit={handleSubmit}>
 *   <EMRTextInput label="Name" ... />
 *   <EMRSelect label="Gender" ... />
 *   <button type="submit">Save</button>
 * </MobileFormWrapper>
 * ```
 */
export const MobileFormWrapper = React.forwardRef<HTMLFormElement, MobileFormWrapperProps>(function MobileFormWrapper({
  children,
  asForm = true,
  gap = 'md',
  className,
  style,
  testId,
  onSubmit,
  'aria-label': ariaLabel,
  ...rest
}: MobileFormWrapperProps, ref): React.ReactElement {
  // Mobile detection (breakpoint: 768px)
  const isMobile = useMediaQuery('(max-width: 768px)');

  // Build class names
  const classNames = useMemo(() => {
    const classes: string[] = [];

    if (isMobile) {
      classes.push(styles.mobileFormWrapper);
    }

    // Gap classes
    switch (gap) {
      case 'sm':
        classes.push(styles.gapSm);
        break;
      case 'md':
        classes.push(styles.gapMd);
        break;
      case 'lg':
        classes.push(styles.gapLg);
        break;
    }

    if (className) {
      classes.push(className);
    }

    return classes.join(' ');
  }, [isMobile, gap, className]);

  // Common props for both form and div
  const commonProps = {
    className: classNames,
    style,
    'data-testid': testId,
    'data-mobile': isMobile ? 'true' : undefined,
    'aria-label': ariaLabel,
  };

  if (asForm) {
    return (
      <form
        {...commonProps}
        onSubmit={onSubmit}
        ref={ref}
        {...rest}
      >
        {children}
      </form>
    );
  }

  return (
    <div {...commonProps}>
      {children}
    </div>
  );
});

export type { MobileFormWrapperGap as MobileFormWrapperGapType };
