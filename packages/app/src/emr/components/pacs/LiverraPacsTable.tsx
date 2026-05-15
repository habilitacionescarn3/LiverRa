// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// LiverraPacsTable — PACS-specific table primitive
// ============================================================================
// PACS-specific table used by StudyList, UnmatchedStudiesQueue,
// ReadingWorklist. Carries features not yet in `common/EMRTable`:
//   - hideOnMobile / hideOnTablet column flags
//   - rowLeftBorder (per-row 3px left accent)
//   - rowClick keyboard navigation
//
// Status (C-UI-2): `common/EMRTable` is now the canonical wrapper for
// generic admin / list tables. Migrating the PACS consumers requires adding
// `hideOnMobile` + `rowLeftBorder` support to common/EMRTable first; tracked
// as PACS-table feature parity follow-up. Until then, these 3 PACS consumers
// remain on LiverraPacsTable. New table consumers (admin / settings / audit
// log) MUST use `common/EMRTable`.
//
// The local `EMRTable` export below is RENAMED to `LiverraPacsTable` to avoid
// the symbol collision with the canonical `common/EMRTable`. Re-exporting
// `EMRTable` as an alias for backward compat with the 3 PACS callers.
// ============================================================================

import React, { useCallback, type ReactNode } from 'react';
import { Table, Text, Box } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { Icon as TablerIcon } from '@tabler/icons-react';
import styles from './LiverraPacsTable.module.css';

// ============================================================================
// Types
// ============================================================================

export interface EMRTableColumn<TRow> {
  key: string;
  title: ReactNode;
  width?: string;
  sortable?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Hide column on screens ≤ 768px. */
  hideOnMobile?: boolean;
  /** Hide column on screens ≤ 1024px. */
  hideOnTablet?: boolean;
  render: (row: TRow) => ReactNode;
}

export interface EMRTableEmptyState {
  icon?: TablerIcon;
  title: string;
  description?: string;
}

export interface EMRTableProps<TRow> {
  columns: EMRTableColumn<TRow>[];
  data: TRow[];
  onRowClick?: (row: TRow) => void;
  /** Return a color string to paint a 3-px left border; `false` for none. */
  rowLeftBorder?: (row: TRow) => string | false;
  enableKeyboardNavigation?: boolean;
  striped?: boolean;
  stickyHeader?: boolean;
  compact?: boolean;
  ariaLabel?: string;
  emptyState?: EMRTableEmptyState;
}

// ============================================================================
// Component
// ============================================================================

/** Key resolver — rows may or may not have `.id`; fall back to index. */
function getRowKey<TRow>(row: TRow, index: number): string {
  const r = row as unknown as { id?: string | number };
  return r.id !== undefined ? String(r.id) : String(index);
}

export function EMRTable<TRow>({
  columns,
  data,
  onRowClick,
  rowLeftBorder,
  striped,
  stickyHeader,
  compact,
  ariaLabel,
  emptyState,
}: EMRTableProps<TRow>): React.ReactElement {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isTablet = useMediaQuery('(max-width: 1024px)');

  const visibleColumns = columns.filter((col) => {
    if (col.hideOnMobile && isMobile) return false;
    if (col.hideOnTablet && isTablet) return false;
    return true;
  });

  const handleKeyDown = useCallback(
    (row: TRow, e: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (!onRowClick) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onRowClick(row);
      }
    },
    [onRowClick]
  );

  // Empty state
  if (data.length === 0 && emptyState) {
    const Icon = emptyState.icon;
    return (
      <Box className={styles.emptyState}>
        {Icon && (
          <Box className={styles.emptyIcon}>
            <Icon size={28} style={{ color: 'var(--emr-text-secondary)' }} />
          </Box>
        )}
        <Text
          size="md"
          fw={500}
          style={{ color: 'var(--emr-text-primary)' }}
        >
          {emptyState.title}
        </Text>
        {emptyState.description && (
          <Text size="sm" c="dimmed" mt={4}>
            {emptyState.description}
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Table
      aria-label={ariaLabel}
      className={`${styles.table} ${compact ? styles.compact : ''} ${
        stickyHeader ? styles.stickyHeader : ''
      } ${striped ? styles.striped : ''}`}
      verticalSpacing={compact ? 'xs' : 'sm'}
      horizontalSpacing="sm"
      withRowBorders
    >
      <Table.Thead>
        <Table.Tr>
          {visibleColumns.map((col) => (
            <Table.Th
              key={col.key}
              style={{
                width: col.width,
                textAlign: col.align ?? 'left',
                whiteSpace: 'nowrap',
              }}
            >
              {col.title}
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {data.map((row, idx) => {
          const borderColor = rowLeftBorder ? rowLeftBorder(row) : false;
          return (
            <Table.Tr
              key={getRowKey(row, idx)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => handleKeyDown(row, e) : undefined}
              role={onRowClick ? 'button' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              style={{
                cursor: onRowClick ? 'pointer' : undefined,
                borderLeft: borderColor ? `3px solid ${borderColor}` : undefined,
              }}
            >
              {visibleColumns.map((col) => (
                <Table.Td
                  key={col.key}
                  style={{ textAlign: col.align ?? 'left' }}
                >
                  {col.render(row)}
                </Table.Td>
              ))}
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

export default EMRTable;
