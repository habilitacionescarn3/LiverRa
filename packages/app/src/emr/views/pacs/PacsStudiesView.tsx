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

import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { Dropzone, type FileRejection } from '@mantine/dropzone';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconCloudUpload,
  IconFolderOpen,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';

import { useDicomWebClient } from '../../hooks/useDicomWebClient';
import { useStowUpload, NoDicomFilesError } from '../../hooks/useStowUpload';
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

export default function PacsStudiesView(): JSX.Element {
  const navigate = useNavigate();
  const client = useDicomWebClient();
  const { data, isPending, isError, error, refetch, isFetching } = useStudies(client);

  const [uploadError, setUploadError] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const upload = useStowUpload({
    onUploaded: (result) => {
      setUploadError(null);
      if (result.stow.failedCount > 0) {
        setUploadError(
          `${result.stow.failedCount} file(s) rejected by Orthanc: ${result.stow.failures.join('; ')}`,
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
    <Stack gap="lg" p="md" data-testid="pacs-studies-view">
      <Group justify="space-between" align="flex-end">
        <Box>
          <Title order={2}>PACS studies</Title>
          <Text size="sm" c="dimmed">
            DICOM studies stored locally on Orthanc. Upload a study to view it in the
            LiverRa viewer. AI analysis pipelines are not run from this page.
          </Text>
        </Box>
        <Group gap="xs">
          <Button
            variant="default"
            leftSection={<IconFolderOpen size={16} />}
            onClick={() => folderInputRef.current?.click()}
            disabled={upload.isPending}
            data-testid="pacs-select-folder"
          >
            Select folder
          </Button>
          <Button
            variant="subtle"
            leftSection={<IconRefresh size={16} />}
            onClick={() => refetch()}
            loading={isFetching}
          >
            Refresh
          </Button>
        </Group>
      </Group>

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
      >
        <Group justify="center" gap="md" mih={120} style={{ pointerEvents: 'none' }}>
          <Dropzone.Accept>
            <IconCloudUpload size={44} />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX size={44} />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconCloudUpload size={44} />
          </Dropzone.Idle>
          <Box>
            <Text size="lg" fw={500}>
              Drag DICOM files or a folder here
            </Text>
            <Text size="sm" c="dimmed">
              Single .dcm, multiple files, or a whole series folder. Uploads go
              directly to Orthanc via STOW-RS.
            </Text>
          </Box>
        </Group>
      </Dropzone>

      {uploadError && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Upload issue">
          {uploadError}
        </Alert>
      )}

      {isError && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Cannot reach Orthanc">
          {(error as Error)?.message ?? 'DICOMweb request failed.'} Check that Orthanc
          is running (<code>docker compose -f deploy/local/docker-compose.yml ps</code>).
        </Alert>
      )}

      {isPending && (
        <Group justify="center" py="xl">
          <Loader />
          <Text>Loading studies…</Text>
        </Group>
      )}

      {!isPending && !isError && rows.length === 0 && (
        <Alert color="gray" title="No studies yet">
          Drop a DICOM file above to upload your first study.
        </Alert>
      )}

      {rows.length > 0 && (
        <Table highlightOnHover striped withTableBorder data-testid="pacs-studies-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Patient ID</Table.Th>
              <Table.Th>Patient name</Table.Th>
              <Table.Th>Study date</Table.Th>
              <Table.Th>Description</Table.Th>
              <Table.Th>Modality</Table.Th>
              <Table.Th ta="right">Instances</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr
                key={r.key}
                style={{ cursor: 'pointer' }}
                onClick={() => navigate(`/pacs/studies/${encodeURIComponent(r.uid)}`)}
                data-testid={`pacs-study-row-${r.uid}`}
              >
                <Table.Td>{r.patientId}</Table.Td>
                <Table.Td>{r.patientName}</Table.Td>
                <Table.Td>{r.studyDate}</Table.Td>
                <Table.Td>{r.description}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {r.modalities.length === 0 ? (
                      <Text c="dimmed" size="sm">—</Text>
                    ) : (
                      r.modalities.map((m) => (
                        <Badge key={m} size="sm" variant="light">{m}</Badge>
                      ))
                    )}
                  </Group>
                </Table.Td>
                <Table.Td ta="right">{r.instanceCount}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
