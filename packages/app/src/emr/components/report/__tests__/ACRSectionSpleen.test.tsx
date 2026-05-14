// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionSpleen render regression (M-UT-4).
 *
 * Spleen is a thin generic-section wrapper — no special row-id stamping.
 * Tests assert the stale stamp + warning + empty / unavailable contract.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ACRSectionSpleen } from '../ACRSectionSpleen';
import {
  makeRow,
  makeSection,
  renderWithMantine,
  STALE_COMPUTED_AT,
} from './_testFixtures';

describe('ACRSectionSpleen', () => {
  it('renders the section frame on the happy path', () => {
    const section = makeSection('spleen', [
      makeRow({ key: 'volume', label: 'Spleen volume', value: '215.3 mL' }),
    ]);
    renderWithMantine(<ACRSectionSpleen section={section} />);
    expect(screen.getByTestId('acr-section-spleen')).toBeTruthy();
    expect(screen.getByText('Spleen volume')).toBeTruthy();
    expect(screen.getByText('215.3 mL')).toBeTruthy();
  });

  it('renders the stale stamp when row.stale.computedAt is set', () => {
    const section = makeSection('spleen', [
      makeRow({
        key: 'volume',
        label: 'Spleen volume',
        value: '215.3 mL',
        stale: { computedAt: STALE_COMPUTED_AT },
      }),
    ]);
    renderWithMantine(<ACRSectionSpleen section={section} />);
    expect(screen.getByTestId('acr-stale-stamp')).toBeTruthy();
  });

  it('does NOT render the stale stamp when stale is undefined', () => {
    const section = makeSection('spleen', [
      makeRow({ key: 'volume', label: 'Spleen volume', value: '215.3 mL' }),
    ]);
    renderWithMantine(<ACRSectionSpleen section={section} />);
    expect(screen.queryByTestId('acr-stale-stamp')).toBeNull();
  });

  it('renders the spleen-too-small warning when set (CLAUDE.md surface)', () => {
    const section = makeSection('spleen', [
      makeRow({
        key: 'volume',
        label: 'Spleen volume',
        value: '4.0 mL',
        warning:
          'TotalSegmentator returned only 23 voxels for the spleen — likely outside the scan FOV',
      }),
    ]);
    renderWithMantine(<ACRSectionSpleen section={section} />);
    expect(
      screen.getByText(/TotalSegmentator returned only 23 voxels/),
    ).toBeTruthy();
  });

  it('renders the empty message when status="empty"', () => {
    const section = makeSection(
      'spleen',
      [],
      { status: 'empty', emptyMessage: 'Spleen mask unavailable' },
    );
    renderWithMantine(<ACRSectionSpleen section={section} />);
    expect(screen.getByText('Spleen mask unavailable')).toBeTruthy();
  });
});
