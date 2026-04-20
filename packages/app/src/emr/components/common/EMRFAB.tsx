// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Box, Tooltip } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import type { ComponentType } from 'react';
import { useState, useCallback, useEffect } from 'react';
import classes from './EMRFAB.module.css';

/** Icon props type for Tabler icons */
interface IconProps {
  size?: number | string;
  stroke?: number;
  color?: string;
}

/** Size variants for FAB */
export type EMRFABSize = 'sm' | 'md' | 'lg';

/** Color variants for FAB */
export type EMRFABColor = 'primary' | 'secondary' | 'success' | 'error' | 'warning';

/**
 * Action item for expandable FAB
 */
export interface EMRFABAction {
  /** Unique key for the action */
  key: string;
  /** Display label */
  label: string;
  /** Icon component */
  icon: ComponentType<IconProps>;
  /** Click handler */
  onClick: () => void;
  /** Color variant */
  color?: EMRFABColor;
  /** Whether action is disabled */
  disabled?: boolean;
}

/**
 * Props for EMRFAB component
 */
export interface EMRFABProps {
  /** Icon for the FAB (default: IconPlus) */
  icon?: ComponentType<IconProps>;
  /** Click handler for single action FAB */
  onClick?: () => void;
  /** Tooltip label */
  label?: string;
  /** Size variant */
  size?: EMRFABSize;
  /** Color variant */
  color?: EMRFABColor;
  /** Multiple actions (renders expandable FAB) */
  actions?: EMRFABAction[];
  /** Whether the FAB is visible */
  visible?: boolean;
  /** Position from bottom edge */
  bottom?: number | string;
  /** Position from right edge */
  right?: number | string;
  /** Z-index */
  zIndex?: number;
  /** Extended label (renders extended FAB with text) */
  extended?: boolean;
  /** Extended label text */
  extendedLabel?: string;
  /** Whether to animate on mount */
  animated?: boolean;
  /** Whether to hide when scrolling down */
  hideOnScroll?: boolean;
  /** Test ID for testing */
  testId?: string;
}

/** Size configurations */
const sizeConfig: Record<EMRFABSize, { size: number; iconSize: number; miniSize: number; miniIconSize: number }> = {
  sm: { size: 48, iconSize: 22, miniSize: 40, miniIconSize: 18 },
  md: { size: 56, iconSize: 26, miniSize: 44, miniIconSize: 20 },
  lg: { size: 64, iconSize: 30, miniSize: 48, miniIconSize: 22 },
};

/** Color to CSS variable mapping */
const colorMap: Record<EMRFABColor, string> = {
  primary: 'var(--emr-gradient-primary)',
  secondary: 'linear-gradient(135deg, var(--emr-secondary) 0%, var(--emr-accent) 100%)',
  success: 'var(--emr-gradient-success)',
  error: 'var(--emr-gradient-error)',
  warning: 'var(--emr-gradient-warning)',
};

/**
 * EMRFAB - Floating Action Button component
 *
 * Features:
 * - Fixed position with safe area support
 * - Single action or expandable multi-action menu
 * - Extended variant with label
 * - Multiple sizes and color variants
 * - Hover and touch interactions
 * - Hide on scroll option
 * - Accessible with keyboard navigation
 *
 * @example
 * ```tsx
 * // Single action FAB
 * <EMRFAB
 *   label="Add Patient"
 *   icon={IconUserPlus}
 *   onClick={() => openAddPatient()}
 * />
 *
 * // Multi-action FAB
 * <EMRFAB
 *   actions={[
 *     { key: 'add', label: 'Add Item', icon: IconPlus, onClick: handleAdd },
 *     { key: 'scan', label: 'Scan', icon: IconScan, onClick: handleScan },
 *   ]}
 * />
 *
 * // Extended FAB with label
 * <EMRFAB
 *   extended
 *   extendedLabel="Create New"
 *   icon={IconPlus}
 *   onClick={handleCreate}
 * />
 * ```
 */
