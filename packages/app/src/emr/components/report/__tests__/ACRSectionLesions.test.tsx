// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionLesions render regression (M-UT-4).
 *
 * The lesions section marks the FIRST row with an ``itemId`` (i.e. a
 * per-lesion row) as the "primary" lesion and stamps it with the
 * ``primary-lesion-size`` test id the e2e spec relies on.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ACRSectionLesions } from '../ACRSectionLesions';
import {
  makeRow,
  makeSection,
  renderWithMantine,
  STALE_COMPUTED_AT,
} from './_testFixtures';

describe('ACRSectionLesions', () => {
  it('renders the section frame on the happy path', () => {
    const section = makeSection('lesions', [
      makeRow({ key: 'L1-size', itemId: 'L1', label: 'L1 size', value: '18.4 mm' }),
    ]);
    renderWithMantine(<ACRSectionLesions section={section} />);
    expect(screen.getByTestId('acr-section-lesions')).toBeTruthy();
  });

  it('marks the FIRST itemId row with the primary-lesion-size test id', () => {
    const section = makeSection('lesions', [
      makeRow({ key: 'header', label: 'Total lesions', value: '2' }),
      makeRow({ key: 'L1-size', itemId: 'L1', label: 'L1 size', value: '18.4 mm' }),
      makeRow({ key: 'L2-size', itemId: 'L2', label: 'L2 size', value: '12.0 mm' }),
    ]);
    renderWithMantine(<ACRSectionLesions section={section} />);
    const primary = screen.getByTestId('primary-lesion-size');
    expect(primary.textContent).toContain('18.4 mm');
  });

  it('renders the stale stamp on per-lesion rows when stale is set', () => {
    const section = makeSection('lesions', [
      makeRow({
        key: 'L1-size',
        itemId: 'L1',
        label: 'L1 size',
        value: '18.4 mm',
        stale: { computedAt: STALE_COMPUTED_AT },
      }),
    ]);
    renderWithMantine(<ACRSectionLesions section={section} />);
    expect(screen.getByTestId('acr-stale-stamp')).toBeTruthy();
  });

  it('does NOT render the stale stamp when stale is undefined', () => {
    const section = makeSection('lesions', [
      makeRow({ key: 'L1-size', itemId: 'L1', label: 'L1 size', value: '18.4 mm' }),
    ]);
    renderWithMantine(<ACRSectionLesions section={section} />);
    expect(screen.queryByTestId('acr-stale-stamp')).toBeNull();
  });

  it('renders the empty message when status="empty"', () => {
    const section = makeSection(
      'lesions',
      [],
      { status: 'empty', emptyMessage: 'No lesions detected' },
    );
    renderWithMantine(<ACRSectionLesions section={section} />);
    expect(screen.getByText('No lesions detected')).toBeTruthy();
  });

  it('renders the warning when a lesion row carries one', () => {
    const section = makeSection('lesions', [
      makeRow({
        key: 'L1',
        itemId: 'L1',
        label: 'L1',
        value: '18.4 mm',
        warning: 'Background HU pool empty — APHE call not reliable',
      }),
    ]);
    renderWithMantine(<ACRSectionLesions section={section} />);
    expect(
      screen.getByText('Background HU pool empty — APHE call not reliable'),
    ).toBeTruthy();
  });
});
