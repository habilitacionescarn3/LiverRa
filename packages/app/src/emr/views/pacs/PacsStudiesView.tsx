// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * PacsStudiesView.
 *
 * Plain-English: "here are the DICOM studies sitting on our local PACS,
 * drag one in to add more". This view is the front door to the real
 * Orthanc — QIDO-RS for the list, STOW-RS for the dropzone. No AI
 * pipeline, no mocked backend, no FHIR — just pixels and headers.
 *
 * Why a new view rather than reusing CasesListView? CasesListView is
 * keyed on AI-analysis IDs (`case-2026-0412`) served by the mocked
 * `/api/v1/analyses` endpoint. Real Orthanc studies are keyed on
 * StudyInstanceUIDs (OID-shaped) and live under the `/pacs/*` route tree
 * per plan §Parallel route layout. Keeping them separate avoids
 * branching on "is this id a mock analysis or a real study?" in every
 * fetch.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  Badge,
  Box,
  Group,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { Dropzone, type FileRejection } from '@mantine/dropzone';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconCloudUpload,
  IconDatabase,
  IconFolderOpen,
  IconRefresh,
  IconRobot,
  IconX,
} from '@tabler/icons-react';

import {
  EMRAlert,
  EMRButton,
  EMREmptyState,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableSkeleton,
} from '../../components/common';
import { useDicomWebClient } from '../../hooks/useDicomWebClient';
import { useStowUpload, NoDicomFilesError } from '../../hooks/useStowUpload';
import { useTriggerAnalysis } from '../../hooks/useTriggerAnalysis';
import { useTranslation } from '../../contexts/TranslationContext';
import type {
  DicomJsonObject,
  DicomWebClientHandle,
} from '../../services/pacs/dicomwebClient';

// ---------------------------------------------------------------------------
// DICOM tag helpers
// ---------------------------------------------------------------------------

