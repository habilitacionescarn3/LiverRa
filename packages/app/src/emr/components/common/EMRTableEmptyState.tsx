// SPDX-License-Identifier: Apache-2.0
// TODO: full port once MediMind upstream splits this out — stubbed for LiverRa scaffold.

import { Box } from '@mantine/core';
import type { ComponentType } from 'react';
import { EMREmptyState } from './EMREmptyState';

export interface EMRTableEmptyStateProps {
  /** Empty-state title */
  title: string;
  /** Optional longer description */
  description?: string;
  /** Optional icon (Tabler icon component) */
  icon?: ComponentType<{ size?: number | string }>;
  /** Column count for table colSpan (default: 1 — renders outside table shell if not provided) */
  colSpan?: number;
  /** Optional primary action CTA */
  action?: { label: string; onClick: () => void };
}

/**
 * EMRTableEmptyState — thin wrapper around EMREmptyState for table contexts.
 * Renders a full-width single-row message inside a `<tr><td colSpan>` when
 * `colSpan` is provided; otherwise renders a bare Box suitable for use
 * outside a `<table>`.
 */
export function EMRTableEmptyState({
  title,
  description,
  icon,
  colSpan,
  action,
}: EMRTableEmptyStateProps): React.ReactElement {
  const content = (
    <EMREmptyState
      title={title}
      description={description}
      icon={icon}
      action={action}
    />
  );

  if (colSpan && colSpan > 0) {
    return (
      <tr>
        <td colSpan={colSpan} style={{ padding: 0, border: 'none' }}>
          <Box py="xl">{content}</Box>
        </td>
      </tr>
    );
  }
  return <Box py="xl">{content}</Box>;
}

export default EMRTableEmptyState;
