// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRBadge — a small pill / chip used for status, counts, and tags.
 *
 * Plain English: a tiny rounded label like "Completed" (green) or "RUO"
 * (orange). Replaces the Mantine `<Badge>` so we don't import Mantine UI
 * components anywhere in the app.
 */

import type { CSSProperties, ReactNode } from 'react';
import styles from './EMRBadge.module.css';

export type EMRBadgeVariant =
  | 'neutral'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'solidWarning';

export type EMRBadgeSize = 'sm' | 'md' | 'lg';

export interface EMRBadgeProps {
  variant?: EMRBadgeVariant;
  size?: EMRBadgeSize;
  /** Show a small leading dot (good for "running" / "live" indicators). */
  dot?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  'data-testid'?: string;
  'aria-label'?: string;
}

export function EMRBadge({
  variant = 'neutral',
  size = 'md',
  dot = false,
  className,
  style,
  children,
  'data-testid': dataTestId,
  'aria-label': ariaLabel,
}: EMRBadgeProps): React.ReactElement {
  const sizeClass = size === 'sm' ? styles.sizeSm : size === 'lg' ? styles.sizeLg : styles.sizeMd;
  return (
    <span
      className={[styles.badge, sizeClass, styles[variant], className].filter(Boolean).join(' ')}
      style={style}
      data-testid={dataTestId}
      aria-label={ariaLabel}
    >
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}

export default EMRBadge;
