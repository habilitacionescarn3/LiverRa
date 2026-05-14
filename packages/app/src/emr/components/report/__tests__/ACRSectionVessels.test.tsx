// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionVessels render regression (M-UT-4).
 *
 * The vessels section is structural-only (FR-002) — it does NOT render
 * persisted vessel findings as rows. Visible content is the per-stage
 * ``vessels`` PNG fetched from the API. These tests cover:
 *   - The image renders with the correct ``src`` when ``analysisId`` is set.
 *   - The empty-message renders when no ``analysisId`` is supplied.
 *   - status="computing" produces a skeleton placeholder.
 *   - status="unavailable" surfaces the EMR alert with the message.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ACRSectionVessels } from '../ACRSectionVessels';
import { makeSection, renderWithMantine } from './_testFixtures';

describe('ACRSectionVessels', () => {
  it('renders the section frame and image when analysisId is set', () => {
    const section = makeSection('vessels', [], { status: 'present' });
    renderWithMantine(<ACRSectionVessels section={section} analysisId="a-123" />);
    expect(screen.getByTestId('acr-section-vessels')).toBeTruthy();
    // Mantine Image renders an underlying <img> — check the src wires through.
    const img = screen
      .getByTestId('acr-section-vessels')
      .querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src') ?? '').toContain('a-123');
    expect(img?.getAttribute('src') ?? '').toContain('vessels');
  });

  it('renders the empty-message when analysisId is missing', () => {
    const section = makeSection('vessels', [], {
      status: 'present',
      emptyMessage: 'Vessels render unavailable',
    });
    renderWithMantine(<ACRSectionVessels section={section} />);
    expect(screen.getByText('Vessels render unavailable')).toBeTruthy();
  });

  it('renders the unavailable alert when status="unavailable"', () => {
    const section = makeSection('vessels', [], {
      status: 'unavailable',
      emptyMessage: 'Cascade Stage 3 did not run',
    });
    renderWithMantine(
      <ACRSectionVessels section={section} analysisId="a-123" />,
    );
    expect(screen.getByText('Cascade Stage 3 did not run')).toBeTruthy();
  });

  it('renders a skeleton when status="computing"', () => {
    const section = makeSection('vessels', [], { status: 'computing' });
    renderWithMantine(
      <ACRSectionVessels section={section} analysisId="a-123" />,
    );
    // No image rendered while computing.
    const frame = screen.getByTestId('acr-section-vessels');
    expect(frame.querySelector('img')).toBeNull();
  });

  it('renders the section title', () => {
    const section = makeSection('vessels', [], {
      status: 'present',
      title: 'Vessels',
    });
    renderWithMantine(
      <ACRSectionVessels section={section} analysisId="a-1" />,
    );
    expect(screen.getByText('Vessels')).toBeTruthy();
  });
});
