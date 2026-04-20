// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { ActionIcon, Badge, Box, Group, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import type { ComponentType, ReactNode } from 'react';

/**
 * Props for the icon component
 */
export interface IconProps {
  size?: number | string;
  stroke?: number;
}

/**
 * Badge variant type
 */
export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'error';

/**
 * Spacing size type
 */
export type SpacingSize = 'none' | 'sm' | 'md' | 'lg';

/**
 * Badge configuration
 */
export interface EMRPageHeaderBadge {
  count: number;
  label?: string;
  variant?: BadgeVariant;
}

/**
 * Props for EMRPageHeader component
 */
export interface EMRPageHeaderProps {
  /** Icon component to display. Optional — header renders without the icon tile when omitted. */
  icon?: ComponentType<IconProps>;
  /** Page title */
  title: string;
  /** Optional subtitle */
  subtitle?: string;
  /** Optional badge configuration */
  badge?: EMRPageHeaderBadge;
  /** Optional action buttons */
  actions?: ReactNode;
  /** Show back button */
  showBack?: boolean;
  /** Back button click handler */
  onBack?: () => void;
  /** Optional count to display as badge */
  count?: number;
  /** Spacing size */
  spacing?: SpacingSize;
  /** Test ID */
  'data-testid'?: string;
}

/**
 * Get badge styles based on variant using CSS variables
 */
function getBadgeStyles(variant: BadgeVariant = 'default'): {
  color: string;
  bgAlpha: string;
  borderAlpha: string;
  glowColor: string;
} {
  const styleMap: Record<
    BadgeVariant,
    { color: string; bgAlpha: string; borderAlpha: string; glowColor: string }
  > = {
    default: {
      color: 'var(--emr-secondary)',
      bgAlpha: 'var(--emr-secondary-alpha-10)',
      borderAlpha: 'var(--emr-secondary-alpha-20)',
      glowColor: 'var(--emr-secondary-alpha-15)',
    },
    primary: {
      color: 'var(--emr-accent)',
      bgAlpha: 'var(--emr-secondary-alpha-10)',
      borderAlpha: 'var(--emr-secondary-alpha-20)',
      glowColor: 'var(--emr-secondary-alpha-15)',
    },
    success: {
      color: 'var(--emr-success)',
      bgAlpha: 'var(--emr-success-alpha-10)',
      borderAlpha: 'var(--emr-success-alpha-20)',
      glowColor: 'var(--emr-success-alpha-15)',
    },
    warning: {
      color: 'var(--emr-warning)',
      bgAlpha: 'var(--emr-warning-alpha-10)',
      borderAlpha: 'var(--emr-warning-alpha-20)',
      glowColor: 'var(--emr-warning-alpha-15)',
    },
    error: {
      color: 'var(--emr-error)',
      bgAlpha: 'var(--emr-error-alpha-10)',
      borderAlpha: 'var(--emr-error-alpha-20)',
      glowColor: 'var(--emr-error-alpha-15)',
    },
  };
  return styleMap[variant];
}

/**
 * Get spacing in pixels based on size
 */
function getSpacing(size: SpacingSize = 'md'): string {
  const spacingMap: Record<SpacingSize, string> = {
    none: '0px',
    sm: '12px',
    md: '20px',
    lg: '32px',
  };
  return spacingMap[size];
}

/**
 * EMRPageHeader - Premium page header for EMR application
 *
 * Features:
 * - Elegant container with glassmorphism effect
 * - Icon with gradient background and subtle glow
 * - Title and subtitle with refined typography
 * - Optional badge with variant colors and soft glow
 * - Optional action buttons slot
 * - Optional back button with hover effects
 * - Responsive mobile-first design
 * - Smooth transitions on all interactive elements
 * - Uses CSS variables from theme.css
 *
 * @example
 * ```tsx
 * <EMRPageHeader
 *   icon={IconUser}
 *   title="Patient Management"
 *   subtitle="View and manage patient records"
 *   badge={{ count: 5, label: 'Active', variant: 'success' }}
 *   actions={<Button>Add Patient</Button>}
 *   showBack
 *   onBack={() => navigate(-1)}
 * />
 * ```
 */
