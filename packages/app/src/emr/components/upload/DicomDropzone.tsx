// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * DicomDropzone — T171
 *
 * Drag-and-drop DICOM intake for LiverRa. Accepts:
 *   - Single `.dcm` files
 *   - Multi-file `.dcm` selections
 *   - `.zip` archives (bundled study)
 *   - Directory drops (recursive `.dcm` extraction from `webkitGetAsEntry`)
 *
 * Upload pipeline (tus-style):
 *   1) `POST /api/v1/ingest/uploads` — creates upload session → returns `{ id }`
 *   2) `PATCH /api/v1/ingest/uploads/{id}` — streams 8 MB chunks until final
 *   3) Server emits PHI-detect callbacks via SSE at `/api/v1/ingest/uploads/{id}/stream`
 *
 * Spec refs: FR-001 (DICOM ingestion), FR-005 (PHI detection),
 * NFR-002 (ARIA a11y for screen readers).
 */

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCloudUpload,
  IconFolderOpen,
  IconUpload,
} from '@tabler/icons-react';
import { EMRAlert, EMRButton } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';

/** Chunk size for tus-style PATCH uploads. 8 MB per research §A.4. */
const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

/** Hard cap on archive size — 2 GB per spec §FR-001. */
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

/** Valid DICOM extensions (lower-cased comparison). */
const DICOM_EXTENSIONS = ['.dcm', '.dicom', '.dic'] as const;

/** Valid archive extensions. */
const ARCHIVE_EXTENSIONS = ['.zip'] as const;

/** Upload stages surfaced to consumers. */
export type DicomUploadStage =
  | 'idle'
  | 'validating'
  | 'uploading'
  | 'phi_warning'
  | 'complete'
  | 'error';

/**
 * Props for {@link DicomDropzone}.
 */
export interface DicomDropzoneProps {
  /**
   * Called after the server returns the final `studyId`. Caller is responsible
   * for navigating the user to the analysis detail view.
   */
  onComplete: (studyId: string) => void;
  /** Base URL for ingest API. Defaults to `/api/v1/ingest`. */
  ingestBaseUrl?: string;
  /** Disable the whole dropzone (e.g. when no seat allocation). */
  disabled?: boolean;
  /** Authorisation bearer token for chunked PATCHes. */
  authToken?: string;
  /** Optional `data-testid` for Playwright selectors. */
  'data-testid'?: string;
}

/** Internal progress state used to drive the inline progress bar. */
interface UploadState {
  stage: DicomUploadStage;
  bytesSent: number;
  bytesTotal: number;
  currentFileName?: string;
  fileIndex: number;
  fileCount: number;
  phiWarning?: string;
  errorMessage?: string;
}

const initialState: UploadState = {
  stage: 'idle',
  bytesSent: 0,
  bytesTotal: 0,
  fileIndex: 0,
  fileCount: 0,
};

/**
 * Recursively flatten a `DataTransferItemList` entry tree into a plain
 * `File[]`. Used when the user drags a whole directory of DICOM slices.
 */
async function readEntriesRecursive(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file((file) => resolve([file]), reject);
    });
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const entries: FileSystemEntry[] = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    const nested = await Promise.all(entries.map(readEntriesRecursive));
    return nested.flat();
  }
  return [];
}

/**
 * Validate that a file is either a DICOM instance or a ZIP archive
 * under the size cap. Returns `null` when valid, or an i18n key on error.
 */
function validateFile(file: File): string | null {
  const lower = file.name.toLowerCase();
  const isDicom = DICOM_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const isArchive = ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  if (!isDicom && !isArchive) {
    return 'upload:errors.invalidType';
  }
  if (isArchive && file.size > MAX_ARCHIVE_BYTES) {
    return 'upload:errors.archiveTooLarge';
  }
  return null;
}

/**
 * DicomDropzone — production-grade DICOM intake widget.
 */
