// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Box, Group, ActionIcon, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import type { CalendarView } from './calendar.types';
import { getMonthName, getDecadeRange } from './calendar.utils';

interface CalendarHeaderProps {
  view: CalendarView;
  displayDate: Date;
  onPrevious: () => void;
  onNext: () => void;
  onHeaderClick: () => void;
}

/**
 * Calendar header with navigation and clickable title
 * @param root0
 * @param root0.view
 * @param root0.displayDate
 * @param root0.onPrevious
 * @param root0.onNext
 * @param root0.onHeaderClick
 */
export function CalendarHeader({
  view,
  displayDate,
  onPrevious,
  onNext,
  onHeaderClick,
}: CalendarHeaderProps) {
  const getHeaderText = (): string => {
    switch (view) {
      case 'day':
        return `${getMonthName(displayDate.getMonth())} ${displayDate.getFullYear()}`;
      case 'month':
        return displayDate.getFullYear().toString();
      case 'year':
        return getDecadeRange(displayDate.getFullYear());
      default:
        return '';
    }
  };

  return (
    <Box
      style={{
        marginBottom: '10px',
        paddingBottom: '8px',
        borderBottom: '1px solid var(--emr-border-color)',
      }}
    >
      <Group justify="space-between" align="center">
        {/* Previous Button */}
        <ActionIcon
          variant="subtle"
          size="md"
          onClick={onPrevious}
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            transition: 'all 0.2s ease',
            color: 'var(--emr-primary)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--emr-secondary)';
            e.currentTarget.style.color = 'white';
            e.currentTarget.style.transform = 'scale(1.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--emr-primary)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
        >
          <IconChevronLeft size={16} stroke={2.5} />
        </ActionIcon>

        {/* Clickable Header Text */}
        <Box
          onClick={view !== 'year' ? onHeaderClick : undefined}
          style={{
            cursor: view !== 'year' ? 'pointer' : 'default',
            padding: '6px 12px',
            borderRadius: '8px',
            transition: 'all 0.2s ease',
            userSelect: 'none',
          }}
          onMouseEnter={(e) => {
            if (view !== 'year') {
              e.currentTarget.style.background = 'var(--emr-bg-hover-alt)';
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = 'var(--emr-shadow-soft)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        >
          <Text
            fw={700}
            size="md"
            style={{
              color: 'var(--emr-primary)',
              fontSize: 'var(--emr-font-md)',
              letterSpacing: '-0.2px',
            }}
          >
            {getHeaderText()}
          </Text>
        </Box>

        {/* Next Button */}
        <ActionIcon
          variant="subtle"
          size="md"
          onClick={onNext}
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            transition: 'all 0.2s ease',
            color: 'var(--emr-primary)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--emr-secondary)';
            e.currentTarget.style.color = 'white';
            e.currentTarget.style.transform = 'scale(1.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--emr-primary)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
        >
          <IconChevronRight size={16} stroke={2.5} />
        </ActionIcon>
      </Group>
    </Box>
  );
}
