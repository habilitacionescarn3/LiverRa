// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionLiver render regression (M-UT-4).
 *
 * Plain-English: the component is a thin wrapper over
 * ``ACRGenericSection``. These tests exercise the render contract that
 * the e2e spec depends on:
 *   - The steatosis row carries the ``steatosis-grade`` test id.
 *   - The stale stamp appears iff ``row.stale.computedAt`` is set.
 *   - Warnings surface when ``row.warning`` is set.
 *   - Empty / computing / unavailable states render the correct copy.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ACRSectionLiver } from '../ACRSectionLiver';
import {
  makeRow,
  makeSection,
  renderWithMantine,
  STALE_COMPUTED_AT,
} from './_testFixtures';

describe('ACRSectionLiver', () => {
  it('renders the section title and rows on the happy path', () => {
    const section = makeSection('liver', [
      makeRow({ key: 'volume', label: 'Parenchyma volume', value: '1,450.0 mL' }),
      makeRow({ key: 'steatosis', label: 'Steatosis', value: 'Mild' }),
    ]);
    renderWithMantine(<ACRSectionLiver section={section} />);

    expect(screen.getByTestId('acr-section-liver')).toBeTruthy();
    expect(screen.getByText('Parenchyma volume')).toBeTruthy();
    expect(screen.getByText('1,450.0 mL')).toBeTruthy();
  });

  it('marks the steatosis row with the steatosis-grade test id', () => {
    const section = makeSection('liver', [
      makeRow({ key: 'steatosis', label: 'Steatosis', value: 'Moderate' }),
    ]);
    renderWithMantine(<ACRSectionLiver section={section} />);
    const cell = screen.getByTestId('steatosis-grade');
    expect(cell.textContent).toContain('Moderate');
  });

  it('renders the stale stamp when row.stale.computedAt is set (B-ACR-1)', () => {
    const section = makeSection('liver', [
      makeRow({
        key: 'volume',
        label: 'Parenchyma volume',
        value: '1,450.0 mL',
        stale: { computedAt: STALE_COMPUTED_AT },
      }),
    ]);
    renderWithMantine(<ACRSectionLiver section={section} />);
    expect(screen.getByTestId('acr-stale-stamp')).toBeTruthy();
  });

  it('does NOT render the stale stamp when row.stale is undefined', () => {
    const section = makeSection('liver', [
      makeRow({ key: 'volume', label: 'Parenchyma volume', value: '1,450.0 mL' }),
    ]);
    renderWithMantine(<ACRSectionLiver section={section} />);
    expect(screen.queryByTestId('acr-stale-stamp')).toBeNull();
  });

  it('renders the warning when row.warning is set', () => {
    const section = makeSection('liver', [
      makeRow({
        key: 'volume',
        label: 'Parenchyma volume',
        value: '1,450.0 mL',
        warning: 'Mask too small; volume estimate untrustworthy',
      }),
    ]);
    renderWithMantine(<ACRSectionLiver section={section} />);
    expect(
      screen.getByText('Mask too small; volume estimate untrustworthy'),
    ).toBeTruthy();
  });

  it('renders the empty-state message when status="empty"', () => {
    const section = makeSection(
      'liver',
      [],
      { status: 'empty', emptyMessage: 'No liver findings recorded' },
    );
    renderWithMantine(<ACRSectionLiver section={section} />);
    expect(screen.getByText('No liver findings recorded')).toBeTruthy();
  });

  it('renders the unavailable alert when status="unavailable"', () => {
    const section = makeSection(
      'liver',
      [],
      { status: 'unavailable', emptyMessage: 'Cascade not yet complete' },
    );
    renderWithMantine(<ACRSectionLiver section={section} />);
    expect(screen.getByText('Cascade not yet complete')).toBeTruthy();
  });

  it('renders skeleton placeholders when status="computing"', () => {
    const section = makeSection(
      'liver',
      [],
      { status: 'computing' },
    );
    const { container } = renderWithMantine(<ACRSectionLiver section={section} />);
    expect(screen.getByTestId('acr-section-liver')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="acr-stale-stamp"]'))
      .toHaveLength(0);
  });
});