export function EMRPageHeader({
  icon: Icon,
  title,
  subtitle,
  badge,
  actions,
  showBack,
  onBack,
  spacing = 'md',
  'data-testid': dataTestId = 'emr-page-header',
}: EMRPageHeaderProps): React.ReactElement {
  const badgeStyles = badge ? getBadgeStyles(badge.variant) : null;

  return (
    <Box
      data-testid={dataTestId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        flexWrap: 'wrap',
        marginBottom: getSpacing(spacing),
        padding: '16px 20px',
        background: 'var(--emr-bg-card)',
        borderRadius: 'var(--emr-border-radius-xl)',
        border: '1px solid var(--emr-border-color)',
        boxShadow: 'var(--emr-shadow-card)',
        position: 'relative',
        overflow: 'hidden',
        transition: 'box-shadow var(--emr-transition-base), border-color var(--emr-transition-base)',
      }}
    >
      {/* Subtle gradient overlay for depth */}
      <Box
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(135deg, var(--emr-secondary-alpha-02) 0%, transparent 50%, var(--emr-accent-alpha-02) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Back Button */}
      {showBack && (
        <ActionIcon
          data-testid={`${dataTestId}-back`}
          onClick={onBack}
          aria-label="Go back"
          size={40}
          variant="subtle"
          radius="md"
          style={{
            color: 'var(--emr-text-secondary)',
            background: 'var(--emr-gray-alpha-04)',
            border: '1px solid transparent',
            transition:
              'all var(--emr-transition-base), transform var(--emr-transition-fast)',
            position: 'relative',
            zIndex: 1,
            flexShrink: 0,
          }}
          styles={{
            root: {
              '&:hover': {
                background: 'var(--emr-secondary-alpha-08)',
                color: 'var(--emr-secondary)',
                borderColor: 'var(--emr-secondary-alpha-15)',
                transform: 'translateX(-2px)',
              },
              '&:active': {
                transform: 'translateX(-1px) scale(0.98)',
              },
            },
          }}
        >
          <IconArrowLeft size={20} stroke={2} />
        </ActionIcon>
      )}

      {/* Icon with Premium Gradient Background — skipped when no icon provided. */}
      {Icon && (
        <Box
          data-testid={`${dataTestId}-icon`}
          style={{
            width: 52,
            height: 52,
            borderRadius: 'var(--emr-border-radius-lg)',
            background: 'var(--emr-gradient-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--emr-text-inverse)',
            boxShadow:
              '0 4px 12px var(--emr-secondary-alpha-30), 0 2px 4px var(--emr-primary-alpha-20), inset 0 1px 0 var(--emr-white-alpha-20)',
            position: 'relative',
            zIndex: 1,
            flexShrink: 0,
            transition: 'transform var(--emr-transition-base), box-shadow var(--emr-transition-base)',
          }}
        >
          {/* Inner glow effect */}
          <Box
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 'inherit',
              background:
                'radial-gradient(circle at 30% 30%, var(--emr-white-alpha-25) 0%, transparent 60%)',
              pointerEvents: 'none',
            }}
          />
          <Icon size={26} stroke={1.8} />
        </Box>
      )}

      {/* Title and Subtitle */}
      <Box
        style={{
          flex: '1 1 auto',
          minWidth: '180px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <Group gap="sm" wrap="nowrap" align="center">
          <Title
            order={1}
            data-testid={`${dataTestId}-title`}
            style={{
              fontSize: 'var(--emr-font-xl)',
              fontWeight: 'var(--emr-font-semibold)',
              color: 'var(--emr-text-primary)',
              margin: 0,
              lineHeight: 'var(--emr-line-height-1-2)',
              letterSpacing: 'var(--emr-letter-spacing-tight)',
            }}
          >
            {title}
          </Title>

          {/* Badge with glow effect */}
          {badge && badgeStyles && (
            <Badge
              data-testid={`${dataTestId}-badge`}
              variant="light"
              radius="xl"
              style={{
                backgroundColor: badgeStyles.bgAlpha,
                color: badgeStyles.color,
                fontWeight: 'var(--emr-font-semibold)',
                fontSize: 'var(--emr-font-xs)',
                padding: '5px 14px',
                border: `1px solid ${badgeStyles.borderAlpha}`,
                boxShadow: `0 2px 8px ${badgeStyles.glowColor}`,
                letterSpacing: 'var(--emr-letter-spacing-wide)',
                textTransform: 'none',
                transition: 'all var(--emr-transition-base)',
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
            >
              {badge.count}
              {badge.label && ` ${badge.label}`}
            </Badge>
          )}
        </Group>

        {/* Subtitle with refined typography */}
        {subtitle && (
          <Text
            data-testid={`${dataTestId}-subtitle`}
            size="sm"
            style={{
              color: 'var(--emr-text-secondary)',
              fontSize: 'var(--emr-font-sm)',
              marginTop: '4px',
              lineHeight: 'var(--emr-line-height-1-4)',
              letterSpacing: '0.01em',
            }}
          >
            {subtitle}
          </Text>
        )}
      </Box>

      {/* Actions Slot */}
      {actions && (
        <Box
          data-testid={`${dataTestId}-actions`}
          style={{
            marginLeft: 'auto',
            display: 'flex',
            gap: '10px',
            alignItems: 'center',
            position: 'relative',
            zIndex: 1,
            flexShrink: 0,
          }}
        >
          {actions}
        </Box>
      )}
    </Box>
  );
}
