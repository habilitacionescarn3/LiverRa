// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrBadgeColor — maps the semantic `ReadoutRow.badge.color` palette
 * (gray/yellow/orange/red/green/blue) to `EMRBadge` variants.
 *
 * The renderer DTO (`acrAnatomicalMapping.ts`) uses raw color names that
 * match Mantine's default badge palette. EMRBadge exposes a more
 * abstracted `variant` API — this thin adapter keeps both sides honest
 * without leaking palette names through the component layer.
 */

import type { EMRBadgeVariant } from '../common';

export type ReadoutRowBadgeColor =
  | 'gray'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'green'
  | 'blue';

export function mapBadgeColorToVariant(
  color: ReadoutRowBadgeColor,
): EMRBadgeVariant {
  switch (color) {
    case 'gray':
      return 'neutral';
    case 'yellow':
      return 'warning';
    case 'orange':
      return 'solidWarning';
    case 'red':
      return 'danger';
    case 'green':
      return 'success';
    case 'blue':
      return 'info';
    default:
      return 'neutral';
  }
}
