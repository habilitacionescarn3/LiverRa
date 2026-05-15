// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Button, Loader } from '@mantine/core';
import { memo } from 'react';
import type { ComponentType, ReactNode } from 'react';
import classes from './EMRButton.module.css';

/** Icon props type for Tabler icons */
interface IconProps {
  size?: number | string;
  stroke?: number;
}

/** Size variants for the button */
export type EMRButtonSize = 'xs' | 'sm' | 'md' | 'lg';

/** Visual variants for the button */
export type EMRButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline' | 'subtle' | 'light';

/**
 * Props for EMRButton component
 */
export interface EMRButtonProps {
  /** Button label text */
  children?: ReactNode;
  /** Visual variant: primary (gradient), secondary (outlined), danger (red), ghost (minimal) */
  variant?: EMRButtonVariant;
  /** Size variant: sm=38px, md=44px (default), lg=50px */
  size?: EMRButtonSize;
  /** Icon component to display */
  icon?: ComponentType<IconProps>;
  /** Icon position: left (default) or right */
  iconPosition?: 'left' | 'right';
  /** Direct left section element (alternative to icon prop) */
  leftSection?: ReactNode;
  /** Loading state - shows spinner instead of icon */
  loading?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Full width button */
  fullWidth?: boolean;
  /** Button type for forms */
  type?: 'button' | 'submit' | 'reset';
  /** Click handler */
  onClick?: () => void | Promise<void>;
  /** Test ID for testing */
  'data-testid'?: string;
  /** Aria label for accessibility */
  'aria-label'?: string;
  /** Additional CSS class name */
  className?: string;
  /** Inline styles (use sparingly, prefer className) */
  style?: React.CSSProperties;
  /** Button color (passed through to Mantine) */
  color?: string;
}

/**
 * Visual heights for each size. Note: WCAG 2.5.5 AAA requires a 44×44 hit zone;
 * for xs/sm the VISUAL height is smaller, but the hit zone is expanded to 44px
 * via vertical padding applied in the styles (see `minTouchAreaPadY` below).
 */
const heights: Record<EMRButtonSize, number> = {
  xs: 32,
  sm: 38,
  md: 44,
  lg: 50,
};

/**
 * Extra vertical hit-area padding so xs/sm hit zone reaches 44px.
 * Computed = (44 - visualHeight) / 2.
 */
const minTouchAreaPadY: Record<EMRButtonSize, number> = {
  xs: 6,  // 32 + 6*2 = 44
  sm: 3,  // 38 + 3*2 = 44
  md: 0,
  lg: 0,
};

/** Icon sizes for each button size */
const iconSizes: Record<EMRButtonSize, number> = {
  xs: 14,
  sm: 16,
  md: 18,
  lg: 20,
};

/**
 * Get CSS module class for each variant
 * @param variant
 */
const getVariantClass = (variant: EMRButtonVariant): string => {
  switch (variant) {
    case 'primary':
      return classes.primaryButton;
    case 'secondary':
    case 'outline':
    case 'light':
      return classes.secondaryButton;
    case 'danger':
      return classes.dangerButton;
    case 'ghost':
    case 'subtle':
      return classes.ghostButton;
    default:
      return '';
  }
};

/**
 * EMRButton - General-purpose button component for the EMR application
 *
 * Features:
 * - Four variants: primary (gradient), secondary (outlined), danger (red), ghost (minimal)
 * - Touch-friendly sizing (44px default height)
 * - Loading state with spinner
 * - Icon support on left or right
 * - Consistent styling across all EMR pages
 *
 * @param root0
 * @param root0.children
 * @param root0.variant
 * @param root0.size
 * @param root0.icon
 * @param root0.iconPosition
 * @param root0.loading
 * @param root0.disabled
 * @param root0.fullWidth
 * @param root0.type
 * @param root0.onClick
 * @param root0.'data-testid'
 * @param root0.'aria-label'
 * @param root0.className
 * @param root0.style
 * @example
 * ```tsx
 * // Primary button (main actions)
 * <EMRButton variant="primary" onClick={handleSave}>
 *   Save Changes
 * </EMRButton>
 *
 * // Secondary button (cancel, back)
 * <EMRButton variant="secondary" onClick={handleCancel}>
 *   Cancel
 * </EMRButton>
 *
 * // Danger button (delete, destructive actions)
 * <EMRButton variant="danger" icon={IconTrash} onClick={handleDelete}>
 *   Delete
 * </EMRButton>
 *
 * // Ghost button (minimal, tertiary actions)
 * <EMRButton variant="ghost" onClick={handleSkip}>
 *   Skip
 * </EMRButton>
 * ```
 */
export const EMRButton = memo(function EMRButton({
  children,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconPosition = 'left',
  leftSection: leftSectionProp,
  loading = false,
  disabled = false,
  fullWidth = false,
  type = 'button',
  onClick,
  'data-testid': testId,
  'aria-label': ariaLabel,
  className,
  style,
  color,
}: EMRButtonProps): React.ReactElement {
  const height = heights[size];
  const iconSize = iconSizes[size];
  const touchPadY = minTouchAreaPadY[size];
  const variantClass = getVariantClass(variant);

  const iconElement = loading ? (
    <Loader size={iconSize} color={variant === 'secondary' || variant === 'ghost' ? 'gray' : 'white'} />
  ) : Icon ? (
    <Icon size={iconSize} stroke={2} />
  ) : null;

  // Use direct leftSection prop if provided, otherwise use icon-generated element
  const resolvedLeftSection = leftSectionProp || (iconPosition === 'left' ? iconElement : undefined);

  // Combine variant class with any custom className
  const combinedClassName = [variantClass, className].filter(Boolean).join(' ');

  return (
    <Button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      fullWidth={fullWidth}
      data-testid={testId}
      data-loading={loading || undefined}
      aria-label={ariaLabel}
      className={combinedClassName}
      style={style}
      color={color}
      leftSection={resolvedLeftSection}
      rightSection={iconPosition === 'right' ? iconElement : undefined}
      styles={{
        root: {
          height,
          /* WCAG 2.5.5 AAA: enforce 44×44 minimum hit zone for xs/sm via
           * extra padding-block. Visual height stays compact for dense UIs. */
          minHeight: 44,
          paddingBlock: touchPadY > 0 ? `${touchPadY}px` : undefined,
          borderRadius: 'var(--emr-border-radius)',
          fontWeight: 'var(--emr-font-semibold)',
          fontSize: 'var(--emr-font-base)',
          letterSpacing: '0.01em',
          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        },
        label: {
          overflow: 'visible',
          height: 'auto',
        },
      }}
    >
      {children}
    </Button>
  );
});

export default EMRButton;