// Minimal tag reader — Orthanc returns DICOM+JSON where each tag is an
// 8-char hex key. We only care about a few display-oriented tags for the
// list. Callers cast the result from DicomJsonObject so the types stay
// narrow.
function tagString(study: DicomJsonObject, tag: string): string {
  const v = study?.[tag]?.Value?.[0];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function tagArray(study: DicomJsonObject, tag: string): string[] {
  const v = study?.[tag]?.Value;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

const TAG = {
  StudyInstanceUID: '0020000D',
  PatientID: '00100020',
  PatientName: '00100010',
  StudyDate: '00080020',
  StudyDescription: '00081030',
  ModalitiesInStudy: '00080061',
  NumberOfStudyRelatedInstances: '00201208',
} as const;

// Orthanc's DICOM+JSON returns PatientName as an object with Alphabetic
// representation; handle both string and object shapes.
function readPatientName(study: DicomJsonObject): string {
  const v = study?.[TAG.PatientName]?.Value?.[0];
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) {
    const alpha = (v as Record<string, unknown>).Alphabetic;
    return typeof alpha === 'string' ? alpha : '';
  }
  return '';
}

function formatStudyDate(raw: string): string {
  if (!raw || raw.length !== 8) return raw || '—';
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

// ---------------------------------------------------------------------------
// Directory-aware file collection
// ---------------------------------------------------------------------------

// Recursively flatten a FileSystem entry tree into a plain File[]. Used when
// the user drags a whole series folder onto the dropzone.
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

// Custom getFilesFromEvent for Mantine/react-dropzone: walks dropped
// directories, and for input/change events just returns the flat FileList.
// Signature widened to match react-dropzone's `DropEvent` union.
async function collectFiles(event: unknown): Promise<File[]> {
  const e = event as {
    dataTransfer?: DataTransfer;
    target?: { files?: FileList | null };
  };
  const dt = e.dataTransfer;
  if (dt && dt.items && dt.items.length > 0) {
    const out: File[] = [];
    const nested: Promise<File[]>[] = [];
    for (let i = 0; i < dt.items.length; i += 1) {
      const item = dt.items[i];
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (entry) {
        nested.push(readEntriesRecursive(entry));
      } else {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
    const walked = await Promise.all(nested);
    walked.flat().forEach((f) => out.push(f));
    return out;
  }
  if (dt && dt.files) return Array.from(dt.files);
  const files = e.target?.files;
  if (files) return Array.from(files);
  return [];
}

// ---------------------------------------------------------------------------
// QIDO query
// ---------------------------------------------------------------------------

function useStudies(client: DicomWebClientHandle) {
  return useQuery({
    queryKey: ['pacs', 'studies'],
    queryFn: ({ signal }) => client.qidoStudies({ limit: 100 }, signal),
    // Orthanc is local — a fast refetch on focus is cheap and keeps the
    // list current as other tabs upload.
    refetchOnWindowFocus: true,
    // Don't hammer Orthanc on transient errors during `up -d`.
    retry: 1,
  });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function PacsStudiesViewBody(): ReactElement {
  const navigate = useNavigate();
  const client = useDicomWebClient();
  const { t } = useTranslation();
  const { data, isPending, isError, error, refetch, isFetching } = useStudies(client);

  const [uploadError, setUploadError] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // Set the document title so this view is recognisable in browser history /
  // tab strip without depending on a shared hook.
  useEffect(() => {
    document.title = 'PACS studies · LiverRa';
  }, []);

  const upload = useStowUpload({
    onUploaded: (result) => {
      setUploadError(null);
      if (result.stow.failedCount > 0) {
        // C-PACS-1 — never render raw STOW failure strings to the user.
        // The strings often contain DICOM tag fragments + filenames
        // (e.g., "Patient_Smith_CT.dcm"), which can include patient
        // identifiers. Instead we show a count + the distinct DICOM
        // failure-reason categories that the mapStowFailureReason
        // catalog has already turned into safe codes upstream.
        const categories = Array.from(
          new Set(
            result.stow.failures
              .map((f) => f.split(' — ')[0].trim())
              .filter((c) => c.length > 0),
          ),
        );
        const summary =
          categories.length > 0 ? ` (${categories.slice(0, 3).join('; ')})` : '';
        setUploadError(
          `${result.stow.failedCount} file(s) rejected by Orthanc${summary}`,
        );
        // Partial success still navigates to the study so the user sees what landed.
      }
      navigate(`/pacs/studies/${encodeURIComponent(result.studyInstanceUid)}`);
    },
  });

  const rows = useMemo(() => {
    const studies = data ?? [];
    return studies
      .map((s, idx) => {
        const uid = tagString(s, TAG.StudyInstanceUID);
        if (!uid) return null;
        return {
          key: `${uid}-${idx}`,
          uid,
          patientId: tagString(s, TAG.PatientID) || '—',
          patientName: readPatientName(s) || '—',
          studyDate: formatStudyDate(tagString(s, TAG.StudyDate)),
          description: tagString(s, TAG.StudyDescription) || '—',
          modalities: tagArray(s, TAG.ModalitiesInStudy),
          instanceCount: tagString(s, TAG.NumberOfStudyRelatedInstances) || '?',
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [data]);

  async function handleDrop(files: File[]): Promise<void> {
    setUploadError(null);
    if (files.length === 0) return;
    try {
      await upload.mutateAsync(files);
    } catch (err) {
      if (err instanceof NoDicomFilesError) {
        setUploadError('None of the dropped files are valid DICOM. Try a .dcm or a folder of .dcm files.');
      } else {
        setUploadError(err instanceof Error ? err.message : 'Upload failed.');
      }
    }
  }

  function handleReject(rejections: FileRejection[]): void {
    if (rejections.length === 0) return;
    const first = rejections[0]?.errors?.[0];
    const msg =
      first?.code === 'file-too-large'
        ? 'File is larger than the 2 GB upload limit.'
        : first?.message ?? 'File rejected.';
    setUploadError(`${rejections.length} file(s) rejected: ${msg}`);
  }

  function handleFolderInput(event: React.ChangeEvent<HTMLInputElement>): void {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    void handleDrop(Array.from(files));
    event.target.value = '';
  }

  return (
    <Stack gap="lg" p={{ base: 'md', md: 'lg' }} data-testid="pacs-studies-view">
      <EMRPageHeader
        icon={IconDatabase}
        title="PACS studies"
        subtitle="DICOM studies stored locally on Orthanc. Upload a study to view it in the LiverRa viewer."
        badge={
          rows.length > 0 ? { count: rows.length, variant: 'primary' } : undefined
        }
        actions={
          <Group gap="xs" wrap="wrap">
            <EMRButton
              variant="secondary"
              icon={IconFolderOpen}
              onClick={() => folderInputRef.current?.click()}
              disabled={upload.isPending}
              data-testid="pacs-select-folder"
            >
              {t('pacs:studies.selectFolder')}
            </EMRButton>
            <EMRButton
              variant="ghost"
              icon={IconRefresh}
              onClick={() => refetch()}
              loading={isFetching}
            >
              {t('pacs:studies.refresh')}
            </EMRButton>
          </Group>
        }
      />

      {/*
        Hidden input for whole-directory selection. Mantine's Dropzone does
        not support webkitdirectory; we layer a native folder picker on top.
      */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error — non-standard directory attribute (Chrome/Safari/Edge)
        webkitdirectory=""
        directory=""
        onChange={handleFolderInput}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
      />

      <Box
        style={{
          borderRadius: 'var(--emr-border-radius-lg, 12px)',
          overflow: 'hidden',
          border: '1px solid var(--emr-border-color, var(--emr-gray-200))',
          background: 'var(--emr-bg-card)',
        }}
      >
        <Dropzone
          onDrop={handleDrop}
          onReject={handleReject}
          loading={upload.isPending}
          multiple
          data-testid="pacs-dropzone"
          // No `accept` prop on purpose: DICOM files almost never carry a
          // standard MIME type (file.type is usually ''), so any MIME-based
          // filter silently drops them before onDrop fires. Real validation
          // happens in parseDicomFiles (DICM magic-byte check).
          // `useFsAccessApi: false` forces the classic <input type="file">
          // picker, avoiding Chrome's showOpenFilePicker MIME strictness.
          useFsAccessApi={false}
          getFilesFromEvent={collectFiles}
          maxSize={2 * 1024 * 1024 * 1024 /* 2 GB */}
          styles={{
            root: {
              border: 'none',
              background: 'transparent',
            },
          }}
        >
          <Group
            justify="center"
            gap="md"
            mih={140}
            style={{ pointerEvents: 'none', padding: 16 }}
            wrap="wrap"
          >
            <Dropzone.Accept>
              <IconCloudUpload size={48} color="var(--emr-success)" />
            </Dropzone.Accept>
            <Dropzone.Reject>
              <IconX size={48} color="var(--emr-error)" />
            </Dropzone.Reject>
            <Dropzone.Idle>
              <IconCloudUpload size={48} color="var(--emr-secondary)" />
            </Dropzone.Idle>
            <Box style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
              <Text fz="var(--emr-font-lg)" fw={600} c="var(--emr-text-primary)">
                {t('pacs:studies.dropzoneTitle')}
              </Text>
              <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
                {t('pacs:studies.dropzoneSubtitle')}
              </Text>
            </Box>
          </Group>
        </Dropzone>
      </Box>

      {uploadError && (
        <EMRAlert
          variant="error"
          icon={IconAlertTriangle}
          title={t('pacs:studies.uploadIssue')}
          withCloseButton
          onClose={() => setUploadError(null)}
        >
          {uploadError}
        </EMRAlert>
      )}

      {isError && (
        <EMRAlert
          variant="error"
          icon={IconAlertTriangle}
          title={t('pacs:studies.cannotReachOrthanc')}
        >
          <Stack gap="xs">
            <Text size="sm">
              {(error as Error)?.message ?? t('pacs:studies.dicomwebFailed')}
            </Text>
            <Text size="xs" c="var(--emr-text-secondary)">
              {t('pacs:studies.checkOrthancRunning')}{' '}
              <code style={{ fontFamily: 'var(--emr-font-mono, monospace)' }}>
                docker compose -f deploy/local/docker-compose.yml ps
              </code>
            </Text>
            <Box>
              <EMRButton
                size="sm"
                variant="secondary"
                icon={IconRefresh}
                onClick={() => refetch()}
              >
                {t('pacs:studies.retry')}
              </EMRButton>
            </Box>
          </Stack>
        </EMRAlert>
      )}

      {isPending && <EMRTableSkeleton rows={6} columns={6} />}

      {!isPending && !isError && rows.length === 0 && (
        <EMREmptyState
          icon={IconDatabase}
          title={t('pacs:studies.emptyTitle')}
          description={t('pacs:studies.emptyDescription')}
          action={{
            label: t('pacs:studies.selectFolder'),
            onClick: () => folderInputRef.current?.click(),
            icon: IconFolderOpen,
          }}
          data-testid="pacs-studies-empty"
        />
      )}

      {rows.length > 0 && (
        <Box
          style={{
            borderRadius: 'var(--emr-border-radius-lg, 12px)',
            border: '1px solid var(--emr-border-color, var(--emr-gray-200))',
            overflow: 'hidden',
            background: 'var(--emr-bg-card)',
          }}
        >
          <Table
            highlightOnHover
            verticalSpacing="sm"
            horizontalSpacing="md"
            data-testid="pacs-studies-table"
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('pacs:studies.column.patientId')}</Table.Th>
                <Table.Th>{t('pacs:studies.column.patientName')}</Table.Th>
                <Table.Th>{t('pacs:studies.column.studyDate')}</Table.Th>
                <Table.Th>{t('pacs:studies.column.description')}</Table.Th>
                <Table.Th>{t('pacs:studies.column.modality')}</Table.Th>
                <Table.Th ta="right">{t('pacs:studies.column.instances')}</Table.Th>
                <Table.Th ta="right">{t('pacs:studies.column.actions')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => {
                const open = (): void =>
                  navigate(`/pacs/studies/${encodeURIComponent(r.uid)}`);
                return (
                  <Table.Tr
                    key={r.key}
                    data-testid={`pacs-study-row-${r.uid}`}
                    style={{ cursor: 'pointer' }}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        open();
                      }
                    }}
                    tabIndex={0}
                  >
                    <Table.Td>
                      <Text fz="var(--emr-font-sm)" fw={500}>
                        {r.patientId}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text fz="var(--emr-font-sm)">{r.patientName}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
                        {r.studyDate}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text
                        fz="var(--emr-font-sm)"
                        style={{
                          maxWidth: 240,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r.description}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="wrap">
                        {r.modalities.length === 0 ? (
                          <Text c="dimmed" size="sm">—</Text>
                        ) : (
                          r.modalities.map((m) => (
                            <Badge key={m} size="sm" variant="light">{m}</Badge>
                          ))
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text fz="var(--emr-font-sm)" fw={500}>
                        {r.instanceCount}
                      </Text>
                    </Table.Td>
                    <Table.Td
                      ta="right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <RunAIButton
                        studyInstanceUid={r.uid}
                        patientRef={r.patientId || undefined}
                      />
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Box>
      )}
    </Stack>
  );
}

export default function PacsStudiesView(): ReactElement {
  return (
    <EMRErrorBoundary componentName="PacsStudiesView">
      <PacsStudiesViewBody />
    </EMRErrorBoundary>
  );
}

// ---------------------------------------------------------------------------
// RunAIButton — wired to POST /api/v1/analyses/from-orthanc
// ---------------------------------------------------------------------------

interface RunAIButtonProps {
  studyInstanceUid: string;
  patientRef?: string;
}

function RunAIButton({ studyInstanceUid, patientRef }: RunAIButtonProps): ReactElement {
  const navigate = useNavigate();
  const trigger = useTriggerAnalysis();

  return (
    <EMRButton
      size="sm"
      variant="primary"
      icon={IconRobot}
      loading={trigger.isPending}
      disabled={trigger.isPending}
      onClick={() => {
        // Stop the row click handler from firing — clicking "Run AI" should
        // start the analysis, not open the viewer.
        // EMRButton wraps Mantine's Button; the onClick is fired post-event.
        trigger.mutate(
          { studyInstanceUid, patientRef },
          {
            onSuccess: (data) => {
              navigate(`/cases/${encodeURIComponent(data.analysisId)}`);
            },
          },
        );
      }}
      data-testid={`run-ai-${studyInstanceUid}`}
    >
      {trigger.isPending ? 'Starting…' : 'Run AI'}
    </EMRButton>
  );
}