export function EMRFAB({
  icon: IconComponent = IconPlus,
  onClick,
  label,
  size = 'md',
  color = 'primary',
  actions,
  visible = true,
  bottom = 24,
  right = 24,
  zIndex = 999,
  extended = false,
  extendedLabel,
  animated = true,
  hideOnScroll = false,
  testId = 'emr-fab',
}: EMRFABProps): React.ReactElement | null {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [lastScrollY, setLastScrollY] = useState(0);

  const config = sizeConfig[size];
  const hasMultipleActions = actions && actions.length > 0;

  // Handle scroll to hide FAB
  useEffect(() => {
    if (!hideOnScroll) {
      return;
    }

    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      if (currentScrollY > lastScrollY && currentScrollY > 100) {
        setIsHidden(true);
      } else {
        setIsHidden(false);
      }
      setLastScrollY(currentScrollY);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [hideOnScroll, lastScrollY]);

  // Handle click
  const handleClick = useCallback(() => {
    if (hasMultipleActions) {
      setIsExpanded((prev) => !prev);
    } else if (onClick) {
      onClick();
    }
  }, [hasMultipleActions, onClick]);

  // Handle action click
  const handleActionClick = useCallback(
    (action: EMRFABAction) => {
      if (action.disabled) {
        return;
      }
      action.onClick();
      setIsExpanded(false);
    },
    []
  );

  // Handle backdrop click (close expanded)
  const handleBackdropClick = useCallback(() => {
    setIsExpanded(false);
  }, []);

  // Handle keyboard
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && isExpanded) {
        setIsExpanded(false);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [isExpanded, handleClick]
  );

  // Don't render if not visible
  if (!visible || isHidden) {
    return null;
  }

  // Get container styles
  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: typeof bottom === 'number' ? `${bottom}px` : bottom,
    right: typeof right === 'number' ? `${right}px` : right,
    zIndex,
    paddingBottom: 'env(safe-area-inset-bottom)',
    paddingRight: 'env(safe-area-inset-right)',
  };

  // Get FAB button styles
  const fabStyle: React.CSSProperties = {
    width: extended ? 'auto' : config.size,
    height: config.size,
    borderRadius: extended ? config.size / 2 : '50%',
    background: colorMap[color],
    paddingLeft: extended ? 16 : 0,
    paddingRight: extended ? 20 : 0,
    gap: extended ? 8 : 0,
  };

  // Render mini FAB for action
  const renderMiniAction = (action: EMRFABAction, index: number) => {
    const ActionIcon = action.icon;
    const delay = (actions!.length - index - 1) * 50;
    const actionColor = action.color ? colorMap[action.color] : colorMap.primary;

    return (
      <Box
        key={action.key}
        className={`${classes.miniAction} ${isExpanded ? classes.miniActionVisible : ''}`}
        style={{
          transitionDelay: isExpanded ? `${delay}ms` : '0ms',
        }}
      >
        <Tooltip label={action.label} position="left" withArrow>
          <button
            type="button"
            className={classes.miniFab}
            onClick={() => handleActionClick(action)}
            disabled={action.disabled}
            style={{
              width: config.miniSize,
              height: config.miniSize,
              background: actionColor,
            }}
            aria-label={action.label}
            data-testid={`${testId}-action-${action.key}`}
          >
            <ActionIcon size={config.miniIconSize} stroke={2} color="white" />
          </button>
        </Tooltip>
      </Box>
    );
  };

  return (
    <>
      {/* Backdrop for expanded state */}
      {hasMultipleActions && isExpanded && (
        <Box
          className={classes.backdrop}
          onClick={handleBackdropClick}
          style={{ zIndex: zIndex - 1 }}
          data-testid={`${testId}-backdrop`}
        />
      )}

      {/* FAB Container */}
      <Box
        className={`${classes.container} ${animated ? classes.animated : ''}`}
        style={containerStyle}
        data-testid={testId}
      >
        {/* Mini actions */}
        {hasMultipleActions && (
          <Box className={classes.actionsContainer}>
            {actions!.map((action, index) => renderMiniAction(action, index))}
          </Box>
        )}

        {/* Main FAB */}
        <Tooltip
          label={label || (isExpanded ? 'Close' : 'Actions')}
          position="left"
          withArrow
          disabled={extended}
        >
          <button
            type="button"
            className={`${classes.fab} ${isExpanded ? classes.fabExpanded : ''}`}
            style={fabStyle}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            aria-label={label || 'Floating action button'}
            aria-expanded={hasMultipleActions ? isExpanded : undefined}
            data-testid={`${testId}-button`}
          >
            {/* Icon with rotation animation for multi-action */}
            <Box
              className={`${classes.iconWrapper} ${hasMultipleActions && isExpanded ? classes.iconRotated : ''}`}
            >
              {hasMultipleActions && isExpanded ? (
                <IconX size={config.iconSize} stroke={2} color="white" />
              ) : (
                <IconComponent size={config.iconSize} stroke={2} color="white" />
              )}
            </Box>

            {/* Extended label */}
            {extended && extendedLabel && (
              <span className={classes.extendedLabel}>{extendedLabel}</span>
            )}
          </button>
        </Tooltip>
      </Box>
    </>
  );
}

export default EMRFAB;
