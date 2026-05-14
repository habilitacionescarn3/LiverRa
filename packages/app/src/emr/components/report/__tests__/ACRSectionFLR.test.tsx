// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionFLR render regression (M-UT-4).
 *
 * FLR section stamps the ``flr-value`` row with ``flr-percent`` test id.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ACRSectionFLR } from '../ACRSectionFLR';
import {
  makeRow,
  makeSection,
  renderWithMantine,
  STALE_COMPUTED_AT,
} from './_testFixtures';

describe('ACRSectionFLR', () => {
  it('renders the section frame on the happy path', () => {
    const section = makeSection('flrAssessment', [
      makeRow({ key: 'flr-value', label: 'FLR', value: '28.4 %' }),
    ]);
    renderWithMantine(<ACRSectionFLR section={section} />);
    expect(screen.getByTestId('acr-section-flr')).toBeTruthy();
  });

  it('marks the flr-value row with the flr-percent test id', () => {
    const section = makeSection('flrAssessment', [
      makeRow({ key: 'flr-value', label: 'FLR', value: '28.4 %' }),
    ]);
    renderWithMantine(<ACRSectionFLR section={section} />);
    expect(screen.getByTestId('flr-percent').textContent).toContain('28.4 %');
  });

  it('renders the stale stamp when row.stale.computedAt is set', () => {
    const section = makeSection('flrAssessment', [
      makeRow({
        key: 'flr-value',
        label: 'FLR',
        value: '28.4 %',
        stale: { computedAt: STALE_COMPUTED_AT },
      }),
    ]);
    renderWithMantine(<ACRSectionFLR section={section} />);
    expect(screen.getByTestId('acr-stale-stamp')).toBeTruthy();
  });

  it('does NOT render the stale stamp when stale is undefined', () => {
    const section = makeSection('flrAssessment', [
      makeRow({ key: 'flr-value', label: 'FLR', value: '28.4 %' }),
    ]);
    renderWithMantine(<ACRSectionFLR section={section} />);
    expect(screen.queryByTestId('acr-stale-stamp')).toBeNull();
  });

  it('renders the warning when row.warning is set', () => {
    const section = makeSection('flrAssessment', [
      makeRow({
        key: 'flr-value',
        label: 'FLR',
        value: '28.4 %',
        warning: 'Couinaud heuristic produced partial result',
      }),
    ]);
    renderWithMantine(<ACRSectionFLR section={section} />);
    expect(
      screen.getByText('Couinaud heuristic produced partial result'),
    ).toBeTruthy();
  });

  it('renders the empty message when status="empty"', () => {
    const section = makeSection(
      'flrAssessment',
      [],
      { status: 'empty', emptyMessage: 'FLR computation pending' },
    );
    renderWithMantine(<ACRSectionFLR section={section} />);
    expect(screen.getByText('FLR computation pending')).toBeTruthy();
  });

  it('renders rounded values per Agent 3.4 parity (.toFixed(1))', () => {
    // The CALLER passes already-formatted strings to ReadoutRow.value —
    // we just verify the component renders them verbatim without
    // re-formatting (no surprise truncation).
    const section = makeSection('flrAssessment', [
      makeRow({ key: 'flr-value', label: 'FLR', value: '518.5 mL (28.4 %)' }),
    ]);
    renderWithMantine(<ACRSectionFLR section={section} />);
    expect(screen.getByText('518.5 mL (28.4 %)')).toBeTruthy();
  });
});
