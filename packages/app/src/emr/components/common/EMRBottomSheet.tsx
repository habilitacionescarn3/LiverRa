// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Box, Portal, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import classes from './EMRBottomSheet.module.css';

/** Snap point options for sheet height */
export type EMRBottomSheetSnapPoint = 'half' | 'full' | 'auto';

/** Props for action menu items */
export interface EMRBottomSheetAction {
  /** Unique key for the action */
  key: string;
  /** Display label */
  label: string;
  /** Icon component */
  icon?: ComponentType<{ size: number }>;
  /** Click handler */
  onClick: () => void;
  /** Color variant (default: default) */
  color?: 'default' | 'destructive';
  /** Whether to show a divider above this item */
  divider?: boolean;
  /** Disabled state */
  disabled?: boolean;
}

/**
 * Props for EMRBottomSheet component
 */
export interface EMRBottomSheetProps {
  /** Whether the sheet is open */
  opened: boolean;
  /** Callback when sheet is closed */
  onClose: () => void;
  /** Sheet title */
  title?: string;
  /** Sheet subtitle */
  subtitle?: string;
  /** Header icon */
  icon?: ComponentType<{ size: number; color?: string }>;
  /** Sheet content */
  children?: ReactNode;
  /** Footer content */
  footer?: ReactNode;
  /** Snap point: 'half', 'full', or 'auto' */
  snapPoint?: EMRBottomSheetSnapPoint;
  /** Whether to show close button */
  showCloseButton?: boolean;
  /** Whether to close on backdrop click */
  closeOnClickOutside?: boolean;
  /** Whether to close on escape key */
  closeOnEscape?: boolean;
  /** Whether to show drag handle */
  showDragHandle?: boolean;
  /** Whether dragging can close the sheet */
  dragToClose?: boolean;
  /** Action menu items (for action sheet variant) */
  actions?: EMRBottomSheetAction[];
  /** Test ID for testing */
  testId?: string;
  /** Z-index for the sheet */
  zIndex?: number;
}

/** Velocity threshold for flick-to-close (px/ms) */
const VELOCITY_THRESHOLD = 0.5;
/** Distance threshold for closing (percentage of sheet height) */
const CLOSE_THRESHOLD = 0.35;

/**
 * EMRBottomSheet - Mobile-native bottom sheet component
 *
 * Features:
 * - Native app-like slide-up animation
 * - Drag handle with gesture support
 * - Snap points (half, full, auto)
 * - Backdrop overlay with click-to-close
 * - Action menu variant for quick actions
 * - iOS safe area support
 * - Accessible with keyboard and screen readers
 *
 * @example
 * ```tsx
 * // Basic usage
 * <EMRBottomSheet
 *   opened={opened}
 *   onClose={onClose}
 *   title="Select Option"
 *   snapPoint="half"
 * >
 *   <p>Sheet content here</p>
 * </EMRBottomSheet>
 *
 * // Action menu variant
 * <EMRBottomSheet
 *   opened={opened}
 *   onClose={onClose}
 *   actions={[
 *     { key: 'edit', label: 'Edit', icon: IconEdit, onClick: handleEdit },
 *     { key: 'delete', label: 'Delete', icon: IconTrash, onClick: handleDelete, color: 'destructive', divider: true },
 *   ]}
 * />
 * ```
 */
