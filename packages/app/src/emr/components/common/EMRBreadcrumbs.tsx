// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRBreadcrumbs Component
 *
 * Responsive breadcrumb navigation that:
 * - Shows full path on desktop
 * - Collapses to back button + current page on mobile
 * - Supports proper ARIA navigation
 * - Uses theme CSS variables
 *
 * @example
 * ```tsx
 * <EMRBreadcrumbs
 *   items={[
 *     { label: 'Dashboard', href: '/emr/dashboard' },
 *     { label: 'Patients', href: '/emr/patients' },
 *     { label: 'John Doe' }
 *   ]}
 * />
 * ```
 */

import React from 'react';
import { Anchor, Box, Breadcrumbs, Text, ActionIcon } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconChevronLeft, IconChevronRight, IconHome } from '@tabler/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../contexts/TranslationContext';

// ============================================================================
// Types
// ============================================================================

export interface BreadcrumbItem {
  /** Display label for the breadcrumb */
  label: string;
  /** Optional href - if not provided, item is considered current/active */
  href?: string;
  /** Optional icon to display before label */
  icon?: React.FC<{ size?: number | string; className?: string }>;
}

export interface EMRBreadcrumbsProps {
  /** Array of breadcrumb items from root to current */
  items: BreadcrumbItem[];
  /** Optional home link (default: /emr) */
  homeHref?: string;
  /** Optional home label */
  homeLabel?: string;
  /** Show home icon as first item */
  showHome?: boolean;
  /** Custom separator */
  separator?: React.ReactNode;
  /** Maximum items to show before collapsing (desktop only) */
  maxItems?: number;
  /** Custom class name */
  className?: string;
}

// ============================================================================
// Constants
// ============================================================================

const MOBILE_BREAKPOINT = '(max-width: 768px)';

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    padding: 'var(--emr-spacing-sm) 0',
  },
  mobileContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--emr-spacing-xs)',
    padding: 'var(--emr-spacing-xs) 0',
  },
  backButton: {
    color: 'var(--emr-primary)',
  },
  link: {
    color: 'var(--emr-text-secondary)',
    fontSize: 'var(--emr-font-md)',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    transition: 'color 0.2s',
    '&:hover': {
      color: 'var(--emr-primary)',
      textDecoration: 'underline',
    },
  },
  activeItem: {
    color: 'var(--emr-text-primary)',
    fontWeight: 'var(--emr-font-medium)',
    fontSize: 'var(--emr-font-md)',
  },
  separator: {
    color: 'var(--emr-text-muted)',
    marginInline: '4px',
  },
  homeIcon: {
    color: 'var(--emr-primary)',
  },
  ellipsis: {
    color: 'var(--emr-text-secondary)',
    padding: '0 4px',
  },
} as const;

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Desktop breadcrumb view with full path
 */
function DesktopBreadcrumbs({
  items,
  homeHref,
  homeLabel,
  showHome,
  separator,
  maxItems,
}: Omit<EMRBreadcrumbsProps, 'className'>) {
  const { t } = useTranslation();

  // Collapse middle items if too many
  const shouldCollapse = maxItems && items.length > maxItems;
  let displayItems = items;

  if (shouldCollapse) {
    const firstItems = items.slice(0, 1);
    const lastItems = items.slice(-(maxItems - 2));
    displayItems = [...firstItems, { label: '...' }, ...lastItems];
  }

  const breadcrumbItems = displayItems.map((item, index) => {
    const isLast = index === displayItems.length - 1;
    const isEllipsis = item.label === '...';

    if (isEllipsis) {
      return (
        <Text key={`ellipsis-${index}`} style={styles.ellipsis}>
          ...
        </Text>
      );
    }

    if (isLast || !item.href) {
      // Current/active item
      return (
        <Text key={item.label} style={styles.activeItem}>
          {item.icon && <item.icon size={14} />}
          {item.label}
        </Text>
      );
    }

    // Navigable item
    return (
      <Anchor
        key={item.label}
        component={Link}
        to={item.href}
        style={styles.link}
      >
        {item.icon && <item.icon size={14} />}
        {item.label}
      </Anchor>
    );
  });

  // Prepend home if requested
  if (showHome) {
    breadcrumbItems.unshift(
      <Anchor
        key="home"
        component={Link}
        to={homeHref || '/emr'}
        style={styles.link}
        aria-label={homeLabel || t('navigation.home')}
      >
        <IconHome size={16} style={styles.homeIcon} />
      </Anchor>
    );
  }

  return (
    <Box style={styles.container}>
      <Breadcrumbs
        separator={separator || <IconChevronRight size={14} style={styles.separator} />}
      >
        {breadcrumbItems}
      </Breadcrumbs>
    </Box>
  );
}

/**
 * Mobile breadcrumb view with back button + current page
 */
function MobileBreadcrumbs({
  items,
  homeHref,
}: Pick<EMRBreadcrumbsProps, 'items' | 'homeHref'>) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Get the previous item to navigate back to
  const previousItem = items.length > 1 ? items[items.length - 2] : null;
  const currentItem = items[items.length - 1];

  const handleBack = () => {
    if (previousItem?.href) {
      navigate(previousItem.href);
    } else {
      navigate(-1);
    }
  };

  return (
    <Box style={styles.mobileContainer}>
      <ActionIcon
        variant="subtle"
        size="md"
        onClick={handleBack}
        aria-label={t('navigation.back')}
        style={styles.backButton}
      >
        <IconChevronLeft size={20} />
      </ActionIcon>

      <Text
        size="sm"
        fw={500}
        style={{ color: 'var(--emr-text-primary)' }}
        lineClamp={1}
      >
        {currentItem?.label || t('navigation.back')}
      </Text>
    </Box>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Responsive breadcrumb navigation
 */
export function EMRBreadcrumbs({
  items,
  homeHref = '/emr',
  homeLabel,
  showHome = false,
  separator,
  maxItems = 5,
  className,
}: EMRBreadcrumbsProps): React.ReactElement {
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);

  // Ensure we have valid items
  if (!items || items.length === 0) {
    return <Box className={className} />;
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className={className}
    >
      {isMobile ? (
        <MobileBreadcrumbs items={items} homeHref={homeHref} />
      ) : (
        <DesktopBreadcrumbs
          items={items}
          homeHref={homeHref}
          homeLabel={homeLabel}
          showHome={showHome}
          separator={separator}
          maxItems={maxItems}
        />
      )}
    </nav>
  );
}

// ============================================================================
// Hook for building breadcrumbs from route
// ============================================================================

/**
 * Hook to build breadcrumb items from current location
 *
 * @param routeLabels - Map of route paths to labels
 * @returns Array of breadcrumb items
 *
 * @example
 * ```tsx
 * const routeLabels = {
 *   '/emr': 'EMR',
 *   '/emr/registration': 'Registration',
 *   '/emr/patient-history': 'Patient History',
 * };
 * const items = useBreadcrumbsFromRoute(routeLabels);
 * return <EMRBreadcrumbs items={items} />;
 * ```
 */
export function useBreadcrumbsFromRoute(
  routeLabels: Record<string, string>,
  pathname?: string
): BreadcrumbItem[] {
  // This would typically use useLocation from react-router-dom
  // For now, return an empty array as the hook would need to be
  // implemented based on specific route structure
  return [];
}

export default EMRBreadcrumbs;
