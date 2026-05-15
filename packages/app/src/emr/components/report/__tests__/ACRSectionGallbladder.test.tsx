// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionGallbladder render regression (M-UT-4).
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ACRSectionGallbladder } from '../ACRSectionGallbladder';
import {
  makeRow,
  makeSection,
  renderWithMantine,
  STALE_COMPUTED_AT,
} from './_testFixtures';

describe('ACRSectionGallbladder', () => {
  it('renders the section frame on the happy path', () => {
    const section = makeSection('gallbladder', [
      makeRow({ key: 'wall', label: 'Wall thickness', value: '2.1 mm' }),
      makeRow({ key: 'stones', label: 'Stones', value: 'Detected' }),
    ]);
    renderWithMantine(<ACRSectionGallbladder section={section} />);
    expect(screen.getByTestId('acr-section-gallbladder')).toBeTruthy();
    expect(screen.getByText('Wall thickness')).toBeTruthy();
    expect(screen.getByText('Detected')).toBeTruthy();
  });

  it('renders the stale stamp when row.stale.computedAt is set', () => {
    const section = makeSection('gallbladder', [
      makeRow({
        key: 'wall',
        label: 'Wall thickness',
        value: '5.2 mm',
        stale: { computedAt: STALE_COMPUTED_AT },
      }),
    ]);
    renderWithMantine(<ACRSectionGallbladder section={section} />);
    expect(screen.getByTestId('acr-stale-stamp')).toBeTruthy();
  });

  it('does NOT render the stale stamp when stale is undefined', () => {
    const section = makeSection('gallbladder', [
      makeRow({ key: 'wall', label: 'Wall thickness', value: '2.1 mm' }),
    ]);
    renderWithMantine(<ACRSectionGallbladder section={section} />);
    expect(screen.queryByTestId('acr-stale-stamp')).toBeNull();
  });

  it('renders the wall-thickened warning when set', () => {
    const section = makeSection('gallbladder', [
      makeRow({
        key: 'wall',
        label: 'Wall thickness',
        value: '5.2 mm',
        warning:
          'Wall thickness exceeded iteration cap — real value may be larger',
      }),
    ]);
    renderWithMantine(<ACRSectionGallbladder section={section} />);
    expect(
      screen.getByText(/exceeded iteration cap/),
    ).toBeTruthy();
  });

  it('renders the empty message when status="empty"', () => {
    const section = makeSection(
      'gallbladder',
      [],
      { status: 'empty', emptyMessage: 'Gallbladder mask too small' },
    );
    renderWithMantine(<ACRSectionGallbladder section={section} />);
    expect(screen.getByText('Gallbladder mask too small')).toBeTruthy();
  });

  it('renders the unavailable alert when status="unavailable"', () => {
    const section = makeSection(
      'gallbladder',
      [],
      { status: 'unavailable', emptyMessage: 'Cascade did not run for this scan' },
    );
    renderWithMantine(<ACRSectionGallbladder section={section} />);
    expect(screen.getByText('Cascade did not run for this scan')).toBeTruthy();
  });
});
