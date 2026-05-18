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

import JSZip from 'jszip';
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

/**
 * Filenames that frequently ship alongside DICOM CDs but aren't medical
 * data — silently skip them so a "Choose folder" pick of a CD root
 * doesn't reject the whole upload over a `.DS_Store` or `autorun.inf`.
 */
const CRUFT_NAME_PATTERNS = [
  /^\.ds_store$/i,
  /^thumbs\.db$/i,
  /^autorun\.inf$/i,
  /^run\.bat$/i,
  /^job\.backup$/i,
  /^readme\.txt$/i,
  /\.exe$/i,
  /\.dll$/i,
];

/**
 * Top-level folder names commonly created by DICOM viewer CDs (e.g.
 * RadiAnt) that don't contain study slices. Filtered when we walk a
 * `webkitdirectory` pick — the actual `.dcm` series lives in the
 * sibling UID-named folder.
 */
const CRUFT_DIR_PATTERNS = [/^common$/i, /^ra32$/i, /^ra64$/i, /^bin$/i];

/** Decide whether a file from a folder pick is medically relevant. */
function isLikelyDicom(file: File): boolean {
  const lower = file.name.toLowerCase();
  if (CRUFT_NAME_PATTERNS.some((rx) => rx.test(file.name))) return false;

  // webkitRelativePath = "FolderRoot/UID/slice0001.dcm" — reject if any
  // path segment matches the cruft-dir list.
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
  if (rel) {
    const segments = rel.split('/').slice(0, -1);
    if (segments.some((seg) => CRUFT_DIR_PATTERNS.some((rx) => rx.test(seg)))) {
      return false;
    }
  }

  // Permissive: explicit DICOM extension OR extensionless filename
  // (many real-world DICOM CDs ship files named with the SOP UID and no
  // extension at all). Reject only files with a non-DICOM extension we
  // recognise as definitely not medical (.txt/.pdf/.html/.xml/.css/...).
  if (DICOM_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  const KNOWN_NON_DICOM = /\.(txt|pdf|html?|xml|css|js|jpg|jpeg|png|gif|svg|ini|log|md)$/i;
  if (KNOWN_NON_DICOM.test(lower)) return false;
  // Anything else (no extension, unknown extension) — assume DICOM and
  // let the server-side gate make the call.
  return true;
}

/**
 * Bundle a list of files into a single in-memory `.zip` Blob. Used when
 * the user picks a folder (or multi-selects files) so the upload is one
 * tus session that lands one Study, not N sessions.
 *
 * The `onProgress` callback fires throughout JSZip's `generateAsync` —
 * we use it to drive the bundling-phase progress bar so the user
 * doesn't stare at a frozen dropzone while 2,000 DICOM slices stream
 * into the in-memory zip.
 */
async function zipFiles(
  files: File[],
  onProgress?: (pct: number, currentFile?: string) => void,
): Promise<File> {
  const zip = new JSZip();
  for (const f of files) {
    // Preserve the relative folder structure if the user picked a
    // directory — that helps the server-side phase-detection logic
    // group slices into series.
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name;
    zip.file(rel, f);
  }
  const blob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'STORE', // DICOM already deflate-resistant; STORE = no CPU cost
    },
    (meta: { percent: number; currentFile?: string | null }) => {
      if (onProgress) {
        onProgress(Math.round(meta.percent), meta.currentFile ?? undefined);
      }
    },
  );
  return new File([blob], 'liverra-upload.zip', { type: 'application/zip' });
}

