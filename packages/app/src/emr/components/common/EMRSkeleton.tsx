// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React, { memo } from 'react';
import { Box, Skeleton, Stack, Group, Table } from '@mantine/core';
import classes from './EMRSkeleton.module.css';

/**
 * Base skeleton props shared across all skeleton variants
 */
export interface EMRSkeletonBaseProps {
  /** Whether to animate the skeleton with shimmer effect */
  animate?: boolean;
  /** Custom class name */
  className?: string;
  /** Accessible label for screen readers */
  'aria-label'?: string;
  /** Test ID for testing */
  'data-testid'?: string;
}

/**
 * EMRSkeleton - Base skeleton component with shimmer animation
 *
 * Use this as the building block for custom skeleton layouts.
 * Provides consistent shimmer animation and accessibility support.
 *
 * @example
 * ```tsx
 * <EMRSkeleton height={20} width="60%" radius="sm" />
 * ```
 */
export interface EMRSkeletonProps extends EMRSkeletonBaseProps {
  /** Height of the skeleton */
  height?: number | string;
  /** Width of the skeleton */
  width?: number | string;
  /** Border radius */
  radius?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;
  /** Whether to display as a circle */
  circle?: boolean;
}

export const EMRSkeleton = memo(function EMRSkeleton({
  height,
  width,
  radius = 'sm',
  circle,
  animate = true,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: EMRSkeletonProps): React.ReactElement {
  return (
    <Skeleton
      height={height}
      width={width}
      radius={circle ? '50%' : radius}
      circle={circle}
      animate={animate}
      className={`${classes.skeleton} ${animate ? classes.animated : ''} ${className || ''}`}
      aria-hidden="true"
      data-testid={testId}
    />
  );
});

/**
 * EMRCardSkeleton - Skeleton for card components
 *
 * Displays a card-shaped skeleton with header and content areas.
 *
 * @example
 * ```tsx
 * {isLoading ? <EMRCardSkeleton /> : <MyCard data={data} />}
 * ```
 */
export interface EMRCardSkeletonProps extends EMRSkeletonBaseProps {
  /** Show header area with icon/avatar */
  showHeader?: boolean;
  /** Show footer buttons */
  showFooter?: boolean;
  /** Number of content lines */
  contentLines?: number;
  /** Card height */
  height?: number | string;
  /** Card width */
  width?: number | string;
}

export const EMRCardSkeleton = memo(function EMRCardSkeleton({
  showHeader = true,
  showFooter = false,
  contentLines = 3,
  height,
  width,
  animate = true,
  className,
  'aria-label': ariaLabel = 'Loading card...',
  'data-testid': testId = 'emr-card-skeleton',
}: EMRCardSkeletonProps): React.ReactElement {
  const widths = ['100%', '90%', '75%', '85%', '60%'];

  return (
    <Box
      className={`${classes.card} ${animate ? classes.animated : ''} ${className || ''}`}
      style={{ height, width }}
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
      data-testid={testId}
    >
      {showHeader && (
        <Group gap="sm" mb="sm">
          <Skeleton height={40} width={40} radius="md" animate={animate} className={classes.skeleton} />
          <Stack gap="xs" style={{ flex: 1 }}>
            <Skeleton height={14} width="60%" radius="sm" animate={animate} className={classes.skeleton} />
            <Skeleton height={12} width="40%" radius="sm" animate={animate} className={classes.skeleton} />
          </Stack>
        </Group>
      )}

      <Stack gap="xs">
        {Array.from({ length: contentLines }).map((_, i) => (
          <Skeleton
            key={`content-line-${i}`}
            height={12}
            width={widths[i % widths.length]}
            radius="sm"
            animate={animate}
            className={classes.skeleton}
          />
        ))}
      </Stack>

      {showFooter && (
        <Group gap="sm" mt="md" justify="flex-end">
          <Skeleton height={32} width={80} radius="md" animate={animate} className={classes.skeleton} />
          <Skeleton height={32} width={80} radius="md" animate={animate} className={classes.skeleton} />
        </Group>
      )}
    </Box>
  );
});

/**
 * EMRTableRowSkeleton - Skeleton rows for tables
 *
 * Renders skeleton rows with configurable column count.
 * Use inside a table body to show loading state.
 *
 * @example
 * ```tsx
 * <Table>
 *   <Table.Tbody>
 *     {isLoading ? (
 *       <EMRTableRowSkeleton rows={5} columns={6} />
 *     ) : (
 *       data.map(item => <TableRow key={item.id} {...item} />)
 *     )}
 *   </Table.Tbody>
 * </Table>
 * ```
 */
export interface EMRTableRowSkeletonProps extends EMRSkeletonBaseProps {
  /** Number of rows to display */
  rows?: number;
  /** Number of columns per row */
  columns?: number;
  /** Show checkbox column */
  showCheckbox?: boolean;
  /** Show actions column */
  showActions?: boolean;
  /** Column widths (array of percentages or fixed values) */
  columnWidths?: (string | number)[];
  /** Compact mode for dense tables */
  compact?: boolean;
}

export const EMRTableRowSkeleton = memo(function EMRTableRowSkeleton({
  rows = 5,
  columns = 4,
  showCheckbox = false,
  showActions = false,
  columnWidths,
  compact = false,
  animate = true,
  'aria-label': ariaLabel = 'Loading table data...',
  'data-testid': testId = 'emr-table-row-skeleton',
}: EMRTableRowSkeletonProps): React.ReactElement {
  const defaultWidths = ['60%', '80%', '70%', '90%', '50%', '75%'];
  const cellPadding = compact ? '8px 12px' : '12px 16px';

  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <Table.Tr
          key={`skeleton-row-${rowIndex}`}
          data-testid={`${testId}-row-${rowIndex}`}
          style={{
            backgroundColor: rowIndex % 2 === 0 ? 'var(--emr-bg-card)' : 'var(--emr-bg-hover)',
          }}
        >
          {/* Checkbox column */}
          {showCheckbox && (
            <Table.Td style={{ padding: cellPadding, width: 48, textAlign: 'center' }}>
              <Skeleton
                height={18}
                width={18}
                radius="sm"
                animate={animate}
                className={classes.skeleton}
                style={{ margin: '0 auto' }}
              />
            </Table.Td>
          )}

          {/* Data columns */}
          {Array.from({ length: columns }).map((_, colIndex) => {
            const width = columnWidths?.[colIndex] || defaultWidths[colIndex % defaultWidths.length];
            return (
              <Table.Td key={`cell-${rowIndex}-${colIndex}`} style={{ padding: cellPadding }}>
                <Skeleton height={14} width={width} radius="sm" animate={animate} className={classes.skeleton} />
              </Table.Td>
            );
          })}

          {/* Actions column */}
          {showActions && (
            <Table.Td style={{ padding: cellPadding, width: 100, textAlign: 'center' }}>
              <Group gap="xs" justify="center">
                <Skeleton height={28} width={28} radius="sm" animate={animate} className={classes.skeleton} />
                <Skeleton height={28} width={28} radius="sm" animate={animate} className={classes.skeleton} />
              </Group>
            </Table.Td>
          )}
        </Table.Tr>
      ))}
    </>
  );
});

