// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// DICOM Header Parser Service (LiverRa)
// ============================================================================
// Reads DICOM file headers (metadata) using the dicom-parser library.
// Think of it like reading the label on a medicine bottle — the file contains
// the actual images, but the header tells us whose scan it is, what body
// part, what date, etc.
//
// Groups files by StudyInstanceUID so we know how many separate studies
// are in a folder of DICOM files.
//
// Ported drop-in from MediMind `services/pacs/dicomParserService.ts`. This
// file runs in the browser BEFORE the scrubber pipeline (the real
// anonymization happens server-side at the edge via CTP); the in-browser
// `anonymizeDicom()` helper is a best-effort preview for local testing only.
// ============================================================================

import dicomParser from 'dicom-parser';

// ============================================================================
// Types
// ============================================================================

/** Metadata extracted from a single DICOM file */
export interface DicomFileMetadata {
  file: File;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  studyDate: string;
  studyDescription: string;
  modality: string;
  bodyPartExamined: string;
  patientName: string;
  patientId: string;
}

/** Aggregated metadata for one study (a group of related images) */
export interface DicomStudySummary {
  studyInstanceUID: string;
  studyDate: string;
  studyDescription: string;
  modalities: string[];
  bodyPartExamined: string;
  patientName: string;
  patientId: string;
  fileCount: number;
  seriesCount: number;
  files: File[];
}

// ============================================================================
// DICOM Tag Constants (tag numbers in hex)
// ============================================================================

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

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse DICOM headers from a list of files.
 * Returns metadata for each file that could be successfully parsed.
 * Files that fail to parse (corrupt, not DICOM) are silently skipped.
 */
export async function parseDicomFiles(files: File[]): Promise<DicomFileMetadata[]> {
  const results: DicomFileMetadata[] = [];

  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const byteArray = new Uint8Array(buffer);
      const dataSet = dicomParser.parseDicom(byteArray);

      results.push({
        file,
        studyInstanceUID: dataSet.string(TAGS.StudyInstanceUID) ?? '',
        seriesInstanceUID: dataSet.string(TAGS.SeriesInstanceUID) ?? '',
        studyDate: dataSet.string(TAGS.StudyDate) ?? '',
        studyDescription: dataSet.string(TAGS.StudyDescription) ?? '',
        modality: dataSet.string(TAGS.Modality) ?? '',
        bodyPartExamined: dataSet.string(TAGS.BodyPartExamined) ?? '',
        patientName: cleanDicomName(dataSet.string(TAGS.PatientName) ?? ''),
        patientId: dataSet.string(TAGS.PatientID) ?? '',
      });
    } catch {
      // Skip files that can't be parsed — already filtered by DICM validation
    }
  }

  return results;
}

/**
 * Group parsed DICOM files by StudyInstanceUID and return a summary per study.
 * Tells us "you have 2 studies: a chest CT with 120 images and a skull X-ray
 * with 2 images".
 */
export function groupByStudy(metadata: DicomFileMetadata[]): DicomStudySummary[] {
  const studyMap = new Map<string, DicomFileMetadata[]>();

  for (const item of metadata) {
    const uid = item.studyInstanceUID || 'unknown';
    const group = studyMap.get(uid);
    if (group) {
      group.push(item);
    } else {
      studyMap.set(uid, [item]);
    }
  }

  const summaries: DicomStudySummary[] = [];

  for (const [uid, items] of studyMap) {
    const modalities = [...new Set(items.map((i) => i.modality).filter(Boolean))];
    const seriesUIDs = new Set(items.map((i) => i.seriesInstanceUID).filter(Boolean));

    const first = items[0];

    summaries.push({
      studyInstanceUID: uid,
      studyDate: first.studyDate,
      studyDescription: first.studyDescription,
      modalities,
      bodyPartExamined: first.bodyPartExamined,
      patientName: first.patientName,
      patientId: first.patientId,
      fileCount: items.length,
      seriesCount: seriesUIDs.size,
      files: items.map((i) => i.file),
    });
  }

  return summaries;
}