/** Upload stages surfaced to consumers. */
export type DicomUploadStage =
  | 'idle'
  | 'validating'
  | 'bundling'
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
  /**
   * Human-readable status label (e.g. "Bundling 2,342 files…",
   * "Uploading liverra-upload.zip"). Replaces `currentFileName` for
   * stages where there's no single "current file".
   */
  statusLabel?: string;
  /**
   * Explicit percent override for stages where we have a percent but no
   * byte-counts (e.g. JSZip bundling). When set, the progress bar reads
   * this instead of computing from bytesSent/bytesTotal.
   */
  percent?: number;
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
    // Explicit percent (bundling stage) wins; otherwise compute from
    // byte counts (uploading stage). Returns 0 when nothing's started.
    if (typeof state.percent === 'number') {
      return Math.min(100, Math.max(0, state.percent));
    }
    if (state.bytesTotal === 0) return 0;
    return Math.min(100, Math.round((state.bytesSent / state.bytesTotal) * 100));
  }, [state.percent, state.bytesSent, state.bytesTotal]);

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
      // The backend returns 201 with NO body — id lives in the Location
      // header (tus protocol convention) and the studyId is only known
      // after the final PATCH completes. We parse the upload id out of
      // the Location and let PATCH supply the studyId on completion.
      const locationHeader = createRes.headers.get('Location') ?? '';
      const id = locationHeader.split('/').pop() ?? '';
      if (!id) {
        throw new Error('POST /uploads returned no upload id');
      }

      // 2) PATCH chunks of CHUNK_SIZE_BYTES. The final chunk's response
      //    may carry a `Study-Id` header once ingestion gates have run.
      let offset = 0;
      let finalStudyId = '';
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
        // Last chunk: backend writes `Study-Id` header once it's promoted
        // upload_session → study. Falls back to upload id below.
        const sid = patchRes.headers.get('Study-Id');
        if (sid) finalStudyId = sid;
      }

      // 3) Server may PHI-warn via response headers.
      const phiHeader = createRes.headers.get('X-PHI-Warning');
      if (phiHeader) {
        setState((prev) => ({ ...prev, stage: 'phi_warning', phiWarning: phiHeader }));
      }

      return finalStudyId || id;
    },
    [ingestBaseUrl, authToken],
  );

  /** Orchestrate validation → bundle-if-needed → upload → completion. */
  const startUpload = useCallback(
    async (rawFiles: File[]): Promise<void> => {
      const abortCtl = new AbortController();
      abortRef.current = abortCtl;

      // Stage 1 — Filtering. Surface this even though it's near-instant
      // so the user sees "something is happening" the moment they click
      // Choose folder. Without this, the first ~50ms feels frozen.
      setState({
        stage: 'validating',
        bytesSent: 0,
        bytesTotal: 0,
        fileCount: rawFiles.length,
        fileIndex: 0,
        statusLabel: `Scanning ${rawFiles.length.toLocaleString()} files…`,
      });

      // Drop CD-burner cruft (.DS_Store, autorun.inf, viewer subdirs).
      // Without this filter a "Choose folder" pick of a typical Toshiba/
      // Siemens DICOM CD aborts the whole upload over the first .bat.
      const files = rawFiles.filter(isLikelyDicom);

      if (files.length === 0) {
        setState({
          ...initialState,
          stage: 'error',
          errorMessage: t('upload:errors.noFilesFound'),
        });
        return;
      }

      // Multi-file picks (folder or shift-select) → bundle into one .zip
      // and upload as ONE tus session. This produces ONE Study on the
      // backend instead of N orphan sessions that each fail
      // phase-coverage on their own.
      let uploadFile: File;
      if (files.length === 1) {
        uploadFile = files[0];
        const err = validateFile(uploadFile);
        if (err) {
          setState({
            ...initialState,
            stage: 'error',
            errorMessage: t(err, { max: '2 GB' }),
          });
          return;
        }
      } else {
        // Stage 2 — Bundling. This is the slow part for big folders
        // (1–3 minutes for 2,000 slices). JSZip's onUpdate fires with
        // monotonically-rising percent + currentFile, which we pipe
        // straight to the progress bar.
        setState({
          stage: 'bundling',
          bytesSent: 0,
          bytesTotal: 0,
          percent: 0,
          fileCount: files.length,
          fileIndex: 0,
          statusLabel: `Bundling ${files.length.toLocaleString()} DICOM files…`,
        });
        try {
          uploadFile = await zipFiles(files, (pct, currentFile) => {
            setState((prev) => ({
              ...prev,
              percent: pct,
              currentFileName: currentFile,
            }));
          });
        } catch (zipErr) {
          setState({
            ...initialState,
            stage: 'error',
            errorMessage: (zipErr as Error).message,
          });
          return;
        }
        // Hard cap mirrors validateFile's archive ceiling.
        if (uploadFile.size > MAX_ARCHIVE_BYTES) {
          setState({
            ...initialState,
            stage: 'error',
            errorMessage: t('upload:errors.archiveTooLarge', { max: '2 GB' }),
          });
          return;
        }
      }

      // Stage 3 — Uploading. Byte-counters drive the bar from here.
      const sizeMb = (uploadFile.size / (1024 * 1024)).toFixed(1);
      setState({
        stage: 'uploading',
        bytesSent: 0,
        bytesTotal: uploadFile.size,
        percent: undefined, // fall back to bytes-based percent
        fileCount: 1,
        fileIndex: 0,
        currentFileName: uploadFile.name,
        statusLabel: `Uploading ${sizeMb} MB to server…`,
      });

      try {
        const studyId = await uploadOneFile(uploadFile, abortCtl.signal);
        setState((prev) => ({ ...prev, stage: 'complete' }));
        onComplete(studyId);
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

  const isBusy =
    state.stage === 'uploading' ||
    state.stage === 'validating' ||
    state.stage === 'bundling';

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

        {/*
         * Inline progress — visible as soon as work starts, including
         * the bundling phase where bytesTotal is still 0. The progress
         * bar reads `progressPct` which prefers the explicit `percent`
         * (set by JSZip during bundling) over the bytes-based ratio.
         */}
        {isBusy && (
          <Stack
            gap={6}
            w="100%"
            maw={480}
            aria-live="polite"
            data-testid="dropzone-progress"
          >
            <Group justify="space-between" wrap="wrap" gap={4}>
              <Text
                fz="var(--emr-font-sm)"
                fw={600}
                c="var(--emr-text-primary)"
                style={{ minWidth: 0, flex: 1 }}
              >
                {state.statusLabel ?? t('upload:dropzone.preparing')}
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
              <Text
                fz="var(--emr-font-xs)"
                c="var(--emr-text-tertiary)"
                style={{ minWidth: 0, flex: 1 }}
              >
                {state.currentFileName ?? ''}
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
