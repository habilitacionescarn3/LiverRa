// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRTooltip — thin themed wrapper over Mantine's `Tooltip`.
 *
 * Plain-English: a hover/focus hint bubble that matches the EMR surface. We wrap
 * Mantine's `Tooltip` (a layout/interaction primitive — like how `EMRSlider`
 * wraps Mantine's `Slider`) only to inject theme colours and sensible defaults
 * (arrow, small delay) so every label-only tooltip in the app reads the same.
 *
 * Theme note: the bubble uses `--emr-text-primary` as its background and
 * `--emr-text-inverse` as its text. In light mode that resolves to a dark
 * bubble with white text (the conventional tooltip look); in dark mode it flips
 * to a light bubble with dark text. Both are auto-switching theme variables, so
 * there are no hardcoded colours and no `data-mantine-color-scheme` overrides.
 *
 * @module components/common/EMRTooltip
 */

import { Tooltip } from '@mantine/core';
import type { ReactElement, ReactNode } from 'react';

export interface EMRTooltipProps {
  /** Tooltip text / content */
  label: ReactNode;
  /** The element the tooltip is attached to (single child) */
  children: ReactElement;
  /** Placement relative to the target. Default 'top'. */
  position?: 'top' | 'bottom' | 'left' | 'right';
  /** Show the little arrow. Default true. */
  withArrow?: boolean;
  /** Render in a portal so the bubble escapes overflow/stacking contexts. Default true. */
  withinPortal?: boolean;
  /** Disable the tooltip (e.g. while loading) */
  disabled?: boolean;
  /** Open delay in ms. Default 200. */
  openDelay?: number;
  /** Allow multi-line wrapping (sets a max width). Default false. */
  multiline?: boolean;
  /** Test id */
  'data-testid'?: string;
}

/**
 * EMRTooltip — themed Mantine tooltip with EMR defaults.
 *
 * @param root0 - Props.
 * @param root0.label - Tooltip text / content.
 * @param root0.children - The single element the tooltip is attached to.
 * @param root0.position - Placement relative to the target.
 * @param root0.withArrow - Whether to show the arrow.
 * @param root0.withinPortal - Whether to render the bubble in a portal.
 * @param root0.disabled - Disable the tooltip.
 * @param root0.openDelay - Open delay in ms.
 * @param root0.multiline - Allow multi-line wrapping.
 * @param root0.'data-testid' - Test id.
 * @returns The themed tooltip element.
 */
export function EMRTooltip({
  label,
  children,
  position = 'top',
  withArrow = true,
  withinPortal = true,
  disabled = false,
  openDelay = 200,
  multiline = false,
  'data-testid': dataTestId,
}: EMRTooltipProps): ReactElement {
  return (
    <Tooltip
      label={label}
      position={position}
      withArrow={withArrow}
      withinPortal={withinPortal}
      disabled={disabled}
      openDelay={openDelay}
      multiline={multiline}
      data-testid={dataTestId}
      styles={{
        tooltip: {
          background: 'var(--emr-text-primary)',
          color: 'var(--emr-text-inverse)',
          fontSize: 'var(--emr-font-xs)',
          fontWeight: 'var(--emr-font-medium)',
          borderRadius: '8px',
          padding: '6px 10px',
          boxShadow: 'var(--emr-shadow-md)',
          maxWidth: multiline ? 240 : undefined,
        },
        arrow: {
          background: 'var(--emr-text-primary)',
        },
      }}
    >
      {children}
    </Tooltip>
  );
}

export default EMRTooltip;
