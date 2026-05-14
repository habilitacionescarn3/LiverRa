// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// dicomParser.worker — Web Worker entry point for header parsing (M-PACS-1)
// ============================================================================
// Receives an ArrayBuffer + the file's name. Returns the extracted header
// metadata. The orchestrator (`dicomParserService.parseDicomFiles`) feeds
// one file at a time to a pool of these workers so the UI thread never
// freezes during a 500-file folder import.
//
// IMPORTANT: this module is a Vite ?worker module — the import path in
// `dicomParserService.ts` MUST use the `?worker` query suffix so Vite
// generates the right bundle entry. Tests stub the worker; do not import
// this file from non-worker code paths.
// ============================================================================

import dicomParser from 'dicom-parser';

interface WorkerRequest {
  jobId: number;
  buffer: ArrayBuffer;
  fileName: string;
}

interface WorkerResponse {
  jobId: number;
  ok: boolean;
  data?: {
    studyInstanceUID: string;
    seriesInstanceUID: string;
    studyDate: string;
    studyDescription: string;
    modality: string;
    bodyPartExamined: string;
    patientName: string;
    patientId: string;
  };
  error?: string;
}

const TAGS = {
  StudyInstanceUID: 'x0020000d',
  SeriesInstanceUID: 'x0020000e',
  StudyDate: 'x00080020',
  StudyDescription: 'x00081030',
  Modality: 'x00080060',
  BodyPartExamined: 'x00180015',
  PatientName: 'x00100010',
  PatientID: 'x00100020',
} as const;

function cleanDicomName(raw: string): string {
  return raw.replace(/\^/g, ' ').trim();
}

self.onmessage = (e: MessageEvent<WorkerRequest>): void => {
  const { jobId, buffer } = e.data;
  try {
    const byteArray = new Uint8Array(buffer);
    const dataSet = dicomParser.parseDicom(byteArray);
    const result: WorkerResponse = {
      jobId,
      ok: true,
      data: {
        studyInstanceUID: dataSet.string(TAGS.StudyInstanceUID) ?? '',
        seriesInstanceUID: dataSet.string(TAGS.SeriesInstanceUID) ?? '',
        studyDate: dataSet.string(TAGS.StudyDate) ?? '',
        studyDescription: dataSet.string(TAGS.StudyDescription) ?? '',
        modality: dataSet.string(TAGS.Modality) ?? '',
        bodyPartExamined: dataSet.string(TAGS.BodyPartExamined) ?? '',
        patientName: cleanDicomName(dataSet.string(TAGS.PatientName) ?? ''),
        patientId: dataSet.string(TAGS.PatientID) ?? '',
      },
    };
    (self as unknown as Worker).postMessage(result);
  } catch (err) {
    const result: WorkerResponse = {
      jobId,
      ok: false,
      error: err instanceof Error ? err.message : 'parse_failed',
    };
    (self as unknown as Worker).postMessage(result);
  }
};

export {}; // module
