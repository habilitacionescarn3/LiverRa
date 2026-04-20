// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Box, Tooltip } from '@mantine/core';
import type { ComponentType, ReactNode } from 'react';
import styles from './EMRCard.module.css';

/** Icon props type for Tabler icons */
interface IconProps {
  size?: number | string;
  stroke?: number;
}

/** Action button configuration */
export interface EMRCardAction {
  /** Unique key for the action */
  key: string;
  /** Icon component for the button */
  icon: ComponentType<IconProps>;
  /** Tooltip label */
  label: string;
  /** Click handler */
  onClick: () => void;
  /** Button variant */
  variant?: 'primary' | 'secondary' | 'tertiary' | 'muted' | 'success';
  /** Whether the action is hidden */
  hidden?: boolean;
}

export interface EMRCardProps {
  /** Card title */
  title: string;
  /** Card description (optional) */
  description?: string;
  /** Badges to display (render using EMRBadge) */
  badges?: ReactNode;
  /** Meta information (e.g., "Last modified: Dec 6, 2025") */
  meta?: string;
  /** Action buttons */
  actions?: EMRCardAction[];
  /** Click handler for the entire card */
  onClick?: () => void;
  /** Whether the card is archived/inactive */
  archived?: boolean;
  /** Enable entrance animation */
  animated?: boolean;
  /** Animation delay index (0-9) for staggered animations */
  animationIndex?: number;
  /** Test ID */
  'data-testid'?: string;
}

/**
 * EMRCard - Reusable content card with badges and action buttons
 *
 * A standardized card component for displaying content items like forms,
 * documents, or templates. Features title, description, badges, meta info,
 * and configurable action buttons.
 *
 * @param root0
 * @param root0.title
 * @param root0.description
 * @param root0.badges
 * @param root0.meta
 * @param root0.actions
 * @param root0.onClick
 * @param root0.archived
 * @param root0.animated
 * @param root0.animationIndex
 * @param root0.'data-testid'
 * @example
 * // Form template card
 * <EMRCard
 *   title="Patient Intake Form"
 *   description="Standard patient intake questionnaire"
 *   badges={
 *     <>
 *       <EMRBadge variant="version">v1.0.0</EMRBadge>
 *       <EMRBadge variant="success">Active</EMRBadge>
 *     </>
 *   }
 *   meta="Last modified: Dec 6, 2025"
 *   actions={[
 *     { key: 'fill', icon: IconFileText, label: 'Fill', onClick: handleFill, variant: 'primary' },
 *     { key: 'edit', icon: IconEdit, label: 'Edit', onClick: handleEdit, variant: 'secondary' },
 *     { key: 'clone', icon: IconCopy, label: 'Clone', onClick: handleClone, variant: 'tertiary' },
 *   ]}
 *   onClick={() => navigate(`/forms/${id}`)}
 *   animated
 *   animationIndex={0}
 * />
 */
export function EMRCard({
  title,
  description,
  badges,
  meta,
  actions,
  onClick,
  archived = false,
  animated = false,
  animationIndex = 0,
  'data-testid': dataTestId = 'emr-content-card',
}: EMRCardProps): React.JSX.Element {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onClick();
    }
  };

  const handleActionClick = (e: React.MouseEvent, action: EMRCardAction) => {
    e.stopPropagation();
    action.onClick();
  };

  // Filter visible actions
  const visibleActions = actions?.filter((action) => !action.hidden) || [];

  // Build class names
  const cardClasses = [
    styles.card,
    onClick ? styles.clickable : '',
    archived ? styles.archived : '',
    animated ? styles.animated : '',
    animated && animationIndex >= 0 && animationIndex <= 9 ? styles[`delay${animationIndex}`] : '',
  ].filter(Boolean).join(' ');

  // Get action button class based on variant
  const getActionClass = (variant: EMRCardAction['variant'] = 'secondary'): string => {
    const variantClasses: Record<string, string> = {
      primary: styles.actionPrimary,
      secondary: styles.actionSecondary,
      tertiary: styles.actionTertiary,
      muted: styles.actionMuted,
      success: styles.actionSuccess,
    };
    return `${styles.actionButton} ${variantClasses[variant] || variantClasses.secondary}`;
  };

  return (
    <Box
      className={cardClasses}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      tabIndex={onClick ? 0 : undefined}
      role={onClick ? 'button' : undefined}
      aria-label={onClick ? `${title}${description ? ` - ${description}` : ''}` : undefined}
      data-testid={dataTestId}
    >
      <div className={styles.content}>
        {/* Header with title and description - fixed height for alignment */}
        <div className={styles.header}>
          <div className={styles.titleSection}>
            <h3 className={styles.title}>{title}</h3>
            <p className={styles.description}>{description || '\u00A0'}</p>
          </div>
        </div>

        {/* Badges row */}
        {badges && <div className={styles.badges}>{badges}</div>}

        {/* Divider */}
        {(meta || visibleActions.length > 0) && <hr className={styles.divider} />}

        {/* Footer with meta and actions */}
        {(meta || visibleActions.length > 0) && (
          <div className={styles.footer}>
            {meta && <span className={styles.meta}>{meta}</span>}
            {visibleActions.length > 0 && (
              <div className={styles.actions}>
                {visibleActions.map((action) => (
                  <Tooltip key={action.key} label={action.label} withArrow>
                    <button
                      type="button"
                      className={getActionClass(action.variant)}
                      onClick={(e) => handleActionClick(e, action)}
                      data-testid={`action-${action.key}`}
                    >
                      <action.icon size={16} />
                    </button>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Box>
  );
}

export default EMRCard;
