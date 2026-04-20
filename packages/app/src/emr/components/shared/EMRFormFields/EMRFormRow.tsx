// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import type { EMRFormRowProps } from './EMRFieldTypes';
import './emr-fields.css';

/**
 * EMRFormRow component
 * Arranges form fields horizontally with responsive stacking
 * @param root0
 * @param root0.children
 * @param root0.gap
 * @param root0.wrap
 * @param root0.align
 * @param root0.className
 * @param root0.style
 */
export function EMRFormRow({
  children,
  gap = 'md',
  wrap = true,
  align = 'start',
  className = '',
  style,
}: EMRFormRowProps): React.JSX.Element {
  // Gap class based on size or number
  const getGapClass = () => {
    if (typeof gap === 'number') {return '';}
    return `gap-${gap}`;
  };

  // Build row classes
  const rowClasses = [
    'emr-form-row',
    wrap && 'wrap',
    `align-${align}`,
    getGapClass(),
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // Custom gap style if number provided
  const rowStyle: React.CSSProperties = {
    ...style,
    ...(typeof gap === 'number' ? { gap: `${gap}px` } : {}),
  };

  return (
    <div className={rowClasses} style={rowStyle}>
      {children}
    </div>
  );
}

export default EMRFormRow;
