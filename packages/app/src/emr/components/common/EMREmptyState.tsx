// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Anchor, Box, Button, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconFilter,
  IconInbox,
  IconSearch,
} from '@tabler/icons-react';
import type { ComponentType, ReactNode } from 'react';

/** Icon props type for Tabler icons */
interface IconProps {
  size?: number | string;
  stroke?: number;
  color?: string;
}

/** Size variants for the empty state */
export type EMREmptyStateSize = 'sm' | 'md' | 'lg';

/** Visual variants for the empty state */
export type EMREmptyStateVariant = 'default' | 'search' | 'error' | 'filtered';

/** Action button configuration */
export interface EMREmptyStateAction {
  /** Button label */
  label: string;
  /** Click handler */
  onClick: () => void;
  /** Optional icon */
  icon?: ComponentType<IconProps>;
  /** Button variant: primary for main actions, secondary for alternatives */
  variant?: 'primary' | 'secondary';
}

/** Secondary link configuration */
export interface EMREmptyStateLink {
  /** Link label */
  label: string;
  /** Click handler or href */
  onClick?: () => void;
  href?: string;
}

/**
 * Props for EMREmptyState component
 */
export interface EMREmptyStateProps {
  /** Custom icon to display (overrides variant default and illustration) */
  icon?: ComponentType<IconProps>;
  /** Custom illustration (image URL or React component) - takes precedence over icon */
  illustration?: string | ReactNode;
  /** Main title text */
  title: string;
  /** Optional description text */
  description?: string | ReactNode;
  /** Optional action button (legacy format still supported) */
  action?: EMREmptyStateAction | {
    label: string;
    onClick: () => void;
    icon?: ComponentType<IconProps>;
  };
  /** Optional secondary action link */
  secondaryAction?: EMREmptyStateLink;
  /** Size variant: sm, md (default), lg */
  size?: EMREmptyStateSize;
  /** Visual variant: default, search, error, filtered */
  variant?: EMREmptyStateVariant;
  /** Test ID for testing */
  'data-testid'?: string;
  /** Custom class name */
  className?: string;
}

/** Icon sizes for each size variant */
const iconSizes: Record<EMREmptyStateSize, number> = {
  sm: 40,
  md: 56,
  lg: 72,
};

/** Title font sizes for each size variant */
const titleSizes: Record<EMREmptyStateSize, string> = {
  sm: 'var(--emr-font-base)',
  md: 'var(--emr-font-lg)',
  lg: 'var(--emr-font-xl)',
};

/** Description font sizes for each size variant */
const descriptionSizes: Record<EMREmptyStateSize, string> = {
  sm: 'var(--emr-font-sm)',
  md: 'var(--emr-font-base)',
  lg: 'var(--emr-font-md)',
};

/** Padding for each size variant */
const paddings: Record<EMREmptyStateSize, string> = {
  sm: '24px',
  md: '40px',
  lg: '56px',
};

/** Default icons for each variant */
const defaultIcons: Record<EMREmptyStateVariant, ComponentType<IconProps>> = {
  default: IconInbox,
  search: IconSearch,
  error: IconAlertCircle,
  filtered: IconFilter,
};

/** Icon colors for each variant */
const iconColors: Record<EMREmptyStateVariant, string> = {
  default: 'var(--emr-text-secondary)',
  search: 'var(--emr-secondary)',
  error: 'var(--emr-error)',
  filtered: 'var(--emr-secondary)',
};

/** Illustration sizes for each size variant */
const illustrationSizes: Record<EMREmptyStateSize, number> = {
  sm: 80,
  md: 120,
  lg: 160,
};

/**
 * EMREmptyState - Consistent empty state component for tables, lists, and search results
 *
 * Features:
 * - Four variants with appropriate icons and colors
 * - Three sizes for different contexts
 * - Custom illustration support (images or React components)
 * - Primary and secondary action buttons
 * - Secondary action link
 * - Mobile-responsive design
 * - Consistent styling across all EMR pages
 *
 * @example
 * ```tsx
 * // Default empty state
 * <EMREmptyState
 *   title="No patients found"
 *   description="There are no patients registered yet."
 * />
 *
 * // With illustration
 * <EMREmptyState
 *   illustration="/images/empty-inbox.svg"
 *   title="No messages"
 *   description="You have no new messages"
 * />
 *
 * // With primary action and secondary link
 * <EMREmptyState
 *   variant="search"
 *   title="No results found"
 *   description="Try adjusting your search criteria"
 *   action={{
 *     label: "Create New",
 *     onClick: handleCreate,
 *     variant: 'primary',
 *   }}
 *   secondaryAction={{
 *     label: "Learn more",
 *     href: "/help/search",
 *   }}
 * />
 *
 * // Error variant with retry
 * <EMREmptyState
 *   variant="error"
 *   title="Failed to load data"
 *   description="An error occurred while fetching data"
 *   action={{
 *     label: "Try again",
 *     onClick: handleRetry,
 *   }}
 * />
 * ```
 */
