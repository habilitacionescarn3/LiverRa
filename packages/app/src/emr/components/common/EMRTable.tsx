// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRTable — the standardized data-table wrapper for LiverRa.
 *
 * Plain English: think of this as the official "list view" component. Whenever
 * a page needs to show tabular data (study list, user admin, audit log, etc.),
 * it goes through this wrapper instead of using Mantine's raw `<Table>`. That
 * way, sortable headers, loading skeletons, empty states, error states, and
 * dark-mode handling all stay consistent across every list in the product.
 *
 * Why this exists (C-UI-2 fix):
 *   CLAUDE.md mandates that "ALL tables → EMRTable / EMRVirtualTable" but the
 *   wrapper didn't exist before. UserManagementView + LiverraPacsTable both
 *   imported `Table` from `@mantine/core` directly. This file closes that gap.
 *
 * Architecture:
 *   - Built on Mantine `<Table>` (an allowed layout primitive per CLAUDE.md).
 *   - Lightweight sorting (no TanStack Table dep; not currently installed).
 *   - Hooks into the existing `EMRTableSkeleton` + `EMRTableEmptyState`.
 *   - Keyboard navigable rows (Enter/Space on a focused row fires onRowClick).
 *   - aria-sort + aria-label on every sortable header.
 *
 * For 100+ rows: use EMRVirtualTable instead (deferred; tracked separately).
 */

import { Table, ScrollArea, Box, Text, Stack, Group } from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconArrowsSort, IconRefresh } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useMemo, useState, useCallback } from 'react';
import { EMRTableSkeleton } from './EMRTableSkeleton';
import { EMRTableEmptyState } from './EMRTableEmptyState';
import { EMRAlert } from './EMRAlert';
import { EMRButton } from './EMRButton';
import { useTranslation } from '../../contexts/TranslationContext';

/**
 * Column definition for an EMRTable.
 *
 * @typeParam T - The row data type.
 */
export interface EMRTableColumn<T> {
  /** Unique identifier — also used as the sort key when sortable. */
  id: string;
  /** Header label (string or rendered node). */
  header: ReactNode;
  /** Cell renderer — receives the row + index. */
  cell: (row: T, rowIndex: number) => ReactNode;
  /** Optional: allow this column to be sorted by clicking the header. */
  sortable?: boolean;
  /** Optional: provide a sort comparator. Defaults to string compare on the cell text. */
  sortFn?: (a: T, b: T) => number;
  /** Optional: fixed width (px). */
  width?: number | string;
  /** Optional: alignment for both header + body cells. */
  align?: 'left' | 'center' | 'right';
  /** Optional: aria-label override for the header (screen readers). */
  ariaLabel?: string;
}

/** Sort state shape. */
export interface EMRTableSort {
  columnId: string;
  direction: 'asc' | 'desc';
}

/**
 * Props for EMRTable.
 */
export interface EMRTableProps<T> {
  /** Row data. Empty array triggers the empty state. */
  data: T[];
  /** Column definitions. */
  columns: EMRTableColumn<T>[];
  /** Whether data is currently loading — shows the skeleton. */
  loading?: boolean;
  /** Optional error to display in place of the table body. */
  error?: { message: string; onRetry?: () => void } | null;
  /** Optional empty-state override (else uses EMRTableEmptyState defaults). */
  emptyState?: ReactNode;
  /** Per-row click handler — also wired to keyboard Enter/Space. */
  onRowClick?: (row: T, rowIndex: number) => void;
  /** Row density. */
  rowHeight?: 'compact' | 'comfortable' | 'spacious';
  /** REQUIRED — describes the table for screen readers. */
  ariaLabel: string;
  /** Optional: function to compute a stable row key. Defaults to row index. */
  rowKey?: (row: T, rowIndex: number) => string | number;
  /** Optional: render a class name based on the row + index. */
  rowClassName?: (row: T, rowIndex: number) => string | undefined;
  /** Default sort to apply on mount. */
  defaultSort?: EMRTableSort;
  /** Test ID for testing. */
  testId?: string;
}

const VERTICAL_SPACING: Record<NonNullable<EMRTableProps<unknown>['rowHeight']>, string> = {
  compact: 'xs',
  comfortable: 'sm',
  spacious: 'md',
};

/**
 * Default string-based comparator used when no `sortFn` is supplied.
 * Renders the cell to a string via the column.cell function — best effort
 * (works for string / number columns; supply a custom sortFn for dates etc.).
 */
function defaultCompare<T>(a: T, b: T, col: EMRTableColumn<T>, aIdx: number, bIdx: number): number {
  const aValue = col.cell(a, aIdx);
  const bValue = col.cell(b, bIdx);
  // Coerce to string for comparison; handle numbers naturally.
  if (typeof aValue === 'number' && typeof bValue === 'number') {
    return aValue - bValue;
  }
  const aStr = aValue == null ? '' : String(aValue);
  const bStr = bValue == null ? '' : String(bValue);
  return aStr.localeCompare(bStr);
}

/**
 * EMRTable — standardized list view (sortable headers, loading, empty, error).
 *
 * @example
 * ```tsx
 * <EMRTable
 *   ariaLabel="User list"
 *   data={users}
 *   columns={[
 *     { id: 'name', header: 'Name', cell: u => u.name, sortable: true },
 *     { id: 'email', header: 'Email', cell: u => u.email, sortable: true },
 *   ]}
 *   loading={isLoading}
 *   onRowClick={u => navigate(`/users/${u.id}`)}
 * />
 * ```
 */
