// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRIconButton — square, icon-only button for toolbars and rail toggles.
 *
 * Plain English: a clickable square with a single icon inside. Replaces
 * Mantine's `<ActionIcon>` so we never touch Mantine UI primitives.
 */

import type { ButtonHTMLAttributes, ComponentType } from 'react';
import { forwardRef } from 'react';
import styles from './EMRIconButton.module.css';

export interface EMRIconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: ComponentType<{ size?: number; stroke?: number }>;
  /**
   * Visual size of the button.
   *
   * - `md` (default) — 44×44, WCAG 2.5.5 AAA compliant. Use everywhere by default.
   * - `sm` — 38×38 visual, 44×44 hit zone via ::before pseudo-element. Use
   *   only in dense toolbars where layout precludes 44px squares.
   * - `lg` — 50×50, for hero CTAs (theater toggle).
   * - `clinicalControl` — 44×44, for DICOM viewer + measurement / segmentation
   *   panel controls. Same dimensions as `md` but a dedicated class so viewer
   *   styling can scope clinical accents without bleeding into general buttons.
   */
  size?: 'sm' | 'md' | 'lg' | 'clinicalControl';
  variant?: 'subtle' | 'solid';
  active?: boolean;
  iconSize?: number;
  /** REQUIRED — describes what the button does for screen readers. */
  'aria-label': string;
}

export const EMRIconButton = forwardRef<HTMLButtonElement, EMRIconButtonProps>(
  function EMRIconButton(
    {
      icon: Icon,
      size = 'md',
      variant = 'subtle',
      active = false,
      iconSize,
      className,
      type = 'button',
      ...rest
    },
    ref,
  ) {
    const sizeClass =
      size === 'sm'
        ? styles.sm
        : size === 'lg'
        ? styles.lg
        : size === 'clinicalControl'
        ? styles.clinicalControl
        : '';
    const computedIconSize =
      iconSize ??
      (size === 'sm' ? 16 : size === 'lg' ? 24 : 20);
    return (
      <button
        ref={ref}
        type={type}
        className={[
          styles.btn,
          sizeClass,
          variant === 'solid' ? styles.solid : null,
          active ? styles.active : null,
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        aria-pressed={active ? true : undefined}
        {...rest}
      >
        <Icon size={computedIconSize} stroke={2} />
      </button>
    );
  },
);

export default EMRIconButton;