// ============================================================================
// DICOM Anonymization (Supplement 142 Basic Profile)
// ============================================================================
// Strips PHI tags from a DICOM file per DICOM Supplement 142 "Basic
// Application Level Confidentiality Profile". Authoritative anonymization
// in LiverRa happens server-side at the edge (CTP + PHI scrubber per
// plan §PACS); this client-side helper is preserved for local preview
// workflows and unit tests only.
//
// CRITICAL: All listed PHI tags MUST be cleared. Missing even one tag could
// expose patient data and violate GDPR / HIPAA obligations.
// ============================================================================

/**
 * PHI tags to strip/replace per DICOM Supplement 142.
 * Key = DICOM tag (x + group + element, lowercase).
 * Value = replacement string (empty = clear, non-empty = replace).
 */
const PHI_TAGS: Record<string, string> = {
  'x00100010': 'ANONYMOUS', // PatientName
  'x00100020': 'ANON000', // PatientID
  'x00100030': '', // PatientBirthDate
  'x00100040': '', // PatientSex
  'x00101010': '', // PatientAge
  'x00101001': '', // OtherPatientNames
  'x00080050': '', // AccessionNumber
  'x00080080': '', // InstitutionName
  'x00080081': '', // InstitutionAddress
  'x00080090': '', // ReferringPhysicianName
  'x00081048': '', // PhysiciansOfRecord
  'x00081050': '', // PerformingPhysicianName
  'x00081070': '', // OperatorsName
  'x00101000': '', // OtherPatientIDs
  'x00102160': '', // EthnicGroup
  'x00204000': '', // ImageComments
};

const DEIDENTIFICATION_METHOD_TAG = 'x00120063';
const DEIDENTIFICATION_METHOD_VALUE = 'DICOM Supplement 142 Basic Profile';

/**
 * Anonymize a DICOM file by stripping/replacing PHI tags in-place.
 * Returns a new ArrayBuffer with PHI tags cleared/replaced.
 */
export function anonymizeDicom(arrayBuffer: ArrayBuffer): ArrayBuffer {
  const copy = arrayBuffer.slice(0);
  const byteArray = new Uint8Array(copy);
  const dataSet = dicomParser.parseDicom(byteArray);

  for (const [tag, replacement] of Object.entries(PHI_TAGS)) {
    const element = dataSet.elements[tag];
    if (!element) {
      continue;
    }

    const replacementBytes = stringToBytes(replacement);
    const len = element.length;

    for (let i = 0; i < len; i++) {
      if (i < replacementBytes.length) {
        byteArray[element.dataOffset + i] = replacementBytes[i];
      } else {
        byteArray[element.dataOffset + i] = 0x20;
      }
    }
  }

  const deidentElement = dataSet.elements[DEIDENTIFICATION_METHOD_TAG];
  if (deidentElement) {
    const deidentBytes = stringToBytes(DEIDENTIFICATION_METHOD_VALUE);
    const len = deidentElement.length;
    for (let i = 0; i < len; i++) {
      if (i < deidentBytes.length) {
        byteArray[deidentElement.dataOffset + i] = deidentBytes[i];
      } else {
        byteArray[deidentElement.dataOffset + i] = 0x20;
      }
    }
  }

  return copy;
}

/**
 * Fetch a DICOM file, anonymize it, and trigger a browser download as .dcm.
 */
export function downloadAnonymizedDicom(
  studyInstanceUID: string,
  dicomArrayBuffer: ArrayBuffer
): void {
  const anonymized = anonymizeDicom(dicomArrayBuffer);
  const blob = new Blob([anonymized], { type: 'application/dicom' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  const uidSuffix = studyInstanceUID.slice(-8);
  link.download = `anon_${uidSuffix}_${date}.dcm`;
  link.href = url;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ============================================================================
// Helpers
// ============================================================================

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i);
  }
  return bytes;
}

/**
 * Clean a DICOM person name by replacing ^ separators with spaces.
 * DICOM stores names as "LAST^FIRST^MIDDLE" → "LAST FIRST MIDDLE".
 */
function cleanDicomName(raw: string): string {
  return raw.replace(/\^/g, ' ').trim();
}