export function EMRTable<T>({
  data,
  columns,
  loading = false,
  error = null,
  emptyState,
  onRowClick,
  rowHeight = 'comfortable',
  ariaLabel,
  rowKey,
  rowClassName,
  defaultSort,
  testId,
}: EMRTableProps<T>): React.ReactElement {
  const { t } = useTranslation();
  const [sort, setSort] = useState<EMRTableSort | null>(defaultSort ?? null);

  const toggleSort = useCallback((columnId: string) => {
    setSort((prev) => {
      if (!prev || prev.columnId !== columnId) {
        return { columnId, direction: 'asc' };
      }
      if (prev.direction === 'asc') {
        return { columnId, direction: 'desc' };
      }
      return null;
    });
  }, []);

  const sortedData = useMemo(() => {
    if (!sort) return data;
    const col = columns.find((c) => c.id === sort.columnId);
    if (!col) return data;
    // Build [row, originalIndex] pairs so we can pass the right index into cell renderers.
    const indexed = data.map((row, i) => [row, i] as const);
    indexed.sort(([a, aIdx], [b, bIdx]) => {
      const cmp = col.sortFn ? col.sortFn(a, b) : defaultCompare(a, b, col, aIdx, bIdx);
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return indexed.map(([row]) => row);
  }, [data, sort, columns]);

  const renderHeader = (col: EMRTableColumn<T>): ReactNode => {
    const isSorted = sort?.columnId === col.id;
    const ariaSort = isSorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
    const Icon = !col.sortable
      ? null
      : isSorted
      ? sort.direction === 'asc'
        ? IconArrowUp
        : IconArrowDown
      : IconArrowsSort;

    const headerContent = (
      <Group gap={6} wrap="nowrap" justify={col.align === 'right' ? 'flex-end' : col.align === 'center' ? 'center' : 'flex-start'}>
        <span>{col.header}</span>
        {Icon && <Icon size={14} aria-hidden="true" />}
      </Group>
    );

    if (!col.sortable) {
      return (
        <Table.Th
          key={col.id}
          style={{ width: col.width, textAlign: col.align ?? 'left' }}
          aria-label={col.ariaLabel ?? (typeof col.header === 'string' ? col.header : col.id)}
        >
          {headerContent}
        </Table.Th>
      );
    }

    return (
      <Table.Th
        key={col.id}
        style={{ width: col.width, textAlign: col.align ?? 'left', cursor: 'pointer', userSelect: 'none' }}
        aria-sort={ariaSort}
        aria-label={col.ariaLabel ?? (typeof col.header === 'string' ? `${col.header}, sortable` : col.id)}
      >
        <Box
          component="button"
          type="button"
          onClick={() => toggleSort(col.id)}
          style={{
            background: 'transparent',
            border: 0,
            padding: 0,
            margin: 0,
            cursor: 'pointer',
            width: '100%',
            font: 'inherit',
            color: 'inherit',
            textAlign: 'inherit',
            /* Tap-target compliance (WCAG 2.5.5 AAA). */
            minHeight: 44,
          }}
        >
          {headerContent}
        </Box>
      </Table.Th>
    );
  };

  // Body state — error wins over loading wins over empty wins over rows.
  const bodyContent = (() => {
    if (error) {
      return (
        <Box p="md">
          <EMRAlert variant="error" title={t('common.error', 'Error')}>
            <Stack gap="sm">
              <Text size="sm">{error.message}</Text>
              {error.onRetry && (
                <Group>
                  <EMRButton
                    variant="primary"
                    icon={IconRefresh}
                    size="sm"
                    onClick={error.onRetry}
                  >
                    {t('common.retry', 'Retry')}
                  </EMRButton>
                </Group>
              )}
            </Stack>
          </EMRAlert>
        </Box>
      );
    }

    if (loading) {
      return <EMRTableSkeleton rows={6} columns={columns.length} />;
    }

    if (sortedData.length === 0) {
      return emptyState ?? (
        <EMRTableEmptyState
          title={t('common.noData', 'No data')}
          description={t('common.noDataDescription', 'There is nothing to display yet.')}
          colSpan={columns.length}
        />
      );
    }

    return (
      <Table.Tbody>
        {sortedData.map((row, rowIndex) => {
          const key = rowKey ? rowKey(row, rowIndex) : rowIndex;
          const clickable = !!onRowClick;
          const onKeyDown = clickable
            ? (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onRowClick!(row, rowIndex);
                }
              }
            : undefined;

          return (
            <Table.Tr
              key={key}
              onClick={clickable ? () => onRowClick!(row, rowIndex) : undefined}
              onKeyDown={onKeyDown}
              tabIndex={clickable ? 0 : undefined}
              role={clickable ? 'button' : undefined}
              className={rowClassName?.(row, rowIndex)}
              style={clickable ? { cursor: 'pointer' } : undefined}
            >
              {columns.map((col) => (
                <Table.Td
                  key={col.id}
                  style={{ textAlign: col.align ?? 'left' }}
                >
                  {col.cell(row, rowIndex)}
                </Table.Td>
              ))}
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    );
  })();

  return (
    <ScrollArea>
      <Table
        striped
        highlightOnHover
        verticalSpacing={VERTICAL_SPACING[rowHeight]}
        horizontalSpacing="md"
        aria-label={ariaLabel}
        data-testid={testId}
      >
        <Table.Thead>
          <Table.Tr>{columns.map(renderHeader)}</Table.Tr>
        </Table.Thead>
        {/* Body content is intentionally a sibling of <Thead> to support
            error/empty/loading slots replacing <Tbody> entirely. */}
        {bodyContent}
      </Table>
    </ScrollArea>
  );
}

export default EMRTable;
