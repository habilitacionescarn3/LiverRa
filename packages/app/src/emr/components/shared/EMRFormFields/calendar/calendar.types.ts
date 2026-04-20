// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

export type CalendarView = 'day' | 'month' | 'year';

export interface CalendarProps {
  /** Currently selected date */
  value?: Date | null;
  /** Callback when date is selected */
  onChange?: (date: Date | null) => void;
  /** Minimum selectable date */
  minDate?: Date;
  /** Maximum selectable date */
  maxDate?: Date;
  /** Enable date range selection */
  rangeMode?: boolean;
  /** Range start date (for range mode) */
  rangeStart?: Date | null;
  /** Range end date (for range mode) */
  rangeEnd?: Date | null;
  /** Callback when range is selected */
  onRangeChange?: (start: Date | null, end: Date | null) => void;
  /** Initial view level */
  defaultView?: CalendarView;
  /** Locale for month/day names */
  locale?: string;
}

export interface DateCell {
  date: Date;
  isToday: boolean;
  isSelected: boolean;
  isInRange: boolean;
  isRangeStart: boolean;
  isRangeEnd: boolean;
  isWeekend: boolean;
  isOtherMonth: boolean;
  isDisabled: boolean;
}

export interface MonthCell {
  month: number;
  year: number;
  name: string;
  isSelected: boolean;
  isCurrent: boolean;
  isDisabled: boolean;
}

export interface YearCell {
  year: number;
  isSelected: boolean;
  isCurrent: boolean;
  isDisabled: boolean;
}
