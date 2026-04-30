// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useStowUpload.
 *
 * Plain-English: takes the DICOM files a user dropped, figures out which
 * study (StudyInstanceUID) they belong to by reading each file's header,
 * then ships them straight to Orthanc via STOW-RS. On success it navigates
 * to the PACS viewer for that study and invalidates the studies query so
 * the list refreshes. No backend in between — browser talks directly to
 * the Vite-proxied `/dicom-web/studies` endpoint.
 *
 * Why separate from `useDropzoneUpload`? That hook is the tus-based path
 * that flows into the mocked AI-analysis pipeline (future T306). This hook
 * is the direct PACS path for the `/pacs/studies/*` views — a different
 * product surface with different semantics (no analysis, no SSE).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { parseDicomFiles, groupByStudy } from '../services/pacs/dicomParserService';
import type { StowResult } from '../services/pacs/dicomwebClient';
import { useDicomWebClient } from './useDicomWebClient';

export interface StowUploadResult {
  /** StudyInstanceUID of the (first, if multiple) uploaded study. */
  studyInstanceUid: string;
  /** Combined STOW-RS success/failure summary across every file. */
  stow: StowResult;
  /** Number of distinct studies the dropped files belonged to. */
  studyCount: number;
}

export interface UseStowUploadOptions {
  /**
   * Called after every file has been sent. Default behaviour: invalidate
   * `['pacs', 'studies']` + navigate to `/pacs/studies/{uid}`. Override
   * for tests or alt flows.
   */
  onUploaded?: (result: StowUploadResult) => void;
}

export class NoDicomFilesError extends Error {
  constructor() {
    super('None of the dropped files could be parsed as DICOM.');
    this.name = 'NoDicomFilesError';
  }
}

export function useStowUpload(options: UseStowUploadOptions = {}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const client = useDicomWebClient();

  return useMutation<StowUploadResult, Error, File[]>({
    mutationFn: async (files) => {
      const parsed = await parseDicomFiles(files);
      if (parsed.length === 0) {
        throw new NoDicomFilesError();
      }
      const studies = groupByStudy(parsed);
      const primary = studies[0];

      // STOW every valid DICOM — Orthanc de-dupes by SOP Instance UID so
      // re-uploads are idempotent. Files that failed to parse are dropped
      // client-side (see parseDicomFiles; silently skipped) so we never
      // ship garbage to the PACS.
      const stow = await client.stowInstances(parsed.map((p) => p.file));

      return {
        studyInstanceUid: primary.studyInstanceUID,
        stow,
        studyCount: studies.length,
      };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['pacs', 'studies'] });
      if (options.onUploaded) {
        options.onUploaded(result);
        return;
      }
      navigate(`/pacs/studies/${encodeURIComponent(result.studyInstanceUid)}`);
    },
  });
}
