// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Box, Grid } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { YearCell } from './calendar.types';

interface YearGridProps {
  years: YearCell[];
  onYearClick: (year: number) => void;
}

const COLUMNS = 4;

/**
 * Grid of years with card-style tiles, keyboard navigation, and ARIA support.
 * Keyboard: Arrow keys navigate, Home/End jump to row start/end, Enter/Space select.
 * @param root0
 * @param root0.years
 * @param root0.onYearClick
 */
export function YearGrid({ years, onYearClick }: YearGridProps) {
  const cellRefs = useRef<Array<HTMLDivElement | null>>([]);

  const initialFocusIndex = (() => {
    const selected = years.findIndex((c) => c.isSelected && !c.isDisabled);
    if (selected >= 0) {return selected;}
    const current = years.findIndex((c) => c.isCurrent && !c.isDisabled);
    if (current >= 0) {return current;}
    return years.findIndex((c) => !c.isDisabled);
  })();
  const [focusIndex, setFocusIndex] = useState<number>(initialFocusIndex >= 0 ? initialFocusIndex : 0);

  const findNextEnabled = useCallback(
    (start: number, step: number): number => {
      let i = start;
      while (i >= 0 && i < years.length) {
        if (!years[i].isDisabled) {return i;}
        i += step;
      }
      return start;
    },
    [years],
  );

  const moveFocus = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= years.length) {return;}
      const target = findNextEnabled(nextIndex, nextIndex > focusIndex ? 1 : -1);
      setFocusIndex(target);
      cellRefs.current[target]?.focus();
    },
    [years.length, findNextEnabled, focusIndex],
  );

  useEffect(() => {
    const activeEl = document.activeElement;
    const isInsideGrid = cellRefs.current.some((el) => el === activeEl);
    if (isInsideGrid) {
      cellRefs.current[focusIndex]?.focus();
    }
  }, [focusIndex, years]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, index: number) => {
    const row = Math.floor(index / COLUMNS);
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        moveFocus(index - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        moveFocus(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(index - COLUMNS);
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(index + COLUMNS);
        break;
      case 'Home':
        e.preventDefault();
        moveFocus(row * COLUMNS);
        break;
      case 'End':
        e.preventDefault();
        moveFocus(row * COLUMNS + (COLUMNS - 1));
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const cell = years[index];
        if (cell && !cell.isDisabled) {
          onYearClick(cell.year);
        }
        break;
      }
      default:
        break;
    }
  };

  const getYearStyles = (cell: YearCell): React.CSSProperties => {
    const baseStyles: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      borderRadius: '12px',
      fontSize: 'var(--emr-font-md)',
      fontWeight: cell.isSelected || cell.isCurrent ? 'var(--emr-font-bold)' : 'var(--emr-font-semibold)',
      cursor: cell.isDisabled ? 'not-allowed' : 'pointer',
      transition: 'all 0.2s ease',
      userSelect: 'none',
      border: '1px solid var(--emr-border-color)',
      outline: 'none',
    };

    if (cell.isDisabled) {
      return {
        ...baseStyles,
        color: 'var(--emr-text-muted)',
        opacity: 0.5,
        cursor: 'not-allowed',
      };
    }

    if (cell.isSelected) {
      return {
        ...baseStyles,
        background: 'var(--emr-secondary)',
        color: 'var(--emr-bg-card)',
        boxShadow: 'var(--emr-shadow-glow-primary)',
        border: 'none',
      };
    }

    if (cell.isCurrent) {
      return {
        ...baseStyles,
        border: '2px solid var(--emr-secondary)',
        background: 'var(--emr-primary-alpha-04)',
        color: 'var(--emr-primary)',
      };
    }

    return {
      ...baseStyles,
      background: 'var(--emr-bg-card)',
      color: 'var(--emr-text-primary)',
    };
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>, cell: YearCell) => {
    if (cell.isDisabled) {return;}
    const target = e.currentTarget;
    if (!cell.isSelected) {
      target.style.background = 'var(--emr-primary-alpha-16)';
      target.style.transform = 'translateY(-3px)';
      target.style.boxShadow = 'var(--emr-shadow-md)';
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>, cell: YearCell) => {
    if (cell.isDisabled) {return;}
    const target = e.currentTarget;
    if (!cell.isSelected) {
      if (cell.isCurrent) {
        target.style.background = 'var(--emr-primary-alpha-04)';
      } else {
        target.style.background = 'var(--emr-bg-card)';
      }
      target.style.transform = 'translateY(0)';
      target.style.boxShadow = 'none';
    }
  };

  const handleFocus = (e: React.FocusEvent<HTMLDivElement>, cell: YearCell) => {
    if (cell.isDisabled) {return;}
    const target = e.currentTarget;
    target.style.outline = '2px solid var(--emr-secondary)';
    target.style.outlineOffset = '2px';
  };

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    e.currentTarget.style.outline = 'none';
    e.currentTarget.style.outlineOffset = '0';
  };

  return (
    <Grid gutter="md" role="grid" aria-label="Calendar years">
      {years.map((cell, index) => {
        const isFocusable = !cell.isDisabled && index === focusIndex;
        return (
          <Grid.Col key={cell.year} span={3} role="gridcell">
            <Box
              ref={(el) => {
                cellRefs.current[index] = el;
              }}
              role="button"
              tabIndex={isFocusable ? 0 : -1}
              aria-label={`Year ${cell.year}`}
              aria-disabled={cell.isDisabled}
              aria-selected={cell.isSelected}
              aria-current={cell.isCurrent ? 'date' : undefined}
              onClick={() => !cell.isDisabled && onYearClick(cell.year)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              onFocus={(e) => handleFocus(e, cell)}
              onBlur={handleBlur}
              style={getYearStyles(cell)}
              onMouseEnter={(e) => handleMouseEnter(e, cell)}
              onMouseLeave={(e) => handleMouseLeave(e, cell)}
            >
              {cell.year}
            </Box>
          </Grid.Col>
        );
      })}
    </Grid>
  );
}
