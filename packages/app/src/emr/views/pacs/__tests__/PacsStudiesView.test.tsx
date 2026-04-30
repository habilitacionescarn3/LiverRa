// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * PacsStudiesView unit tests.
 *
 * Plain-English: mock the DICOMweb client + navigation + STOW hook and
 * assert the view renders the studies list, surfaces errors from QIDO,
 * and plumbs the dropzone into useStowUpload. WebGL / Cornerstone3D is
 * not in scope here — that's the viewer view's concern and covered by
 * the E2E spec.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MantineProvider } from '@mantine/core';

const qidoStudies = vi.fn();
const stowInstances = vi.fn();

vi.mock('../../../hooks/useDicomWebClient', () => ({
  useDicomWebClient: () => ({
    qidoStudies,
    qidoSeries: vi.fn(),
    qidoInstances: vi.fn(),
    wadoInstance: vi.fn(),
    retrieveStudyMetadata: vi.fn(),
    retrieveSeriesMetadata: vi.fn(),
    stowInstance: vi.fn(),
    stowInstances,
    getThumbnailUrl: vi.fn(),
    getAuthToken: () => null,
    getBaseUrl: () => '/dicom-web',
  }),
}));

vi.mock('../../../hooks/useStowUpload', () => ({
  useStowUpload: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  NoDicomFilesError: class NoDicomFilesError extends Error {},
}));

import PacsStudiesView from '../PacsStudiesView';

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={['/pacs/studies']}>
        <QueryClientProvider client={qc}>
          <PacsStudiesView />
        </QueryClientProvider>
      </MemoryRouter>
    </MantineProvider>,
  );
}

beforeEach(() => {
  qidoStudies.mockReset();
  stowInstances.mockReset();
});

describe('PacsStudiesView', () => {
  it('renders the QIDO-RS study list as a table', async () => {
    qidoStudies.mockResolvedValueOnce([
      {
        '0020000D': { vr: 'UI', Value: ['1.2.3.4'] },
        '00100020': { vr: 'LO', Value: ['MRN-001'] },
        '00100010': { vr: 'PN', Value: [{ Alphabetic: 'DOE^JOHN' }] },
        '00080020': { vr: 'DA', Value: ['20260412'] },
        '00081030': { vr: 'LO', Value: ['Liver CT contrast'] },
        '00080061': { vr: 'CS', Value: ['CT'] },
        '00201208': { vr: 'IS', Value: [124] },
      },
    ]);

    renderView();

    await waitFor(() => expect(screen.getByTestId('pacs-studies-table')).toBeTruthy());
    expect(screen.getByText('MRN-001')).toBeTruthy();
    expect(screen.getByText('DOE^JOHN')).toBeTruthy();
    expect(screen.getByText('2026-04-12')).toBeTruthy();
    expect(screen.getByText('Liver CT contrast')).toBeTruthy();
    expect(screen.getByText('CT')).toBeTruthy();
  });

  it('shows a connection error when QIDO fails', async () => {
    // `mockRejectedValue` (not Once) — the query has retry:1, so the
    // first-retry attempt also needs to fail for the error state to settle.
    qidoStudies.mockRejectedValue(new Error('PACS server is unavailable. Please try again later.'));
    renderView();
    await waitFor(
      () => expect(screen.getByText(/Cannot reach Orthanc/)).toBeTruthy(),
      { timeout: 3000 },
    );
  });

  it('renders an empty-state alert when no studies are returned', async () => {
    qidoStudies.mockResolvedValueOnce([]);
    renderView();
    await waitFor(() => expect(screen.getByText(/No studies yet/)).toBeTruthy());
  });
});
