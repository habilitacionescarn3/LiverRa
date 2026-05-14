// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// StudyImporter (LiverRa)
// ============================================================================
// Drag-and-drop DICOM uploader. Validates files by checking the DICM magic
// bytes, groups by StudyInstanceUID, uploads to PACS via STOW-RS (Orthanc),
// optionally creates a FHIR ImagingStudy stub, then prompts for patient
// matching.
//
// Ported from MediMind. Adaptations:
//   - `useMedplum()` → `useLiverraFhir()`. The FHIR writes today are no-ops
//     via the Phase-1 shim — the real STOW-RS upload still hits Orthanc
//     directly through `useDicomWebClient`, which is already wired to a
//     live server.
//   - Medplum search / create calls swapped to the shim (stubs log the call
//     so we can see what Phase 4 needs to implement).
//   - `storeInstances` is the shared STOW-RS helper on the LiverRa DICOMweb
//     client — same method name, so the call site is unchanged.
// ============================================================================

import React, {
  memo,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from 'react';
import { Box, Group, Text, Stack, Loader, Alert } from '@mantine/core';
import {
  IconUpload,
  IconFileCheck,
  IconFileX,
  IconFolder,
  IconTrash,
  IconX,
  IconCircleCheck,
  IconCircleX,
  IconAlertTriangle,
  IconUser,
  IconSearch,
  IconLink,
  IconPhotoUp,
  IconCloudUpload,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import { useLiverraFhir } from '../../hooks/useLiverraFhir';
import { useDicomWebClient } from '../../hooks/useDicomWebClient';
import type { FhirResourceLike } from '../../services/fhirClient';
import {
  parseDicomFiles,
  groupByStudy,
} from '../../services/pacs/dicomParserService';
import type { DicomStudySummary } from '../../services/pacs/dicomParserService';
import { EMRButton } from '../common/EMRButton';
import { EMRTextInput } from '../shared/EMRFormFields/EMRTextInput';
import styles from './StudyImporter.module.css';

// ============================================================================
// Local types
// ============================================================================

interface DicomFileEntry {
  file: File;
  id: string;
  valid: boolean;
}

type ImporterState =
  | 'idle'
  | 'validating'
  | 'ready'
  | 'parsing'
  | 'uploading'
  | 'matching'
  | 'complete';

interface UploadResult {
  successCount: number;
  failedCount: number;
  failures?: string[];
}

interface PreviewStudyGroup {
  studyKey: string;
  summary: DicomStudySummary | null;
  fileIds: string[];
}

interface PatientLike extends FhirResourceLike {
  resourceType: 'Patient';
  id?: string;
  name?: Array<{ family?: string; given?: string[] }>;
  identifier?: Array<{ system?: string; value?: string }>;
}

interface ImagingStudyResource extends FhirResourceLike {
  resourceType: 'ImagingStudy';
  status: 'available';
  subject: { reference?: string; display?: string; type?: string };
  started?: string;
  description?: string;
  numberOfSeries?: number;
  numberOfInstances?: number;
  modality?: Array<{ system: string; code: string }>;
  identifier?: Array<{ system: string; value: string }>;
}

// ============================================================================
// Props
// ============================================================================

export interface StudyImporterProps {
  /** Pre-selected patient ID (when importing from a patient imaging tab). */
  preSelectedPatientId?: string;
  /** Pre-selected patient display name. */
  preSelectedPatientName?: string;
  /** Called after a successful import. */
  onImportComplete?: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** Validate a file by checking bytes 128–131 for the DICM magic number. */
async function validateDicomFile(file: File): Promise<boolean> {
  if (file.size < 132) {
    return false;
  }
  try {
    const buffer = await file.slice(128, 132).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    return (
      bytes[0] === 0x44 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x43 &&
      bytes[3] === 0x4d
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[StudyImporter] DICOM file validation failed:', err);
    return false;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatStudyDate(raw: string): string {
  if (!raw || raw.length < 8) {
    return '';
  }
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  const d = new Date(`${year}-${month}-${day}`);
  if (isNaN(d.getTime())) {
    return `${year}-${month}-${day}`;
  }
  return d.toLocaleDateString();
}

// --------------------------------------------------------------------------
// Recursive dropped-folder collector (webkitGetAsEntry API)
// --------------------------------------------------------------------------

function readEntryAsFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readDirectoryEntries(
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function collectFilesFromEntry(
  entry: FileSystemEntry
): Promise<File[]> {
  if (entry.isFile) {
    try {
      const file = await readEntryAsFile(entry as FileSystemFileEntry);
      return [file];
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[StudyImporter] Failed to read file entry:', err);
      return [];
    }
  }

  if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const files: File[] = [];
    let batch = await readDirectoryEntries(dirReader);
    while (batch.length > 0) {
      for (const child of batch) {
        const childFiles = await collectFilesFromEntry(child);
        files.push(...childFiles);
      }
      batch = await readDirectoryEntries(dirReader);
    }
    return files;
  }

  return [];
}

async function collectFilesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<File[]> {
  const items = dataTransfer.items;
  if (
    items &&
    items.length > 0 &&
    typeof items[0].webkitGetAsEntry === 'function'
  ) {
    const allFiles: File[] = [];
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
      }
    }
    for (const entry of entries) {
      const files = await collectFilesFromEntry(entry);
      allFiles.push(...files);
    }
    if (allFiles.length > 0) {
      return allFiles;
    }
  }
  return Array.from(dataTransfer.files);
}

// ============================================================================
// Sub-components
// ============================================================================

function PreSelectedBanner({
  name,
  t,
}: {
  name: string;
  t: (k: string) => string;
}): React.ReactElement {
  return (
    <div className={styles.preSelectedBanner}>
      <span className={styles.preSelectedBannerIcon}>
        <IconUser size={18} />
      </span>
      <Text size="sm">
        {t('pacs.import.preSelectedPatient')}:{' '}
        <span className={styles.preSelectedBannerName}>{name}</span>
      </Text>
    </div>
  );
}

function SummaryStrip({
  validCount,
  invalidCount,
  totalSize,
  t,
}: {
  validCount: number;
  invalidCount: number;
  totalSize: number;
  t: (k: string) => string;
}): React.ReactElement {
  return (
    <div className={styles.summaryStrip} data-testid="dicom-summary-strip">
      <span className={styles.summaryChip}>
        <span
          className={`${styles.summaryChipDot} ${styles.summaryChipDotValid}`}
        />
        {t('pacs.import.validFiles').replace('{count}', String(validCount))}
      </span>
      {invalidCount > 0 && (
        <span className={styles.summaryChip}>
          <span
            className={`${styles.summaryChipDot} ${styles.summaryChipDotInvalid}`}
          />
          {t('pacs.import.invalidFiles').replace(
            '{count}',
            String(invalidCount)
          )}
        </span>
      )}
      <span className={styles.summaryChip}>
        <span
          className={`${styles.summaryChipDot} ${styles.summaryChipDotTotal}`}
        />
        <span className={styles.summaryChipLabel}>
          {t('pacs.import.totalFiles').replace(
            '{count}',
            String(validCount + invalidCount)
          )}
        </span>
      </span>
      <span className={styles.summaryStripSpacer} />
      <span className={styles.summaryTotalSize}>{formatFileSize(totalSize)}</span>
    </div>
  );
}

const FileRow = memo(function FileRow({
  entry,
  onRemove,
  t,
}: {
  entry: DicomFileEntry;
  onRemove: (id: string) => void;
  t: (k: string) => string;
}): React.ReactElement {
  return (
    <div
      className={`${styles.fileItem} ${entry.valid ? '' : styles.fileItemInvalid}`}
    >
      <span className={styles.fileStatusIcon}>
        {entry.valid ? (
          <IconFileCheck
            size={20}
            style={{ color: 'var(--emr-success)' }}
          />
        ) : (
          <IconFileX size={20} style={{ color: 'var(--emr-error)' }} />
        )}
      </span>
      <div className={styles.fileInfo}>
        <div className={styles.fileName}>{entry.file.name}</div>
        <div className={styles.fileSize}>{formatFileSize(entry.file.size)}</div>
      </div>
      <span
        className={`${styles.fileStatusChip} ${
          entry.valid
            ? styles.fileStatusChipValid
            : styles.fileStatusChipInvalid
        }`}
      >
        {entry.valid
          ? t('pacs.import.statusValid')
          : t('pacs.import.statusRejected')}
      </span>
      <button
        type="button"
        className={styles.removeFileButton}
        onClick={() => onRemove(entry.id)}
        aria-label={t('pacs.import.removeFile')}
        title={t('pacs.import.removeFile')}
      >
        <IconX size={16} />
      </button>
    </div>
  );
});

const StudyGroupCard = memo(function StudyGroupCard({
  summary,
  files,
  onRemove,
  t,
}: {
  summary: DicomStudySummary | null;
  files: DicomFileEntry[];
  onRemove: (id: string) => void;
  t: (k: string) => string;
}): React.ReactElement {
  const modality = summary?.modalities?.[0] || 'DICOM';
  const modalityChipClass =
    modality === 'DICOM'
      ? `${styles.studyModalityChip} ${styles.studyModalityChipUnknown}`
      : styles.studyModalityChip;

  return (
    <div className={styles.studyGroupCard}>
      <div className={styles.studyGroupHeader}>
        <span className={modalityChipClass}>{modality}</span>
        <div className={styles.studyHeaderInfo}>
          <div className={styles.studyHeaderTitle}>
            {summary?.studyDescription ||
              summary?.bodyPartExamined ||
              t('pacs.import.study')}
          </div>
          <div className={styles.studyHeaderMeta}>
            {summary?.patientName && <span>{summary.patientName}</span>}
            {summary?.patientName && summary?.studyDate && (
              <span className={styles.studyHeaderMetaSep}>•</span>
            )}
            {summary?.studyDate && (
              <span>{formatStudyDate(summary.studyDate)}</span>
            )}
            {(summary?.seriesCount ?? 0) > 0 && (
              <>
                <span className={styles.studyHeaderMetaSep}>•</span>
                <span>
                  {summary?.seriesCount} {t('pacs.import.series')}
                </span>
              </>
            )}
          </div>
        </div>
        <span className={styles.studyHeaderCount}>
          {files.length}{' '}
          {files.length === 1
            ? t('pacs.import.file')
            : t('pacs.import.files')}
        </span>
      </div>
      <div className={styles.fileList}>
        {files.map((entry) => (
          <FileRow
            key={entry.id}
            entry={entry}
            onRemove={onRemove}
            t={t}
          />
        ))}
      </div>
    </div>
  );
});

// ============================================================================
// Main
// ============================================================================

export const StudyImporter = memo(function StudyImporter({
  preSelectedPatientId,
  preSelectedPatientName,
  onImportComplete,
}: StudyImporterProps): React.ReactElement {
  const { t } = useTranslation();
  const fhir = useLiverraFhir();
  const dicomWebClient = useDicomWebClient();

  const fileIdCounterRef = useRef(0);

  // ---- State ----
  const [state, setState] = useState<ImporterState>('idle');
  const [files, setFiles] = useState<DicomFileEntry[]>([]);
  const [studySummaries, setStudySummaries] = useState<DicomStudySummary[]>([]);
  const [previewGroups, setPreviewGroups] = useState<PreviewStudyGroup[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadCurrentFile, setUploadCurrentFile] = useState('');
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [patientSearchQuery, setPatientSearchQuery] = useState('');
  const [patientResults, setPatientResults] = useState<PatientLike[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<PatientLike | null>(
    null
  );
  const [patientSearchLoading, setPatientSearchLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // ---- Derived ----
  const validFiles = useMemo(
    () => files.filter((f) => f.valid),
    [files]
  );
  const invalidFiles = useMemo(
    () => files.filter((f) => !f.valid),
    [files]
  );
  const totalSize = useMemo(
    () => files.reduce((s, f) => s + f.file.size, 0),
    [files]
  );

  // ---- Live study grouping preview (300ms debounced, capped at 40 files) ----
  useEffect(() => {
    if (state !== 'ready' || validFiles.length === 0) {
      setPreviewGroups([]);
      return;
    }

    if (validFiles.length > 40) {
      setPreviewGroups([
        {
          studyKey: 'bulk',
          summary: null,
          fileIds: validFiles.map((f) => f.id),
        },
      ]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const metadata = await parseDicomFiles(validFiles.map((f) => f.file));
        if (cancelled) return;
        const grouped = groupByStudy(metadata);
        const groups: PreviewStudyGroup[] = grouped.map((summary) => {
          const fileIds = validFiles
            .filter((entry) => summary.files.includes(entry.file))
            .map((entry) => entry.id);
          return {
            studyKey: summary.studyInstanceUID,
            summary,
            fileIds,
          };
        });
        setPreviewGroups(groups);
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn(
          '[StudyImporter] Preview grouping failed, falling back to flat list:',
          err
        );
        setPreviewGroups([
          {
            studyKey: 'fallback',
            summary: null,
            fileIds: validFiles.map((f) => f.id),
          },
        ]);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state, validFiles]);

  // ---- Validation ----
  const processFiles = useCallback(
    async (fileList: FileList | File[]) => {
      setState('validating');

      const entries: DicomFileEntry[] = [];
      const rawFiles = Array.from(fileList);

      for (const file of rawFiles) {
        const valid = await validateDicomFile(file);
        fileIdCounterRef.current += 1;
        entries.push({
          file,
          id: `dcm-${fileIdCounterRef.current}`,
          valid,
        });
      }

      setFiles((prev) => [...prev, ...entries]);
      setState('ready');
    },
    []
  );

  // ---- Drag & drop ----
  const [isDragActive, setIsDragActive] = useState(false);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragActive(false);

      const collectedFiles = await collectFilesFromDataTransfer(e.dataTransfer);
      if (collectedFiles.length > 0) {
        try {
          await processFiles(collectedFiles);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[StudyImporter] processFiles failed:', err);
          setState('idle');
        }
      }
    },
    [processFiles]
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        void processFiles(e.target.files);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [processFiles]
  );

  const handleBrowseClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFolderInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        void processFiles(e.target.files);
      }
      if (folderInputRef.current) {
        folderInputRef.current.value = '';
      }
    },
    [processFiles]
  );

  const handleBrowseFolderClick = useCallback(() => {
    folderInputRef.current?.click();
  }, []);

  // ---- File management ----
  const handleRemoveFile = useCallback((id: string) => {
    setFiles((prev) => {
      const next = prev.filter((f) => f.id !== id);
      if (next.length === 0) {
        setState('idle');
      }
      return next;
    });
  }, []);

  const handleRemoveAll = useCallback(() => {
    setFiles([]);
    setState('idle');
  }, []);

  // ---- Upload (STOW-RS to Orthanc + FHIR ImagingStudy stub) ----
  const handleStartUpload = useCallback(async () => {
    if (validFiles.length === 0) {
      return;
    }

    // H-PACS-6: REJECT the upload if no anonymization sidecar URL is
    // configured. Without it, raw DICOM (PatientName, MRN, DOB) flows
    // straight to Orthanc. The dev-only proxy fallback in vite.config
    // does NOT protect production deployments; failing closed here is
    // the safe default. Operators may set
    // VITE_LIVERRA_ANON_SIDECAR_BYPASS=true to opt out for offline
    // testing — that flag is mirrored to AuditEvent at sidecar level.
    const env = (import.meta as unknown as {
      env?: { VITE_LIVERRA_ANON_SIDECAR_URL?: string; VITE_LIVERRA_ANON_SIDECAR_BYPASS?: string; PROD?: boolean };
    }).env ?? {};
    const sidecarUrl = (env.VITE_LIVERRA_ANON_SIDECAR_URL || '').trim();
    const sidecarBypass =
      (env.VITE_LIVERRA_ANON_SIDECAR_BYPASS || '').toLowerCase() === 'true';
    if (!sidecarUrl && !sidecarBypass) {
      setUploadError(
        t('pacs.import.sidecarRequired') ??
          'DICOM anonymization sidecar is not configured. Refusing to upload raw DICOM (PHI safety). Contact your administrator.',
      );
      setState('complete');
      // eslint-disable-next-line no-console
      console.warn(
        '[StudyImporter] upload blocked: VITE_LIVERRA_ANON_SIDECAR_URL is unset',
      );
      return;
    }
    if (sidecarBypass && env.PROD) {
      // eslint-disable-next-line no-console
      console.warn(
        '[StudyImporter] sidecar bypass enabled IN PRODUCTION — every uploaded DICOM bypasses anonymization. This is auditable.',
      );
    }

    const validFileObjects = validFiles.map((f) => f.file);

    // Phase 1: parse DICOM headers.
    setState('parsing');
    setUploadProgress(0);
    setUploadError(null);
    setUploadCurrentFile(t('pacs.import.parsingFiles'));

    let summaries: DicomStudySummary[];
    try {
      const metadata = await parseDicomFiles(validFileObjects);
      summaries = groupByStudy(metadata);
      setStudySummaries(summaries);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[StudyImporter] DICOM header parsing failed:', err);
      setUploadError(t('pacs.import.uploadError'));
      setState('complete');
      return;
    }

    // Phase 2: STOW-RS upload, one batch per study for correct grouping.
    setState('uploading');
    setUploadCurrentFile(t('pacs.import.uploadingToServer'));

    let totalSuccess = 0;
    let totalFailed = 0;
    const allFailures: string[] = [];

    try {
      for (let i = 0; i < summaries.length; i++) {
        const study = summaries[i];
        setUploadProgress(Math.round((i / summaries.length) * 80));
        setUploadCurrentFile(
          study.studyDescription || study.studyInstanceUID
        );

        try {
          const result = await dicomWebClient.stowInstances(study.files);
          totalSuccess += result.successCount;
          totalFailed += result.failedCount;
          if (result.failures?.length) {
            allFailures.push(...result.failures);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            '[StudyImporter] STOW-RS upload failed for study:',
            study.studyInstanceUID,
            err
          );
          totalFailed += study.fileCount;
        }
      }

      // Phase 3: create FHIR ImagingStudy stubs via the shim.
      setUploadProgress(85);
      setUploadCurrentFile(t('pacs.import.creatingRecord'));

      const patientId = preSelectedPatientId;

      for (const study of summaries) {
        try {
          const imagingStudy: ImagingStudyResource = {
            resourceType: 'ImagingStudy',
            status: 'available',
            subject: patientId
              ? { reference: `Patient/${patientId}` }
              : { type: 'Patient', display: study.patientName || 'Unknown' },
            started: study.studyDate
              ? `${study.studyDate.slice(0, 4)}-${study.studyDate.slice(
                  4,
                  6
                )}-${study.studyDate.slice(6, 8)}`
              : undefined,
            description: study.studyDescription || undefined,
            numberOfSeries: study.seriesCount || undefined,
            numberOfInstances: study.fileCount || undefined,
            modality: study.modalities.map((m) => ({
              system: 'http://dicom.nema.org/resources/ontology/DCM',
              code: m,
            })),
            identifier: [
              {
                system: 'urn:dicom:uid',
                value: `urn:oid:${study.studyInstanceUID}`,
              },
            ],
          };

          await fhir.createResource(imagingStudy);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            '[StudyImporter] FHIR ImagingStudy stub failed (bridge will retry in Phase 4):',
            err
          );
        }
      }

      setUploadProgress(100);
      setUploadResult({
        successCount: totalSuccess,
        failedCount: totalFailed,
        failures: allFailures,
      });

      if (preSelectedPatientId) {
        setState('complete');
        onImportComplete?.();
      } else {
        setState('matching');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[StudyImporter] Upload workflow failed:', err);
      totalFailed = validFiles.length - totalSuccess;
      setUploadResult({
        successCount: totalSuccess,
        failedCount: totalFailed,
      });
      setUploadError(t('pacs.import.uploadError'));
      setState('complete');
    }
  }, [validFiles, preSelectedPatientId, t, dicomWebClient, fhir, onImportComplete]);

  // ---- Patient search ----
  const handlePatientSearch = useCallback(async () => {
    if (!patientSearchQuery.trim()) {
      setPatientResults([]);
      return;
    }

    setPatientSearchLoading(true);
    try {
      const bundle = await fhir.search('Patient', {
        name: patientSearchQuery.trim(),
        _count: '10',
      });
      const results = (bundle.entry ?? [])
        .map((e) => e.resource as PatientLike | undefined)
        .filter(
          (r): r is PatientLike => !!r && r.resourceType === 'Patient'
        );
      setPatientResults(results);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[StudyImporter] Patient search failed:', err);
      setPatientResults([]);
    } finally {
      setPatientSearchLoading(false);
    }
  }, [fhir, patientSearchQuery]);

  const handlePatientSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        void handlePatientSearch();
      }
    },
    [handlePatientSearch]
  );

  const handleLinkPatient = useCallback(async () => {
    if (!selectedPatient) {
      setState('complete');
      return;
    }

    // For each study we just uploaded, try to locate the matching FHIR
    // ImagingStudy by identifier + patch its subject reference. With the
    // Phase-1 stub these calls are logged but unpersisted.
    for (const study of studySummaries) {
      try {
        const bundle = await fhir.search('ImagingStudy', {
          identifier: `urn:oid:${study.studyInstanceUID}`,
          _count: '1',
        });
        const hit = bundle.entry?.[0]?.resource as FhirResourceLike | undefined;
        if (hit?.id) {
          await fhir.updateResource({
            ...hit,
            subject: { reference: `Patient/${selectedPatient.id}` },
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[StudyImporter] Failed to link study to patient (bridge will reconcile):',
          err
        );
      }
    }

    setState('complete');
    onImportComplete?.();
  }, [selectedPatient, studySummaries, fhir, onImportComplete]);

  const handleSkipMatching = useCallback(() => {
    setState('complete');
  }, []);

  // ---- Reset / retry / done ----
  const handleImportAnother = useCallback(() => {
    setFiles([]);
    setStudySummaries([]);
    setPreviewGroups([]);
    setUploadProgress(0);
    setUploadCurrentFile('');
    setUploadResult(null);
    setUploadError(null);
    setPatientSearchQuery('');
    setPatientResults([]);
    setSelectedPatient(null);
    setState('idle');
  }, []);

  const handleDone = useCallback(() => {
    onImportComplete?.();
  }, [onImportComplete]);

  const handleRetry = useCallback(() => {
    setUploadError(null);
    setUploadResult(null);
    setState('ready');
  }, []);

  // ---- Patient display helpers ----
  const getPatientDisplay = (patient: PatientLike): string => {
    const name = patient.name?.[0];
    if (!name) {
      return patient.id || '—';
    }
    const parts: string[] = [];
    if (name.family) {
      parts.push(name.family);
    }
    if (name.given?.length) {
      parts.push(name.given.join(' '));
    }
    return parts.join(', ') || patient.id || '—';
  };

  const getPatientIdDisplay = (patient: PatientLike): string => {
    return patient.identifier?.[0]?.value || patient.id || '—';
  };

  // ---- Preview grouping bookkeeping ----
  const groupedFileIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of previewGroups) {
      for (const id of g.fileIds) {
        set.add(id);
      }
    }
    return set;
  }, [previewGroups]);

  const ungroupedValidFiles = validFiles.filter(
    (f) => !groupedFileIds.has(f.id)
  );

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <Stack gap="md">
      {preSelectedPatientName && (
        <PreSelectedBanner name={preSelectedPatientName} t={t} />
      )}

      {/* === IDLE: drag-and-drop zone === */}
      {state === 'idle' && (
        <div
          className={`${styles.dropzone} ${
            isDragActive ? styles.dropzoneDragActive : ''
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={handleBrowseClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleBrowseClick();
            }
          }}
          aria-label={t('pacs.import.dropzoneTitle')}
          data-testid="dicom-dropzone"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className={styles.hiddenInput}
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              overflow: 'hidden',
              clip: 'rect(0,0,0,0)',
              border: 0,
            }}
            onChange={handleFileInputChange}
            aria-label={t('pacs.import.selectFiles')}
          />
          <input
            ref={folderInputRef}
            type="file"
            className={styles.hiddenInput}
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              overflow: 'hidden',
              clip: 'rect(0,0,0,0)',
              border: 0,
            }}
            onChange={handleFolderInputChange}
            aria-label={t('pacs.import.selectFolder')}
            {...({
              webkitdirectory: '',
              directory: '',
            } as React.InputHTMLAttributes<HTMLInputElement>)}
          />

          <div className={styles.dropzoneIconCircle}>
            <IconCloudUpload size={34} stroke={1.5} />
          </div>

          <h3 className={styles.dropzoneTitle}>
            {t('pacs.import.dropzoneTitle')}
          </h3>
          <p className={styles.dropzoneDescription}>
            {t('pacs.import.dropzoneDescription')}
          </p>

          <Group
            gap="sm"
            wrap="wrap"
            justify="center"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <EMRButton
              variant="primary"
              size="sm"
              icon={IconUpload}
              onClick={handleBrowseClick}
            >
              {t('pacs.import.selectFiles')}
            </EMRButton>
            <EMRButton
              variant="light"
              size="sm"
              icon={IconFolder}
              onClick={handleBrowseFolderClick}
            >
              {t('pacs.import.selectFolder')}
            </EMRButton>
          </Group>

          <div className={styles.dropzoneDivider}>
            <div className={styles.dropzoneDividerLine} />
            <span className={styles.dropzoneDividerText}>
              {isDragActive
                ? t('pacs.import.dropHere') || 'Drop here'
                : t('pacs.import.orDragDrop') || 'or drag & drop'}
            </span>
            <div className={styles.dropzoneDividerLine} />
          </div>
        </div>
      )}

      {/* === VALIDATING: spinner === */}
      {state === 'validating' && (
        <div className={styles.spinnerState}>
          <Loader size="md" color="var(--emr-accent)" />
          <span className={styles.spinnerStateLabel}>
            {t('pacs.import.validating')}
          </span>
        </div>
      )}

      {/* === READY: summary + study groups + action row === */}
      {state === 'ready' && (
        <Stack gap="md">
          <SummaryStrip
            validCount={validFiles.length}
            invalidCount={invalidFiles.length}
            totalSize={totalSize}
            t={t}
          />

          {validFiles.length === 0 && (
            <Alert
              icon={<IconAlertTriangle size={18} />}
              color="orange"
              title={t('pacs.import.noValidFiles')}
              radius="md"
            >
              {t('pacs.import.noValidFilesDescription')}
            </Alert>
          )}

          {validFiles.length > 0 && (
            <div className={styles.studyGroupList}>
              {previewGroups.length > 0 &&
                previewGroups.map((group) => {
                  const groupFiles = validFiles.filter((f) =>
                    group.fileIds.includes(f.id)
                  );
                  if (groupFiles.length === 0) return null;
                  return (
                    <StudyGroupCard
                      key={group.studyKey}
                      summary={group.summary}
                      files={groupFiles}
                      onRemove={handleRemoveFile}
                      t={t}
                    />
                  );
                })}

              {previewGroups.length === 0 && (
                <StudyGroupCard
                  summary={null}
                  files={validFiles}
                  onRemove={handleRemoveFile}
                  t={t}
                />
              )}

              {ungroupedValidFiles.length > 0 && previewGroups.length > 0 && (
                <StudyGroupCard
                  summary={null}
                  files={ungroupedValidFiles}
                  onRemove={handleRemoveFile}
                  t={t}
                />
              )}
            </div>
          )}

          {invalidFiles.length > 0 && (
            <Box
              style={{
                border: '1px solid var(--emr-border-color)',
                borderRadius: 12,
                overflow: 'hidden',
                background: 'var(--emr-bg-card)',
              }}
            >
              <div className={styles.fileList}>
                {invalidFiles.map((entry) => (
                  <FileRow
                    key={entry.id}
                    entry={entry}
                    onRemove={handleRemoveFile}
                    t={t}
                  />
                ))}
              </div>
            </Box>
          )}

          <div className={styles.actionRow}>
            <div className={styles.actionRowSecondary}>
              <EMRButton
                variant="subtle"
                size="sm"
                icon={IconTrash}
                color="red"
                onClick={handleRemoveAll}
              >
                {t('pacs.import.removeAll')}
              </EMRButton>
              <EMRButton
                variant="subtle"
                size="sm"
                icon={IconUpload}
                onClick={handleBrowseClick}
              >
                {t('pacs.import.selectFiles')}
              </EMRButton>
              <EMRButton
                variant="subtle"
                size="sm"
                icon={IconFolder}
                onClick={handleBrowseFolderClick}
              >
                {t('pacs.import.selectFolder')}
              </EMRButton>
            </div>

            <EMRButton
              variant="primary"
              size="md"
              icon={IconPhotoUp}
              onClick={handleStartUpload}
              disabled={validFiles.length === 0}
              data-testid="dicom-start-upload"
            >
              {t('pacs.import.startUpload')}
            </EMRButton>
          </div>
        </Stack>
      )}

      {/* === PARSING: reading DICOM headers === */}
      {state === 'parsing' && (
        <div className={styles.spinnerState}>
          <Loader size="md" color="var(--emr-accent)" />
          <span className={styles.spinnerStateLabel}>
            {t('pacs.import.parsingFiles')}
          </span>
        </div>
      )}

      {/* === UPLOADING: gradient progress bar === */}
      {state === 'uploading' && (
        <div className={styles.uploadProgressSection}>
          <span className={styles.uploadProgressIconWrap}>
            <IconCloudUpload size={30} stroke={1.75} />
          </span>
          <div className={styles.uploadProgressTitle}>
            {t('pacs.import.uploading')}
          </div>
          <div className={styles.uploadProgressLabel}>
            {t('pacs.import.uploadProgress')
              .replace(
                '{current}',
                String(
                  Math.min(
                    Math.ceil((uploadProgress / 100) * validFiles.length),
                    validFiles.length
                  )
                )
              )
              .replace('{total}', String(validFiles.length))}
          </div>

          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${uploadProgress}%` }}
            >
              <div className={styles.progressFillShimmer} />
            </div>
          </div>

          {uploadCurrentFile && (
            <div className={styles.uploadProgressFile}>
              {uploadCurrentFile}
            </div>
          )}
        </div>
      )}

      {/* === MATCHING: patient matching === */}
      {state === 'matching' && (
        <div className={styles.matchingSection}>
          <div className={styles.matchingHeader}>
            <div className={styles.matchingHeaderTitle}>
              {t('pacs.import.matchPatient')}
            </div>
            <div className={styles.matchingHeaderSubtitle}>
              {t('pacs.import.matchPatientDescription')}
            </div>
          </div>

          <div className={styles.dicomInfoCard}>
            <div className={styles.dicomInfoRow}>
              <span className={styles.dicomInfoLabel}>
                {t('pacs.import.dicomPatientName')}
              </span>
              <span className={styles.dicomInfoValue}>
                {studySummaries[0]?.patientName || '—'}
              </span>
            </div>
            <div className={styles.dicomInfoRow}>
              <span className={styles.dicomInfoLabel}>
                {t('pacs.import.dicomPatientId')}
              </span>
              <span className={styles.dicomInfoValue}>
                {studySummaries[0]?.patientId || '—'}
              </span>
            </div>
          </div>

          <Group gap="sm" wrap="wrap" align="flex-end">
            <Box style={{ flex: 1, minWidth: 220 }}>
              <EMRTextInput
                placeholder={t('pacs.import.searchPatient')}
                value={patientSearchQuery}
                onChange={(value: string) => setPatientSearchQuery(value)}
                onKeyDown={handlePatientSearchKeyDown}
                leftSection={<IconSearch size={16} />}
                rightSection={
                  patientSearchLoading ? <Loader size="xs" /> : undefined
                }
                aria-label={t('pacs.import.searchPatient')}
                fullWidth
              />
            </Box>
            <EMRButton
              variant="light"
              size="sm"
              icon={IconSearch}
              onClick={handlePatientSearch}
            >
              {t('pacs.import.searchPatient').split('...')[0]}
            </EMRButton>
          </Group>

          {patientResults.length > 0 && (
            <div className={styles.patientSearchResults}>
              {patientResults.map((patient) => (
                <div
                  key={patient.id}
                  className={`${styles.patientResultItem} ${
                    selectedPatient?.id === patient.id
                      ? styles.patientResultItemSelected
                      : ''
                  }`}
                  onClick={() => setSelectedPatient(patient)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedPatient(patient);
                    }
                  }}
                  aria-label={getPatientDisplay(patient)}
                >
                  <div className={styles.patientIconWrap}>
                    <IconUser size={18} />
                  </div>
                  <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                    <Text
                      size="sm"
                      fw={600}
                      lineClamp={1}
                      c="var(--emr-text-primary)"
                    >
                      {getPatientDisplay(patient)}
                    </Text>
                    <Text size="xs" c="var(--emr-text-secondary)">
                      {getPatientIdDisplay(patient)}
                    </Text>
                  </Stack>
                </div>
              ))}
            </div>
          )}

          <Group justify="space-between" wrap="wrap" gap="sm" mt="sm">
            <EMRButton
              variant="subtle"
              size="sm"
              onClick={handleSkipMatching}
            >
              {t('pacs.import.skipMatching')}
            </EMRButton>
            <EMRButton
              variant="primary"
              size="md"
              icon={IconLink}
              onClick={handleLinkPatient}
              disabled={!selectedPatient}
            >
              {t('pacs.import.linkPatient')}
            </EMRButton>
          </Group>
        </div>
      )}

      {/* === COMPLETE: summary === */}
      {state === 'complete' && (
        <div className={styles.summarySection}>
          {uploadError ? (
            <div className={`${styles.summaryIcon} ${styles.summaryIconError}`}>
              <IconCircleX size={36} />
            </div>
          ) : (
            <div className={styles.summaryIcon}>
              <IconCircleCheck size={36} />
            </div>
          )}

          <h3 className={styles.summaryTitle}>
            {uploadError
              ? t('pacs.import.uploadFailed')
              : t('pacs.import.uploadComplete')}
          </h3>

          {uploadError && (
            <Alert
              icon={<IconAlertTriangle size={18} />}
              color="red"
              title={t('pacs.import.uploadFailed')}
              style={{ textAlign: 'left', width: '100%', maxWidth: 520 }}
              radius="md"
            >
              {uploadError}
            </Alert>
          )}

          {uploadResult && (
            <div className={styles.summaryStats}>
              {uploadResult.successCount > 0 && (
                <div className={styles.summaryStatSuccess}>
                  <IconCircleCheck size={14} />
                  {t('pacs.import.filesImported').replace(
                    '{count}',
                    String(uploadResult.successCount)
                  )}
                </div>
              )}
              {uploadResult.failedCount > 0 && (
                <div className={styles.summaryStatFailed}>
                  <IconCircleX size={14} />
                  {t('pacs.import.filesFailed').replace(
                    '{count}',
                    String(uploadResult.failedCount)
                  )}
                </div>
              )}
            </div>
          )}

          {uploadResult && uploadResult.failedCount > 0 && !uploadError && (
            <Alert
              icon={<IconAlertTriangle size={18} />}
              color="orange"
              style={{ textAlign: 'left', width: '100%', maxWidth: 520 }}
              radius="md"
            >
              {t('pacs.import.partialFailure')
                .replace('{failed}', String(uploadResult.failedCount))
                .replace(
                  '{total}',
                  String(
                    uploadResult.successCount + uploadResult.failedCount
                  )
                )}
              {uploadResult.failures && uploadResult.failures.length > 0 && (
                <ul
                  style={{
                    margin: '4px 0 0',
                    paddingLeft: '16px',
                    fontSize: 'var(--emr-font-xs)',
                  }}
                >
                  {uploadResult.failures.slice(0, 5).map((reason, idx) => (
                    <li key={idx}>{reason}</li>
                  ))}
                  {uploadResult.failures.length > 5 && (
                    <li>
                      {t('pacs.import.andMore').replace(
                        '{count}',
                        String(uploadResult.failures.length - 5)
                      )}
                    </li>
                  )}
                </ul>
              )}
            </Alert>
          )}

          <Group gap="sm" wrap="wrap" mt="sm" justify="center">
            {uploadError && (
              <EMRButton
                variant="light"
                size="sm"
                onClick={handleRetry}
              >
                {t('pacs.import.retryUpload')}
              </EMRButton>
            )}
            <EMRButton
              variant="light"
              size="sm"
              onClick={handleImportAnother}
            >
              {t('pacs.import.importAnother')}
            </EMRButton>
            <EMRButton
              variant="primary"
              size="md"
              icon={IconCircleCheck}
              onClick={handleDone}
            >
              {t('pacs.import.done')}
            </EMRButton>
          </Group>
        </div>
      )}
    </Stack>
  );
});

export default StudyImporter;
