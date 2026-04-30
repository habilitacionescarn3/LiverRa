// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useStowUpload unit tests.
 *
 * Plain-English: prove the hook (a) parses dropped files to extract the
 * study UID, (b) ships them via STOW-RS, (c) invalidates the studies query
 * + navigates to the viewer on success, and (d) surfaces a readable error
 * when nothing parseable was dropped.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// Mock the DICOM parser + DICOMweb client before importing the hook so the
// hook picks up the doubles.
const stowInstances = vi.fn();
const parseDicomFiles = vi.fn();

vi.mock('../../services/pacs/dicomParserService', () => ({
  parseDicomFiles: (...args: unknown[]) => parseDicomFiles(...args),
  groupByStudy: (metadata: Array<{ studyInstanceUID: string; file: File }>) => {
    const byStudy = new Map<string, Array<{ studyInstanceUID: string; file: File }>>();
    for (const m of metadata) {
      const arr = byStudy.get(m.studyInstanceUID) ?? [];
      arr.push(m);
      byStudy.set(m.studyInstanceUID, arr);
    }
    return Array.from(byStudy.entries()).map(([studyInstanceUID, items]) => ({
      studyInstanceUID,
      studyDate: '',
      studyDescription: '',
      modalities: [],
      bodyPartExamined: '',
      patientName: '',
      patientId: '',
      fileCount: items.length,
      seriesCount: 1,
      files: items.map((i) => i.file),
    }));
  },
}));

vi.mock('../useDicomWebClient', () => ({
  useDicomWebClient: () => ({
    stowInstances,
    qidoStudies: vi.fn(),
    qidoSeries: vi.fn(),
    qidoInstances: vi.fn(),
    wadoInstance: vi.fn(),
    retrieveStudyMetadata: vi.fn(),
    retrieveSeriesMetadata: vi.fn(),
    stowInstance: vi.fn(),
    getThumbnailUrl: vi.fn(),
    getAuthToken: () => null,
    getBaseUrl: () => '/dicom-web',
  }),
}));

import { NoDicomFilesError, useStowUpload } from '../useStowUpload';

function wrap(): (p: { children: ReactNode }) => JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }) {
    return (
      <MemoryRouter initialEntries={['/pacs/studies']}>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </MemoryRouter>
    );
  };
}

function fakeFile(name = 'ct.dcm'): File {
  return new File([new Uint8Array(16)], name, { type: 'application/dicom' });
}

beforeEach(() => {
  stowInstances.mockReset();
  parseDicomFiles.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useStowUpload', () => {
  it('STOWs parsed files and surfaces the study UID', async () => {
    const f1 = fakeFile('a.dcm');
    const f2 = fakeFile('b.dcm');
    parseDicomFiles.mockResolvedValueOnce([
      { file: f1, studyInstanceUID: '1.2.3', seriesInstanceUID: '1.2.3.1', studyDate: '', studyDescription: '', modality: 'CT', bodyPartExamined: '', patientName: '', patientId: '' },
      { file: f2, studyInstanceUID: '1.2.3', seriesInstanceUID: '1.2.3.1', studyDate: '', studyDescription: '', modality: 'CT', bodyPartExamined: '', patientName: '', patientId: '' },
    ]);
    stowInstances.mockResolvedValueOnce({ successCount: 2, failedCount: 0, failures: [] });

    const onUploaded = vi.fn();
    const { result } = renderHook(() => useStowUpload({ onUploaded }), {
      wrapper: wrap(),
    });

    await result.current.mutateAsync([f1, f2]);

    expect(stowInstances).toHaveBeenCalledWith([f1, f2]);
    expect(onUploaded).toHaveBeenCalledWith({
      studyInstanceUid: '1.2.3',
      stow: { successCount: 2, failedCount: 0, failures: [] },
      studyCount: 1,
    });
  });

  it('navigates to /pacs/studies/{uid} when no onUploaded callback is supplied', async () => {
    parseDicomFiles.mockResolvedValueOnce([
      { file: fakeFile(), studyInstanceUID: '9.9.9', seriesInstanceUID: '9.9.9.1', studyDate: '', studyDescription: '', modality: 'CT', bodyPartExamined: '', patientName: '', patientId: '' },
    ]);
    stowInstances.mockResolvedValueOnce({ successCount: 1, failedCount: 0, failures: [] });

    let observedPath = '';
    function LocationSink(): null {
      const loc = useLocation();
      observedPath = loc.pathname;
      return null;
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useStowUpload(), {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/pacs/studies']}>
          <QueryClientProvider client={qc}>
            <Routes>
              <Route path="*" element={<>{children}<LocationSink /></>} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>
      ),
    });

    await result.current.mutateAsync([fakeFile()]);
    await waitFor(() => expect(observedPath).toBe('/pacs/studies/9.9.9'));
  });

  it('throws NoDicomFilesError when nothing parses as DICOM', async () => {
    parseDicomFiles.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useStowUpload({ onUploaded: vi.fn() }), {
      wrapper: wrap(),
    });

    await expect(result.current.mutateAsync([fakeFile()])).rejects.toBeInstanceOf(
      NoDicomFilesError,
    );
    expect(stowInstances).not.toHaveBeenCalled();
  });
});