export function EMRBottomSheet({
  opened,
  onClose,
  title,
  subtitle,
  icon: Icon,
  children,
  footer,
  snapPoint = 'auto',
  showCloseButton = true,
  closeOnClickOutside = true,
  closeOnEscape = true,
  showDragHandle = true,
  dragToClose = true,
  actions,
  testId = 'emr-bottom-sheet',
  zIndex = 1000,
}: EMRBottomSheetProps): React.ReactElement | null {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [translateY, setTranslateY] = useState(0);

  // Drag state refs (no re-renders during drag)
  const dragStartY = useRef(0);
  const dragStartTime = useRef(0);
  const currentY = useRef(0);

  // Handle escape key
  useEffect(() => {
    if (!opened || !closeOnEscape) {
      return;
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [opened, closeOnEscape, onClose]);

  // Lock body scroll when open
  useEffect(() => {
    if (opened) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
    return undefined;
  }, [opened]);

  // Focus trap for accessibility
  useEffect(() => {
    if (opened && sheetRef.current) {
      sheetRef.current.focus();
    }
  }, [opened]);

  // Drag handlers
  const handleDragStart = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      if (!dragToClose) {
        return;
      }

      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      dragStartY.current = clientY;
      dragStartTime.current = Date.now();
      currentY.current = 0;
      setIsDragging(true);
    },
    [dragToClose]
  );

  const handleDragMove = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      if (!isDragging || !dragToClose) {
        return;
      }

      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      const deltaY = clientY - dragStartY.current;

      // Only allow dragging down (positive deltaY)
      const newTranslateY = Math.max(0, deltaY);
      currentY.current = newTranslateY;
      setTranslateY(newTranslateY);
    },
    [isDragging, dragToClose]
  );

  const handleDragEnd = useCallback(() => {
    if (!isDragging || !dragToClose) {
      return;
    }

    const sheetHeight = sheetRef.current?.offsetHeight ?? 0;
    const dragDistance = currentY.current;
    const dragTime = Date.now() - dragStartTime.current;
    const velocity = dragDistance / dragTime;

    setIsDragging(false);

    // Close if dragged far enough or flicked fast enough
    const shouldClose =
      dragDistance > sheetHeight * CLOSE_THRESHOLD || velocity > VELOCITY_THRESHOLD;

    if (shouldClose) {
      onClose();
    }

    // Reset translate
    setTranslateY(0);
  }, [isDragging, dragToClose, onClose]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(() => {
    if (closeOnClickOutside) {
      onClose();
    }
  }, [closeOnClickOutside, onClose]);

  // Handle action click
  const handleActionClick = useCallback(
    (action: EMRBottomSheetAction) => {
      if (action.disabled) {
        return;
      }
      action.onClick();
      onClose();
    },
    [onClose]
  );

  // Get snap point class
  const getSnapClass = (): string => {
    switch (snapPoint) {
      case 'half':
        return classes.snapHalf;
      case 'full':
        return classes.snapFull;
      case 'auto':
      default:
        return classes.snapAuto;
    }
  };

  // Don't render if not opened
  if (!opened) {
    return null;
  }

  const hasHeader = title || subtitle || Icon || showCloseButton;

  return (
    <Portal>
      {/* Backdrop overlay */}
      <Box
        className={`${classes.overlay} ${opened ? classes.overlayVisible : ''}`}
        onClick={handleBackdropClick}
        style={{ zIndex }}
        aria-hidden="true"
        data-testid={`${testId}-overlay`}
      />

      {/* Sheet container */}
      <Box
        ref={sheetRef}
        className={`${classes.sheet} ${opened ? classes.sheetOpen : ''} ${isDragging ? classes.sheetDragging : ''} ${getSnapClass()}`}
        style={{
          zIndex: zIndex + 1,
          transform: `translateY(${translateY}px)`,
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? `${testId}-title` : undefined}
        tabIndex={-1}
        data-testid={testId}
      >
        {/* Drag handle */}
        {showDragHandle && (
          <Box
            className={classes.dragHandle}
            onTouchStart={handleDragStart}
            onTouchMove={handleDragMove}
            onTouchEnd={handleDragEnd}
            onMouseDown={handleDragStart}
            onMouseMove={isDragging ? handleDragMove : undefined}
            onMouseUp={handleDragEnd}
            onMouseLeave={isDragging ? handleDragEnd : undefined}
            aria-label="Drag to close"
            role="button"
            tabIndex={0}
            data-testid={`${testId}-handle`}
          >
            <Box className={classes.dragIndicator} />
          </Box>
        )}

        {/* Header */}
        {hasHeader && (
          <Box className={classes.header}>
            <Box className={classes.headerContent}>
              {Icon && (
                <Box className={classes.iconContainer}>
                  <Icon size={20} color="white" />
                </Box>
              )}
              {(title || subtitle) && (
                <Box className={classes.titleSection}>
                  {title && (
                    <Text
                      className={classes.title}
                      id={`${testId}-title`}
                      component="h2"
                    >
                      {title}
                    </Text>
                  )}
                  {subtitle && (
                    <Text className={classes.subtitle}>{subtitle}</Text>
                  )}
                </Box>
              )}
            </Box>
            {showCloseButton && (
              <button
                type="button"
                className={classes.closeButton}
                onClick={onClose}
                aria-label="Close"
                data-testid={`${testId}-close`}
              >
                <IconX size={20} />
              </button>
            )}
          </Box>
        )}

        {/* Content */}
        {(children || actions) && (
          <Box className={classes.content}>
            {/* Action menu items */}
            {actions?.map((action) => (
              <Box key={action.key}>
                {action.divider && <Box className={classes.actionItemDivider} />}
                <button
                  type="button"
                  className={`${classes.actionItem} ${action.color === 'destructive' ? classes.actionItemDestructive : ''}`}
                  onClick={() => handleActionClick(action)}
                  disabled={action.disabled}
                  data-testid={`${testId}-action-${action.key}`}
                >
                  {action.icon && (
                    <Box className={classes.actionItemIcon}>
                      <action.icon size={20} />
                    </Box>
                  )}
                  {action.label}
                </button>
              </Box>
            ))}

            {/* Custom content */}
            {children}
          </Box>
        )}

        {/* Footer */}
        {footer && <Box className={classes.footer}>{footer}</Box>}
      </Box>
    </Portal>
  );
}

export default EMRBottomSheet;
