// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared fixtures for ACR section component tests.
 *
 * Why a separate file: the same minimal ``ReadoutSection`` shape is
 * reused across all six section component tests (liver/lesions/vessels/
 * flr/spleen/gallbladder). Centralising it keeps the per-section tests
 * focused on the render contract — title, metric formatting, stale-stamp
 * surface, warning surface, empty / unavailable / computing states —
 * without copying scaffolding.
 *
 * ``renderWithMantine`` wraps with the bare minimum provider Mantine
 * components need to mount inside happy-dom.
 */

import { MantineProvider } from '@mantine/core';
import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement } from 'react';

import type {
  AnatomicalSection,
  ReadoutRow,
  ReadoutSection,
} from '../../../services/report/acrAnatomicalMapping';

export function makeRow(over: Partial<ReadoutRow> & Pick<ReadoutRow, 'key'>): ReadoutRow {
  return {
    label: 'Volume',
    value: '1,234.5 mL',
    ...over,
  };
}

export function makeSection(
  section: AnatomicalSection,
  rows: ReadoutRow[],
  over: Partial<ReadoutSection> = {},
): ReadoutSection {
  return {
    section,
    title: section.charAt(0).toUpperCase() + section.slice(1),
    rows,
    status: 'present',
    ...over,
  };
}

export const STALE_COMPUTED_AT = '2026-05-01T08:30:00Z';

export function renderWithMantine(
  ui: ReactElement,
  options?: RenderOptions,
): ReturnType<typeof render> {
  return render(<MantineProvider>{ui}</MantineProvider>, options);
}
