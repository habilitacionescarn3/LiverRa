// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Box, Grid, Text } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DateCell } from './calendar.types';
import { getWeekdayNames } from './calendar.utils';

interface DayGridProps {
  days: DateCell[];
  onDayClick: (date: Date) => void;
  locale?: string;
}

/**
 * Grid of days with beautiful styling, keyboard navigation, and ARIA support.
 * Keyboard: Arrow keys navigate between days, Home/End jump to start/end of row,
 * Enter/Space select the focused day.
 * @param root0
 * @param root0.days
 * @param root0.onDayClick
 * @param root0.locale
 */
export function DayGrid({ days, onDayClick, locale }: DayGridProps) {
  const weekdayNames = getWeekdayNames(true);
  const cellRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Initial focus index: selected cell, else today, else first enabled cell
  const initialFocusIndex = (() => {
    const selected = days.findIndex((c) => c.isSelected && !c.isDisabled);
    if (selected >= 0) {return selected;}
    const today = days.findIndex((c) => c.isToday && !c.isDisabled);
    if (today >= 0) {return today;}
    return days.findIndex((c) => !c.isDisabled);
  })();
  const [focusIndex, setFocusIndex] = useState<number>(initialFocusIndex >= 0 ? initialFocusIndex : 0);

  const dateLabelFormatter = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const findNextEnabled = useCallback(
    (start: number, step: number): number => {
      let i = start;
      while (i >= 0 && i < days.length) {
        if (!days[i].isDisabled) {return i;}
        i += step;
      }
      return start;
    },
    [days],
  );

  const moveFocus = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= days.length) {return;}
      const target = findNextEnabled(nextIndex, nextIndex > focusIndex ? 1 : -1);
      setFocusIndex(target);
      cellRefs.current[target]?.focus();
    },
    [days.length, findNextEnabled, focusIndex],
  );

  // When days array changes (e.g. month navigation), re-focus the active cell if user
  // is already navigating within the grid (i.e. focus is inside).
  useEffect(() => {
    const activeEl = document.activeElement;
    const isInsideGrid = cellRefs.current.some((el) => el === activeEl);
    if (isInsideGrid) {
      cellRefs.current[focusIndex]?.focus();
    }
  }, [focusIndex, days]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, index: number) => {
    const row = Math.floor(index / 7);
    const col = index % 7;
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
        moveFocus(index - 7);
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(index + 7);
        break;
      case 'Home':
        e.preventDefault();
        moveFocus(row * 7);
        break;
      case 'End':
        e.preventDefault();
        moveFocus(row * 7 + 6);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const cell = days[index];
        if (cell && !cell.isDisabled) {
          onDayClick(cell.date);
        }
        break;
      }
      default:
        // no-op: prevent unused variable warning for col
        void col;
    }
  };

  const getDayStyles = (cell: DateCell) => {
    const baseStyles: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '32px',
      borderRadius: '8px',
      fontSize: 'var(--emr-font-base)',
      fontWeight: cell.isToday || cell.isSelected ? 'var(--emr-font-bold)' : 'var(--emr-font-medium)',
      cursor: cell.isDisabled ? 'not-allowed' : 'pointer',
      transition: 'all 0.15s ease',
      position: 'relative',
      userSelect: 'none',
      opacity: cell.isOtherMonth ? 0.3 : 1,
      outline: 'none',
    };

    // Disabled state
    if (cell.isDisabled) {
      return {
        ...baseStyles,
        color: 'var(--emr-text-muted)',
        cursor: 'not-allowed',
      };
    }

    // Selected state (highest priority)
    if (cell.isSelected || cell.isRangeStart || cell.isRangeEnd) {
      return {
        ...baseStyles,
        background: 'var(--emr-secondary)',
        color: 'var(--emr-bg-card)',
        boxShadow: 'var(--emr-shadow-glow-primary)',
      };
    }

    // In range (not start/end)
    if (cell.isInRange) {
      return {
        ...baseStyles,
        background: 'var(--emr-primary-alpha-16)',
        color: 'var(--emr-primary)',
      };
    }

    // Today (if not selected)
    if (cell.isToday) {
      return {
        ...baseStyles,
        border: '2px solid var(--emr-secondary)',
        background: 'var(--emr-primary-alpha-04)',
        color: 'var(--emr-primary)',
      };
    }

    // Weekend
    if (cell.isWeekend) {
      return {
        ...baseStyles,
        color: 'var(--emr-secondary)',
      };
    }

    // Regular day
    return {
      ...baseStyles,
      color: 'var(--emr-text-primary)',
    };
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>, cell: DateCell) => {
    if (cell.isDisabled) {return;}
    const target = e.currentTarget;
    if (!cell.isSelected && !cell.isRangeStart && !cell.isRangeEnd) {
      target.style.background = 'var(--emr-primary-alpha-12)';
      target.style.transform = 'scale(1.08)';
      target.style.boxShadow = 'var(--emr-shadow-sm)';
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>, cell: DateCell) => {
    if (cell.isDisabled) {return;}
    const target = e.currentTarget;
    if (!cell.isSelected && !cell.isRangeStart && !cell.isRangeEnd) {
      if (cell.isInRange) {
        target.style.background = 'var(--emr-primary-alpha-16)';
      } else if (cell.isToday) {
        target.style.background = 'var(--emr-primary-alpha-04)';
      } else {
        target.style.background = 'transparent';
      }
      target.style.transform = 'scale(1)';
      target.style.boxShadow = 'none';
    }
  };

  const handleFocus = (e: React.FocusEvent<HTMLDivElement>, cell: DateCell) => {
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
    <Box role="grid" aria-label="Calendar days">
      {/* Weekday Headers */}
      <Grid gutter={4} mb="xs" role="row">
        {weekdayNames.map((name) => (
          <Grid.Col key={name} span={12 / 7} style={{ maxWidth: '14.28%' }} role="columnheader">
            <Text
              ta="center"
              size="xs"
              fw={600}
              style={{
                color: 'var(--emr-text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                fontSize: 'var(--emr-font-xs)',
              }}
            >
              {name}
            </Text>
          </Grid.Col>
        ))}
      </Grid>

      {/* Days Grid */}
      <Grid gutter={4}>
        {days.map((cell, index) => {
          const isFocusable = !cell.isDisabled && index === focusIndex;
          return (
            <Grid.Col key={index} span={12 / 7} style={{ maxWidth: '14.28%' }} role="gridcell">
              <Box
                ref={(el) => {
                  cellRefs.current[index] = el;
                }}
                role="button"
                tabIndex={isFocusable ? 0 : -1}
                aria-label={dateLabelFormatter.format(cell.date)}
                aria-disabled={cell.isDisabled}
                aria-selected={cell.isSelected || cell.isRangeStart || cell.isRangeEnd}
                aria-current={cell.isToday ? 'date' : undefined}
                onClick={() => !cell.isDisabled && onDayClick(cell.date)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                onFocus={(e) => handleFocus(e, cell)}
                onBlur={handleBlur}
                style={getDayStyles(cell)}
                onMouseEnter={(e) => handleMouseEnter(e, cell)}
                onMouseLeave={(e) => handleMouseLeave(e, cell)}
              >
                {cell.date.getDate()}
              </Box>
            </Grid.Col>
          );
        })}
      </Grid>
    </Box>
  );
}