/**
 * EMRTableSkeleton - Full table skeleton with header
 *
 * Renders a complete table skeleton including header row.
 *
 * @example
 * ```tsx
 * {isLoading ? <EMRTableSkeleton rows={5} columns={6} /> : <MyTable data={data} />}
 * ```
 */
export interface EMRTableSkeletonProps extends EMRTableRowSkeletonProps {
  /** Show table header */
  showHeader?: boolean;
}

export const EMRTableSkeleton = memo(function EMRTableSkeleton({
  rows = 5,
  columns = 4,
  showCheckbox = false,
  showActions = false,
  showHeader = true,
  columnWidths,
  compact = false,
  animate = true,
  'aria-label': ariaLabel = 'Loading table...',
  'data-testid': testId = 'emr-table-skeleton',
}: EMRTableSkeletonProps): React.ReactElement {
  const cellPadding = compact ? '8px 12px' : '12px 16px';

  return (
    <Box role="status" aria-label={ariaLabel} aria-busy="true" data-testid={testId}>
      {/* eslint-disable-next-line liverra/require-state-triplet -- skeleton primitive renders tables without data */}
      <Table>
        {showHeader && (
          <Table.Thead>
            <Table.Tr style={{ backgroundColor: 'var(--emr-bg-hover)' }}>
              {showCheckbox && (
                <Table.Th style={{ padding: cellPadding, width: 48 }}>
                  <Skeleton height={18} width={18} radius="sm" animate={animate} className={classes.skeleton} />
                </Table.Th>
              )}
              {Array.from({ length: columns }).map((_, i) => (
                <Table.Th key={`header-col-${i}`} style={{ padding: cellPadding }}>
                  <Skeleton height={16} width="70%" radius="sm" animate={animate} className={classes.skeleton} />
                </Table.Th>
              ))}
              {showActions && (
                <Table.Th style={{ padding: cellPadding, width: 100 }}>
                  <Skeleton height={16} width={60} radius="sm" animate={animate} className={classes.skeleton} />
                </Table.Th>
              )}
            </Table.Tr>
          </Table.Thead>
        )}
        <Table.Tbody>
          <EMRTableRowSkeleton
            rows={rows}
            columns={columns}
            showCheckbox={showCheckbox}
            showActions={showActions}
            columnWidths={columnWidths}
            compact={compact}
            animate={animate}
          />
        </Table.Tbody>
      </Table>
    </Box>
  );
});