export function DicomDropzone({
  onComplete,
  ingestBaseUrl = '/api/v1/ingest',
  disabled = false,
  authToken,
  'data-testid': testId = 'dicom-dropzone',
}: DicomDropzoneProps): React.ReactElement {
  const { t } = useTranslation();
  const helpId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [state, setState] = useState<UploadState>(initialState);

  const progressPct = useMemo(() => {
    if (state.bytesTotal === 0) return 0;
    return Math.min(100, Math.round((state.bytesSent / state.bytesTotal) * 100));
  }, [state.bytesSent, state.bytesTotal]);

  /**
   * Stream an individual file as tus-style PATCH chunks.
   * Rejects on any non-2xx; resolves with the server-assigned study UID.
   */
  const uploadOneFile = useCallback(
    async (file: File, signal: AbortSignal): Promise<string> => {
      // 1) Create upload session.
      const createRes = await fetch(`${ingestBaseUrl}/uploads`, {
        method: 'POST',
        headers: {
          'Upload-Length': String(file.size),
          'Upload-Metadata': `filename ${btoa(file.name)}`,
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        signal,
      });
      if (!createRes.ok) {
        throw new Error(`POST /uploads failed: ${createRes.status}`);
      }
      const { id, studyId } = (await createRes.json()) as {
        id: string;
        studyId?: string;
      };

      // 2) PATCH chunks of CHUNK_SIZE_BYTES.
      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE_BYTES, file.size);
        const slice = file.slice(offset, end);
        const patchRes = await fetch(`${ingestBaseUrl}/uploads/${id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/offset+octet-stream',
            'Upload-Offset': String(offset),
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: slice,
          signal,
        });
        if (!patchRes.ok) {
          throw new Error(`PATCH chunk failed: ${patchRes.status}`);
        }
        offset = end;
        setState((prev) => ({ ...prev, bytesSent: prev.bytesSent + slice.size }));
      }

      // 3) Server may PHI-warn via response headers; consumer will also
      //    subscribe via SSE in UploadProgress.
      const phiHeader = createRes.headers.get('X-PHI-Warning');
      if (phiHeader) {
        setState((prev) => ({ ...prev, stage: 'phi_warning', phiWarning: phiHeader }));
      }

      return studyId ?? id;
    },
    [ingestBaseUrl, authToken],
  );

  /** Orchestrate validation → sequential upload → completion callback. */
  const startUpload = useCallback(
    async (files: File[]): Promise<void> => {
      const abortCtl = new AbortController();
      abortRef.current = abortCtl;

      const total = files.reduce((acc, f) => acc + f.size, 0);
      setState({
        stage: 'validating',
        bytesSent: 0,
        bytesTotal: total,
        fileCount: files.length,
        fileIndex: 0,
      });

      // Validate all files first — fail fast before any network I/O.
      for (const file of files) {
        const err = validateFile(file);
        if (err) {
          setState({
            ...initialState,
            stage: 'error',
            errorMessage: t(err, { max: '2 GB' }),
          });
          return;
        }
      }

      setState((prev) => ({ ...prev, stage: 'uploading' }));

      try {
        let finalStudyId = '';
        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];
          setState((prev) => ({
            ...prev,
            fileIndex: i,
            currentFileName: file.name,
          }));
          finalStudyId = await uploadOneFile(file, abortCtl.signal);
        }
        setState((prev) => ({ ...prev, stage: 'complete' }));
        onComplete(finalStudyId);
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          return;
        }
        setState((prev) => ({
          ...prev,
          stage: 'error',
          errorMessage: (err as Error).message,
        }));
      }
    },
    [onComplete, t, uploadOneFile],
  );

  /**
   * Extract a flat file list from a `DataTransfer`, recursively walking
   * any directory entries the user may have dropped.
   */
  const filesFromDataTransfer = useCallback(
    async (dt: DataTransfer): Promise<File[]> => {
      const files: File[] = [];
      if (dt.items && dt.items.length > 0) {
        const entries: Promise<File[]>[] = [];
        for (let i = 0; i < dt.items.length; i += 1) {
          const item = dt.items[i];
          const entry =
            typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
          if (entry) {
            entries.push(readEntriesRecursive(entry));
          } else {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        const nested = await Promise.all(entries);
        nested.flat().forEach((f) => files.push(f));
      } else if (dt.files) {
        Array.from(dt.files).forEach((f) => files.push(f));
      }
      return files;
    },
    [],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>): Promise<void> => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      if (disabled) return;
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (files.length === 0) {
        setState({
          ...initialState,
          stage: 'error',
          errorMessage: t('upload:errors.noFilesFound'),
        });
        return;
      }
      void startUpload(files);
    },
    [disabled, filesFromDataTransfer, startUpload, t],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      if (!e.target.files || e.target.files.length === 0) return;
      void startUpload(Array.from(e.target.files));
    },
    [startUpload],
  );

  const handleCancel = useCallback((): void => {
    abortRef.current?.abort();
    setState(initialState);
  }, []);

  const isBusy = state.stage === 'uploading' || state.stage === 'validating';

  return (
    <Box
      data-testid={testId}
      role="region"
      aria-label={t('upload:dropzone.ariaLabel')}
      aria-describedby={helpId}
      aria-busy={isBusy}
      onDragEnter={(e) => {
        e.preventDefault();
        if (!disabled && !isBusy) setDragActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragActive(false);
      }}
      onDrop={handleDrop}
      style={{
        position: 'relative',
        border: '2px dashed',
        borderColor: dragActive
          ? 'var(--emr-accent)'
          : disabled
            ? 'var(--emr-gray-300)'
            : 'var(--emr-gray-400)',
        borderRadius: 'var(--emr-border-radius-xl)',
        background: dragActive
          ? 'var(--emr-accent-alpha-08)'
          : 'var(--emr-bg-card)',
        padding: 'clamp(24px, 5vw, 48px)',
        transition: 'border-color 0.2s ease, background 0.2s ease',
        cursor: disabled || isBusy ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        minHeight: 240,
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".dcm,.dicom,.dic,.zip,application/dicom,application/zip"
        onChange={handleFileInput}
        disabled={disabled || isBusy}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
      />
      <input
        ref={dirInputRef}
        type="file"
        // @ts-expect-error — non-standard directory attribute
        webkitdirectory=""
        directory=""
        multiple
        onChange={handleFileInput}
        disabled={disabled || isBusy}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
      />

      <Stack gap="md" align="center" ta="center">
        <Box
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: 'var(--emr-secondary-alpha-10)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--emr-secondary)',
          }}
          aria-hidden="true"
        >
          <IconCloudUpload size={40} stroke={1.5} />
        </Box>

        <Text
          fz={{ base: 'var(--emr-font-lg)', sm: 'var(--emr-font-xl)' } as unknown as string}
          fw={600}
          c="var(--emr-text-primary)"
        >
          {t('upload:dropzone.title')}
        </Text>

        <Text
          id={helpId}
          fz="var(--emr-font-md)"
          c="var(--emr-text-secondary)"
          maw={480}
        >
          {t('upload:dropzone.description')}
        </Text>

        <Group wrap="wrap" justify="center" gap="sm">
          <EMRButton
            variant="primary"
            icon={IconUpload}
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || isBusy}
          >
            {t('upload:dropzone.chooseFiles')}
          </EMRButton>
          <EMRButton
            variant="secondary"
            icon={IconFolderOpen}
            onClick={() => dirInputRef.current?.click()}
            disabled={disabled || isBusy}
          >
            {t('upload:dropzone.chooseFolder')}
          </EMRButton>
        </Group>

        <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)">
          {t('upload:dropzone.acceptedHint')}
        </Text>

        {/* Inline progress (visible once upload starts) */}
        {isBusy && state.bytesTotal > 0 && (
          <Stack gap={6} w="100%" maw={480} aria-live="polite">
            <Group justify="space-between" wrap="wrap" gap={4}>
              <Text
                fz="var(--emr-font-sm)"
                c="var(--emr-text-secondary)"
                style={{ minWidth: 0, flex: 1 }}
              >
                {state.currentFileName ?? t('upload:dropzone.preparing')}
              </Text>
              <Text
                fz="var(--emr-font-sm)"
                fw={600}
                c="var(--emr-text-primary)"
                style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
              >
                {progressPct}%
              </Text>
            </Group>
            <Box
              role="progressbar"
              aria-valuenow={progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t('upload:dropzone.progressAria')}
              style={{
                height: 6,
                borderRadius: 999,
                background: 'var(--emr-gray-200)',
                overflow: 'hidden',
              }}
            >
              <Box
                style={{
                  width: `${progressPct}%`,
                  height: '100%',
                  background: 'var(--emr-gradient-primary, linear-gradient(135deg, var(--emr-primary) 0%, var(--emr-secondary) 50%, var(--emr-accent) 100%))',
                  transition: 'width 0.25s ease',
                }}
              />
            </Box>
            <Group justify="space-between" wrap="wrap" gap={4}>
              <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)">
                {t('upload:dropzone.fileOfFile', {
                  current: state.fileIndex + 1,
                  total: state.fileCount,
                })}
              </Text>
              <EMRButton variant="ghost" size="sm" onClick={handleCancel}>
                {t('upload:dropzone.cancel')}
              </EMRButton>
            </Group>
          </Stack>
        )}

        {/* PHI-detect warning surfaced from server */}
        {state.stage === 'phi_warning' && state.phiWarning && (
          <Box w="100%" maw={480}>
            <EMRAlert
              variant="warning"
              title={t('upload:phi.title')}
              icon={IconAlertTriangle}
            >
              {state.phiWarning}
            </EMRAlert>
          </Box>
        )}

        {/* Error surfaced from validator or network */}
        {state.stage === 'error' && state.errorMessage && (
          <Box w="100%" maw={480}>
            <EMRAlert
              variant="error"
              title={t('upload:errors.title')}
              withCloseButton
              onClose={() => setState(initialState)}
            >
              {state.errorMessage}
            </EMRAlert>
          </Box>
        )}
      </Stack>
    </Box>
  );
}

export default DicomDropzone;
