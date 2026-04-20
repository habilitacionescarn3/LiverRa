// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Skeleton, Stack, Group, Box } from '@mantine/core';

/**
 * Props for FormLoadingSkeleton
 */
export interface FormLoadingSkeletonProps {
  /** Number of field skeletons to show */
  fieldCount?: number;
  /** Whether to show form title skeleton */
  showTitle?: boolean;
  /** Whether to show submit button skeleton */
  showButtons?: boolean;
  /** Variant: 'simple' for basic forms, 'detailed' for complex forms */
  variant?: 'simple' | 'detailed';
}

/**
 * FormLoadingSkeleton Component
 *
 * Loading skeleton for form components while data is being fetched.
 * Matches the visual structure of FormRenderer for smooth transitions.
 *
 * Features:
 * - Configurable number of field skeletons
 * - Two variants: simple and detailed
 * - Accessible loading state announcement
 * - Mobile-responsive design
 *
 * @param root0
 * @param root0.fieldCount
 * @param root0.showTitle
 * @param root0.showButtons
 * @param root0.variant
 * @example
 * ```tsx
 * {isLoading ? (
 *   <FormLoadingSkeleton fieldCount={5} showTitle />
 * ) : (
 *   <FormRenderer questionnaire={questionnaire} />
 * )}
 * ```
 */
export function FormLoadingSkeleton({
  fieldCount = 4,
  showTitle = true,
  showButtons = true,
  variant = 'simple',
}: FormLoadingSkeletonProps): React.ReactElement {
  return (
    <Box
      role="status"
      aria-label="Loading form..."
      aria-busy="true"
      data-testid="form-loading-skeleton"
    >
      <Stack gap="md">
        {/* Title skeleton */}
        {showTitle && (
          <>
            <Skeleton height={28} width="60%" radius="sm" />
            <Skeleton height={16} width="80%" radius="sm" />
          </>
        )}

        {/* Field skeletons */}
        {Array.from({ length: fieldCount }).map((_, index) => (
          <FieldSkeleton key={index} variant={variant} />
        ))}

        {/* Button skeletons */}
        {showButtons && (
          <Group justify="flex-end" gap="md" mt="md">
            <Skeleton height={40} width={120} radius="sm" />
            <Skeleton height={40} width={100} radius="sm" />
          </Group>
        )}
      </Stack>
    </Box>
  );
}

/**
 * Individual field skeleton
 * @param root0
 * @param root0.variant
 */
function FieldSkeleton({ variant }: { variant: 'simple' | 'detailed' }): React.ReactElement {
  if (variant === 'detailed') {
    return (
      <Box>
        {/* Label */}
        <Skeleton height={14} width="30%" radius="sm" mb={6} />
        {/* Description (sometimes) */}
        <Skeleton height={12} width="50%" radius="sm" mb={8} />
        {/* Input */}
        <Skeleton height={44} radius="sm" />
      </Box>
    );
  }

  // Simple variant
  return (
    <Box>
      {/* Label */}
      <Skeleton height={14} width="25%" radius="sm" mb={6} />
      {/* Input */}
      <Skeleton height={44} radius="sm" />
    </Box>
  );
}

/**
 * FormBuilderLoadingSkeleton Component
 *
 * Loading skeleton for form builder layout while data is being fetched.
 * Shows three-panel layout skeleton.
 */
export function FormBuilderLoadingSkeleton(): React.ReactElement {
  return (
    <Box
      role="status"
      aria-label="Loading form builder..."
      aria-busy="true"
      data-testid="form-builder-loading-skeleton"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {/* Header skeleton */}
      <Box
        style={{
          padding: 'var(--mantine-spacing-md)',
          borderBottom: '1px solid var(--emr-border-color)',
        }}
      >
        <Group justify="space-between">
          <Skeleton height={36} width={200} radius="sm" />
          <Group gap="sm">
            <Skeleton height={36} width={80} radius="sm" />
            <Skeleton height={36} width={100} radius="sm" />
          </Group>
        </Group>
      </Box>

      {/* Three-panel layout skeleton */}
      <Box style={{ flex: 1, display: 'flex', gap: '1px', backgroundColor: 'var(--emr-border-color)' }}>
        {/* Left panel - Field palette */}
        <Box style={{ width: '20%', backgroundColor: 'var(--emr-bg-card)', padding: 'var(--mantine-spacing-md)' }}>
          <Skeleton height={24} width="80%" radius="sm" mb="md" />
          <Skeleton height={36} width="100%" radius="sm" mb="md" />
          <Stack gap="xs">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} height={44} radius="sm" />
            ))}
          </Stack>
        </Box>

        {/* Center panel - Canvas */}
        <Box style={{ flex: 1, backgroundColor: 'var(--emr-bg-card)', padding: 'var(--mantine-spacing-md)' }}>
          <Skeleton height={24} width="40%" radius="sm" mb="md" />
          <Box
            style={{
              border: '2px dashed var(--emr-border-color)',
              borderRadius: 'var(--mantine-radius-md)',
              padding: 'var(--mantine-spacing-md)',
              minHeight: '400px',
            }}
          >
            <Stack gap="sm">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} height={60} radius="sm" />
              ))}
            </Stack>
          </Box>
        </Box>

        {/* Right panel - Properties */}
        <Box style={{ width: '25%', backgroundColor: 'var(--emr-bg-card)', padding: 'var(--mantine-spacing-md)' }}>
          <Skeleton height={24} width="80%" radius="sm" mb="md" />
          <Stack gap="md">
            {Array.from({ length: 4 }).map((_, i) => (
              <Box key={i}>
                <Skeleton height={12} width="40%" radius="sm" mb={4} />
                <Skeleton height={36} radius="sm" />
              </Box>
            ))}
          </Stack>
        </Box>
      </Box>
    </Box>
  );
}

export default FormLoadingSkeleton;
