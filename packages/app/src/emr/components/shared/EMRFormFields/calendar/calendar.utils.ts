// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import type { DateCell, MonthCell, YearCell } from './calendar.types';

/**
 * Get the first day of the month
 * @param date
 */
export function getFirstDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Get the last day of the month
 * @param date
 */
export function getLastDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

/**
 * Get days in month including padding from previous/next month
 * Returns 42 days (6 weeks) for consistent grid
 * @param displayDate
 * @param selectedDate
 * @param rangeStart
 * @param rangeEnd
 * @param minDate
 * @param maxDate
 */
export function getCalendarDays(
  displayDate: Date,
  selectedDate: Date | null,
  rangeStart: Date | null,
  rangeEnd: Date | null,
  minDate?: Date,
  maxDate?: Date
): DateCell[] {
  const firstDay = getFirstDayOfMonth(displayDate);

  // Start from Sunday of the week containing the 1st
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - startDate.getDay());

  const days: DateCell[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 42; i++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(startDate.getDate() + i);
    currentDate.setHours(0, 0, 0, 0);

    const isOtherMonth = currentDate.getMonth() !== displayDate.getMonth();
    const isToday = currentDate.getTime() === today.getTime();
    const isSelected = selectedDate ? currentDate.getTime() === selectedDate.getTime() : false;
    const isWeekend = currentDate.getDay() === 0 || currentDate.getDay() === 6;

    // Range logic
    let isInRange = false;
    let isRangeStart = false;
    let isRangeEnd = false;

    if (rangeStart && rangeEnd) {
      const time = currentDate.getTime();
      const start = rangeStart.getTime();
      const end = rangeEnd.getTime();
      isInRange = time >= start && time <= end;
      isRangeStart = time === start;
      isRangeEnd = time === end;
    }

    // Disabled logic
    let isDisabled = false;
    if (minDate && currentDate < minDate) {
      isDisabled = true;
    }
    if (maxDate && currentDate > maxDate) {
      isDisabled = true;
    }

    days.push({
      date: currentDate,
      isToday,
      isSelected,
      isInRange,
      isRangeStart,
      isRangeEnd,
      isWeekend,
      isOtherMonth,
      isDisabled,
    });
  }

  return days;
}

/**
 * Get month names
 */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

/**
 * Get months for year picker
 * @param displayYear
 * @param selectedDate
 * @param minDate
 * @param maxDate
 */
export function getMonthsGrid(
  displayYear: number,
  selectedDate: Date | null,
  minDate?: Date,
  maxDate?: Date
): MonthCell[] {
  const months: MonthCell[] = [];
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth();

  for (let month = 0; month < 12; month++) {
    const isCurrent = currentYear === displayYear && currentMonth === month;
    const isSelected = selectedDate
      ? selectedDate.getFullYear() === displayYear && selectedDate.getMonth() === month
      : false;

    // Check if month is disabled
    let isDisabled = false;
    if (minDate) {
      const monthStart = new Date(displayYear, month, 1);
      if (monthStart < new Date(minDate.getFullYear(), minDate.getMonth(), 1)) {
        isDisabled = true;
      }
    }
    if (maxDate) {
      const monthEnd = new Date(displayYear, month + 1, 0);
      if (monthEnd > new Date(maxDate.getFullYear(), maxDate.getMonth() + 1, 0)) {
        isDisabled = true;
      }
    }

    months.push({
      month,
      year: displayYear,
      name: MONTH_NAMES[month],
      isSelected,
      isCurrent,
      isDisabled,
    });
  }

  return months;
}

/**
 * Get years for decade picker
 * @param displayYear
 * @param selectedDate
 * @param minDate
 * @param maxDate
 */
export function getYearsGrid(
  displayYear: number,
  selectedDate: Date | null,
  minDate?: Date,
  maxDate?: Date
): YearCell[] {
  // Show 12 years: current decade + 2 extra (e.g., 1990-2001)
  const decadeStart = Math.floor(displayYear / 10) * 10;
  const years: YearCell[] = [];
  const currentYear = new Date().getFullYear();

  for (let i = 0; i < 12; i++) {
    const year = decadeStart + i;
    const isCurrent = year === currentYear;
    const isSelected = selectedDate ? selectedDate.getFullYear() === year : false;

    let isDisabled = false;
    if (minDate && year < minDate.getFullYear()) {
      isDisabled = true;
    }
    if (maxDate && year > maxDate.getFullYear()) {
      isDisabled = true;
    }

    years.push({
      year,
      isSelected,
      isCurrent,
      isDisabled,
    });
  }

  return years;
}

/**
 * Format date as DD.MM.YYYY
 * @param date
 */
export function formatDate(date: Date | null | undefined): string {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    return '';
  }
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

/**
 * Get month name
 * @param month
 * @param short
 */
export function getMonthName(month: number, short = false): string {
  return short ? MONTH_NAMES_SHORT[month] : MONTH_NAMES[month];
}

/**
 * Get weekday names
 * @param short
 */
export function getWeekdayNames(short = true): string[] {
  return short
    ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
    : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
}

/**
 * Check if two dates are the same day
 * @param date1
 * @param date2
 */
export function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

/**
 * Get decade range string (e.g., "1990-1999")
 * @param year
 */
export function getDecadeRange(year: number): string {
  const decadeStart = Math.floor(year / 10) * 10;
  return `${decadeStart}-${decadeStart + 11}`;
}