export function EMREmptyState({
  icon,
  illustration,
  title,
  description,
  action,
  secondaryAction,
  size = 'md',
  variant = 'default',
  'data-testid': testId,
  className,
}: EMREmptyStateProps): React.ReactElement {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const IconComponent = icon || defaultIcons[variant];
  const iconSize = iconSizes[size];
  const iconColor = iconColors[variant];
  const titleSize = titleSizes[size];
  const descSize = descriptionSizes[size];
  const padding = paddings[size];
  const illustrationSize = illustrationSizes[size];

  // Check if action has primary variant
  const actionVariant = (action as EMREmptyStateAction)?.variant;
  const isPrimaryAction = actionVariant === 'primary';

  // Mobile adjustments
  const mobileReducedPadding = isMobile ? '24px' : padding;
  const maxDescWidth = isMobile ? '100%' : '400px';

  return (
    <Box
      data-testid={testId}
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: mobileReducedPadding,
        textAlign: 'center',
        width: '100%',
      }}
    >
      <Stack align="center" gap="md" style={{ width: '100%', maxWidth: isMobile ? '100%' : '480px' }}>
        {/* Illustration or Icon */}
        {illustration ? (
          <Box
            style={{
              width: illustrationSize,
              height: illustrationSize,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            data-testid={testId ? `${testId}-illustration` : 'emr-empty-state-illustration'}
          >
            {typeof illustration === 'string' ? (
              <img
                loading="lazy"
                src={illustration}
                alt=""
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                }}
              />
            ) : (
              illustration
            )}
          </Box>
        ) : (
          <Box
            style={{
              width: iconSize * 1.5,
              height: iconSize * 1.5,
              borderRadius: '50%',
              background: 'var(--emr-bg-hover)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            data-testid={testId ? `${testId}-icon` : 'emr-empty-state-icon'}
          >
            <IconComponent
              size={iconSize}
              stroke={1.5}
              color={iconColor}
            />
          </Box>
        )}

        {/* Text content */}
        <Stack align="center" gap="xs">
          <Text
            fw={600}
            style={{
              fontSize: isMobile ? 'var(--emr-font-md)' : titleSize,
              color: 'var(--emr-text-primary)',
              lineHeight: 'var(--emr-line-height-1-3)',
            }}
          >
            {title}
          </Text>
          {description && (
            <Text
              style={{
                fontSize: isMobile ? 'var(--emr-font-sm)' : descSize,
                color: 'var(--emr-text-secondary)',
                maxWidth: maxDescWidth,
                lineHeight: 'var(--emr-line-height-base)',
              }}
            >
              {description}
            </Text>
          )}
        </Stack>

        {/* Actions */}
        {(action || secondaryAction) && (
          <Stack align="center" gap="xs" mt="xs">
            {/* Primary/Secondary Action Button */}
            {action && (
              <Button
                variant={isPrimaryAction ? 'filled' : 'light'}
                onClick={action.onClick}
                leftSection={action.icon ? <action.icon size={16} stroke={2} /> : undefined}
                size={isMobile ? 'md' : 'sm'}
                style={{
                  borderRadius: 'var(--emr-border-radius)',
                  background: isPrimaryAction ? 'var(--emr-gradient-primary)' : undefined,
                  minHeight: isMobile ? 44 : undefined,
                }}
                data-testid={testId ? `${testId}-action` : 'emr-empty-state-action'}
              >
                {action.label}
              </Button>
            )}

            {/* Secondary Link */}
            {secondaryAction && (
              <Anchor
                component={secondaryAction.href ? 'a' : 'button'}
                href={secondaryAction.href}
                onClick={secondaryAction.onClick}
                size="sm"
                c="var(--emr-secondary)"
                style={{
                  textDecoration: 'underline',
                  textUnderlineOffset: 3,
                  cursor: 'pointer',
                  background: 'none',
                  border: 'none',
                  minHeight: isMobile ? 44 : undefined,
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
                data-testid={testId ? `${testId}-secondary-action` : 'emr-empty-state-secondary-action'}
              >
                {secondaryAction.label}
              </Anchor>
            )}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

export default EMREmptyState;
