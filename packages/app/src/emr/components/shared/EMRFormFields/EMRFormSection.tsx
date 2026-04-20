// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useCallback } from 'react';
import { IconChevronDown } from '@tabler/icons-react';
import type { EMRFormSectionProps } from './EMRFieldTypes';
import './emr-fields.css';

/**
 * EMRFormSection component
 * A collapsible section with icon, title, and blue accent border
 * Supports subtitle, right content, and empty state
 * @param props - The component props
 * @returns The rendered section component
 */
export function EMRFormSection(props: EMRFormSectionProps): React.JSX.Element {
  const {
    title,
    icon: Icon,
    children,
    defaultOpen = true,
    open: controlledOpen,
    onOpenChange,
    borderColor,
    className = '',
    style,
    'data-testid': dataTestId,
    subtitle,
    rightContent,
    hasContent = true,
    emptyStateMessage,
  } = props;
  // Internal state for uncontrolled mode
  const [internalOpen, setInternalOpen] = useState(defaultOpen);

  // Determine if controlled or uncontrolled
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  // Handle toggle
  const handleToggle = useCallback(() => {
    if (isControlled) {
      onOpenChange?.(!controlledOpen);
    } else {
      setInternalOpen((prev) => !prev);
    }
  }, [isControlled, controlledOpen, onOpenChange]);

  // Build section classes
  const sectionClasses = [
    'emr-form-section',
    isOpen && 'open',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // Custom border color style
  const sectionStyle: React.CSSProperties = {
    ...style,
    ...(borderColor ? { borderColor } : {}),
  };

  return (
    <div className={sectionClasses} style={sectionStyle} data-testid={dataTestId}>
      {/* Header */}
      <div
        className="emr-form-section-header"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
          }
        }}
        aria-expanded={isOpen}
      >
        <div className="emr-form-section-header-left" onClick={handleToggle}>
          <div className="emr-form-section-title-group">
            {Icon && (
              <span className="emr-form-section-icon">
                <Icon size={20} stroke="1.5" />
              </span>
            )}
            <div className="emr-form-section-title-wrapper">
              <span className="emr-form-section-title-text">{title}</span>
              {subtitle && (
                <span className="emr-form-section-subtitle">{subtitle}</span>
              )}
            </div>
          </div>
          <IconChevronDown
            size={20}
            className="emr-form-section-chevron"
            stroke={1.5}
          />
        </div>
        {rightContent && (
          <div className="emr-form-section-right" onClick={(e) => e.stopPropagation()}>
            {rightContent}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="emr-form-section-content">
        {hasContent && children}
        {!hasContent && emptyStateMessage && (
          <div className="emr-form-section-empty">
            {emptyStateMessage}
          </div>
        )}
        {!hasContent && !emptyStateMessage && children}
      </div>
    </div>
  );
}

export default EMRFormSection;