/**
 * EMRFormSkeleton - Skeleton for form components
 *
 * Displays form field placeholders while loading.
 *
 * @example
 * ```tsx
 * {isLoading ? (
 *   <EMRFormSkeleton fields={5} showTitle showButtons />
 * ) : (
 *   <MyForm />
 * )}
 * ```
 */
export interface EMRFormSkeletonProps extends EMRSkeletonBaseProps {
  /** Number of form fields to show */
  fields?: number;
  /** Show form title skeleton */
  showTitle?: boolean;
  /** Show submit/cancel buttons */
  showButtons?: boolean;
  /** Variant: 'simple' for basic fields, 'detailed' with descriptions */
  variant?: 'simple' | 'detailed';
  /** Show section headers (for multi-section forms) */
  sections?: number;
}

export const EMRFormSkeleton = memo(function EMRFormSkeleton({
  fields = 4,
  showTitle = true,
  showButtons = true,
  variant = 'simple',
  sections = 0,
  animate = true,
  className,
  'aria-label': ariaLabel = 'Loading form...',
  'data-testid': testId = 'emr-form-skeleton',
}: EMRFormSkeletonProps): React.ReactElement {
  const fieldsPerSection = sections > 0 ? Math.ceil(fields / sections) : fields;

  const renderFields = (count: number, sectionIndex = 0) =>
    Array.from({ length: count }).map((_, i) => (
      <Box key={`form-field-${sectionIndex}-${i}`}>
        {/* Label */}
        <Skeleton
          height={14}
          width={variant === 'detailed' ? '30%' : '25%'}
          radius="sm"
          mb={6}
          animate={animate}
          className={classes.skeleton}
        />
        {/* Description (detailed variant only) */}
        {variant === 'detailed' && (
          <Skeleton height={12} width="50%" radius="sm" mb={8} animate={animate} className={classes.skeleton} />
        )}
        {/* Input */}
        <Skeleton height={44} radius="sm" animate={animate} className={classes.skeleton} />
      </Box>
    ));

  return (
    <Box
      className={`${classes.form} ${animate ? classes.animated : ''} ${className || ''}`}
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
      data-testid={testId}
    >
      <Stack gap="md">
        {/* Title skeleton */}
        {showTitle && (
          <>
            <Skeleton height={28} width="60%" radius="sm" animate={animate} className={classes.skeleton} />
            <Skeleton height={16} width="80%" radius="sm" animate={animate} className={classes.skeleton} />
          </>
        )}

        {/* Sections or single field group */}
        {sections > 0 ? (
          Array.from({ length: sections }).map((_, sectionIndex) => (
            <Stack key={sectionIndex} gap="md">
              {/* Section header */}
              <Skeleton height={20} width="40%" radius="sm" animate={animate} className={classes.skeleton} />
              {/* Section fields */}
              {renderFields(Math.min(fieldsPerSection, fields - sectionIndex * fieldsPerSection))}
            </Stack>
          ))
        ) : (
          <Stack gap="md">{renderFields(fields)}</Stack>
        )}

        {/* Button skeletons */}
        {showButtons && (
          <Group justify="flex-end" gap="md" mt="md">
            <Skeleton height={40} width={120} radius="sm" animate={animate} className={classes.skeleton} />
            <Skeleton height={40} width={100} radius="sm" animate={animate} className={classes.skeleton} />
          </Group>
        )}
      </Stack>
    </Box>
  );
});

/**
 * EMRListSkeleton - Skeleton for list/grid components
 *
 * Displays list item placeholders with icons.
 *
 * @example
 * ```tsx
 * {isLoading ? <EMRListSkeleton items={6} /> : <MyList items={items} />}
 * ```
 */
export interface EMRListSkeletonProps extends EMRSkeletonBaseProps {
  /** Number of list items */
  items?: number;
  /** Show icon/avatar on left */
  showIcon?: boolean;
  /** Show badge/status on right */
  showBadge?: boolean;
  /** Item height */
  itemHeight?: number;
}

export const EMRListSkeleton = memo(function EMRListSkeleton({
  items = 5,
  showIcon = true,
  showBadge = false,
  itemHeight = 48,
  animate = true,
  className,
  'aria-label': ariaLabel = 'Loading list...',
  'data-testid': testId = 'emr-list-skeleton',
}: EMRListSkeletonProps): React.ReactElement {
  const widths = ['85%', '70%', '90%', '75%', '80%'];

  return (
    <Box
      className={`${animate ? classes.animated : ''} ${className || ''}`}
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
      data-testid={testId}
    >
      <Stack gap="xs">
        {Array.from({ length: items }).map((_, i) => (
          <Group key={`list-item-${i}`} gap="sm" className={classes.listItem} style={{ minHeight: itemHeight }}>
            {showIcon && <Skeleton height={32} width={32} radius="md" animate={animate} className={classes.skeleton} />}
            <Stack gap={4} style={{ flex: 1 }}>
              <Skeleton
                height={14}
                width={widths[i % widths.length]}
                radius="sm"
                animate={animate}
                className={classes.skeleton}
              />
              <Skeleton height={12} width="50%" radius="sm" animate={animate} className={classes.skeleton} />
            </Stack>
            {showBadge && (
              <Skeleton height={22} width={60} radius="xl" animate={animate} className={classes.skeleton} />
            )}
          </Group>
        ))}
      </Stack>
    </Box>
  );
});

/**
 * EMRStatCardSkeleton - Skeleton for stat/metric cards
 *
 * Displays stat card placeholder with value and label.
 *
 * @example
 * ```tsx
 * {isLoading ? <EMRStatCardSkeleton /> : <EMRStatCard {...statData} />}
 * ```
 */
export interface EMRStatCardSkeletonProps extends EMRSkeletonBaseProps {
  /** Show icon */
  showIcon?: boolean;
  /** Show trend indicator */
  showTrend?: boolean;
}

export const EMRStatCardSkeleton = memo(function EMRStatCardSkeleton({
  showIcon = true,
  showTrend = false,
  animate = true,
  className,
  'aria-label': ariaLabel = 'Loading statistic...',
  'data-testid': testId = 'emr-stat-card-skeleton',
}: EMRStatCardSkeletonProps): React.ReactElement {
  return (
    <Box
      className={`${classes.statCard} ${animate ? classes.animated : ''} ${className || ''}`}
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
      data-testid={testId}
    >
      <Group justify="space-between" align="flex-start" mb="sm">
        <Stack gap={4} style={{ flex: 1 }}>
          <Skeleton height={12} width="50%" radius="sm" animate={animate} className={classes.skeleton} />
          <Skeleton height={32} width="40%" radius="sm" animate={animate} className={classes.skeleton} />
        </Stack>
        {showIcon && <Skeleton height={40} width={40} radius="md" animate={animate} className={classes.skeleton} />}
      </Group>
      {showTrend && (
        <Group gap="xs">
          <Skeleton height={16} width={50} radius="sm" animate={animate} className={classes.skeleton} />
          <Skeleton height={12} width={80} radius="sm" animate={animate} className={classes.skeleton} />
        </Group>
      )}
    </Box>
  );
});

/**
 * EMRGridSkeleton - Grid of skeleton items
 *
 * Displays a responsive grid of skeleton cards.
 *
 * @example
 * ```tsx
 * {isLoading ? <EMRGridSkeleton items={6} columns={3} /> : <MyGrid items={items} />}
 * ```
 */
export interface EMRGridSkeletonProps extends EMRSkeletonBaseProps {
  /** Number of grid items */
  items?: number;
  /** Number of columns (responsive) */
  columns?: { base?: number; sm?: number; md?: number; lg?: number };
  /** Item height */
  itemHeight?: number | string;
  /** Gap between items */
  gap?: 'xs' | 'sm' | 'md' | 'lg';
}

export const EMRGridSkeleton = memo(function EMRGridSkeleton({
  items = 6,
  columns = { base: 1, sm: 2, md: 3, lg: 4 },
  itemHeight = 180,
  gap = 'md',
  animate = true,
  className,
  'aria-label': ariaLabel = 'Loading grid...',
  'data-testid': testId = 'emr-grid-skeleton',
}: EMRGridSkeletonProps): React.ReactElement {
  const gapValue = { xs: 8, sm: 12, md: 16, lg: 24 }[gap];

  return (
    <Box
      className={`${animate ? classes.animated : ''} ${className || ''}`}
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
      data-testid={testId}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns.base || 1}, 1fr)`,
        gap: gapValue,
      }}
    >
      {Array.from({ length: items }).map((_, i) => (
        <EMRCardSkeleton key={`grid-card-${i}`} height={itemHeight} animate={animate} />
      ))}
    </Box>
  );
});

export default EMRSkeleton;
