// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// DicomTagBrowser (LiverRa)
// ============================================================================
// "View source" for a DICOM study. Fetches the first instance's metadata via
// DICOMweb WADO-RS and lists every tag (id + human label + VR + value) in a
// searchable table. Pure DICOM + JSON — no Medplum dependency.
//
// Ported from MediMind. The only adaptation is the import path for
// `useDicomWebClient` (LiverRa keeps it under `hooks/` not `hooks/pacs/`).
// ============================================================================

import React, { useMemo, useState, useEffect, useRef } from 'react';
import { TextInput, Stack, Text, Loader } from '@mantine/core';
import { IconSearch, IconFileInfo } from '@tabler/icons-react';
import { EMRModal } from '../common/EMRModal';
import { useTranslation } from '../../contexts/TranslationContext';
import { useDicomWebClient } from '../../hooks/useDicomWebClient';
import type {
  DicomJsonObject,
  DicomJsonTag,
} from '../../services/pacs/dicomwebClient';
import styles from './DicomTagBrowser.module.css';

// ============================================================================
// Tag dictionary — the most common DICOM tags we want human-friendly names for.
// ============================================================================

const TAG_NAMES: Record<string, string> = {
  '00080005': 'Specific Character Set',
  '00080008': 'Image Type',
  '00080016': 'SOP Class UID',
  '00080018': 'SOP Instance UID',
  '00080020': 'Study Date',
  '00080021': 'Series Date',
  '00080030': 'Study Time',
  '00080031': 'Series Time',
  '00080050': 'Accession Number',
  '00080060': 'Modality',
  '00080070': 'Manufacturer',
  '00080080': 'Institution Name',
  '00080090': 'Referring Physician',
  '00081030': 'Study Description',
  '0008103E': 'Series Description',
  '00081090': 'Manufacturer Model Name',
  '00100010': 'Patient Name',
  '00100020': 'Patient ID',
  '00100030': 'Patient Birth Date',
  '00100040': 'Patient Sex',
  '00101010': 'Patient Age',
  '00101020': 'Patient Size',
  '00101030': 'Patient Weight',
  '00180015': 'Body Part Examined',
  '00180050': 'Slice Thickness',
  '00180060': 'KVP',
  '00180088': 'Spacing Between Slices',
  '00181000': 'Device Serial Number',
  '00181030': 'Protocol Name',
  '00181100': 'Reconstruction Diameter',
  '00181150': 'Exposure Time',
  '00181151': 'X-Ray Tube Current',
  '00181152': 'Exposure',
  '0020000D': 'Study Instance UID',
  '0020000E': 'Series Instance UID',
  '00200010': 'Study ID',
  '00200011': 'Series Number',
  '00200012': 'Acquisition Number',
  '00200013': 'Instance Number',
  '00200020': 'Patient Orientation',
  '00200032': 'Image Position (Patient)',
  '00200037': 'Image Orientation (Patient)',
  '00200052': 'Frame of Reference UID',
  '00201206': 'Number of Study Related Series',
  '00201208': 'Number of Study Related Instances',
  '00280002': 'Samples Per Pixel',
  '00280004': 'Photometric Interpretation',
  '00280010': 'Rows',
  '00280011': 'Columns',
  '00280030': 'Pixel Spacing',
  '00280100': 'Bits Allocated',
  '00280101': 'Bits Stored',
  '00280102': 'High Bit',
  '00280103': 'Pixel Representation',
  '00281050': 'Window Center',
  '00281051': 'Window Width',
  '00281052': 'Rescale Intercept',
  '00281053': 'Rescale Slope',
  '00400254': 'Performed Procedure Step Description',
  '7FE00010': 'Pixel Data',
};

// ============================================================================
// Props
// ============================================================================

export interface DicomTagBrowserProps {
  opened: boolean;
  onClose: () => void;
  /** DICOM StudyInstanceUID to fetch metadata for. */
  studyInstanceUid: string;
}

// ============================================================================
// Helpers
// ============================================================================

interface TagRow {
  tagId: string;
  tagName: string;
  vr: string;
  value: string;
}

/** Format "00100010" → "(0010,0010)". */
function formatTagId(tag: string): string {
  const clean = tag.replace(/[^0-9A-Fa-f]/g, '');
  if (clean.length === 8) {
    return `(${clean.slice(0, 4)},${clean.slice(4, 8)})`.toUpperCase();
  }
  return tag;
}

/** Extract a printable string from a DICOM JSON tag value. */
function formatTagValue(tag: DicomJsonTag): string {
  if (!tag.Value || tag.Value.length === 0) {
    return '';
  }

  return tag.Value.map((v) => {
    if (typeof v === 'string' || typeof v === 'number') {
      return String(v);
    }
    if (typeof v === 'object' && v !== null) {
      // PersonName has Alphabetic/Ideographic/Phonetic sub-fields.
      if ('Alphabetic' in v) {
        return String((v as Record<string, unknown>).Alphabetic ?? '');
      }
      return JSON.stringify(v);
    }
    return '';
  }).join(' \\ ');
}

/** Parse a DICOM JSON object into flat tag rows. */
function parseTags(metadata: DicomJsonObject): TagRow[] {
  const rows: TagRow[] = [];
  for (const [tagId, tagData] of Object.entries(metadata)) {
    // Skip pixel data (huge + useless as text).
    if (tagId === '7FE00010') {
      rows.push({
        tagId: formatTagId(tagId),
        tagName:
          TAG_NAMES[tagId.toUpperCase()] || TAG_NAMES[tagId] || 'Unknown',
        vr: tagData.vr,
        value: '[Pixel Data]',
      });
      continue;
    }

    rows.push({
      tagId: formatTagId(tagId),
      tagName: TAG_NAMES[tagId.toUpperCase()] || TAG_NAMES[tagId] || 'Unknown',
      vr: tagData.vr,
      value: formatTagValue(tagData),
    });
  }
  return rows.sort((a, b) => a.tagId.localeCompare(b.tagId));
}

// ============================================================================
// Component
// ============================================================================

export function DicomTagBrowser({
  opened,
  onClose,
  studyInstanceUid,
}: DicomTagBrowserProps): React.ReactElement {
  const { t } = useTranslation();
  const dicomWebClient = useDicomWebClient();
  const [filter, setFilter] = useState('');
  const [debouncedFilter, setDebouncedFilter] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce the filter value by 150ms so typing stays snappy.
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setDebouncedFilter(filter);
    }, 150);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [filter]);

  // Fetch metadata when the modal opens.
  useEffect(() => {
    if (!opened || !studyInstanceUid) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const fetchMetadata = async (): Promise<void> => {
      try {
        const metadata =
          await dicomWebClient.retrieveStudyMetadata(studyInstanceUid);
        if (cancelled) return;

        // Use the first instance's metadata (contains study + series + instance tags).
        if (metadata.length > 0) {
          setAllTags(parseTags(metadata[0]));
        } else {
          setAllTags([]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : t('pacs.dicomTags.loadError')
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void fetchMetadata();
    return () => {
      cancelled = true;
    };
  }, [opened, studyInstanceUid, dicomWebClient, t]);

  // Filter by debounced query — the 150ms delay keeps the UI snappy for
  // 200-500+ row studies.
  const filteredTags = useMemo(() => {
    if (!debouncedFilter) {
      return allTags;
    }
    const lower = debouncedFilter.toLowerCase();
    return allTags.filter(
      (tag) =>
        tag.tagId.toLowerCase().includes(lower) ||
        tag.tagName.toLowerCase().includes(lower) ||
        tag.value.toLowerCase().includes(lower) ||
        tag.vr.toLowerCase().includes(lower)
    );
  }, [allTags, debouncedFilter]);

  return (
    <EMRModal
      opened={opened}
      onClose={onClose}
      title={t('pacs.dicomTags.title')}
      icon={IconFileInfo}
      size="lg"
      showFooter={false}
      testId="dicom-tag-browser"
    >
      <Stack gap="sm">
        <TextInput
          placeholder={t('pacs.dicomTags.searchPlaceholder')}
          leftSection={<IconSearch size={16} />}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          size="sm"
        />

        {loading && (
          <div className={styles.emptyMessage}>
            <Loader size="sm" />
          </div>
        )}

        {error && (
          <div className={styles.emptyMessage}>
            <Text size="sm" c="red">
              {error}
            </Text>
          </div>
        )}

        {!loading && !error && filteredTags.length === 0 && (
          <div className={styles.emptyMessage}>
            {allTags.length === 0
              ? t('pacs.dicomTags.noTags')
              : t('pacs.filters.noResults')}
          </div>
        )}

        {!loading && filteredTags.length > 0 && (
          <>
            <div className={styles.tableContainer}>
              <table className={styles.tagTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('pacs.dicomTags.tagId')}</th>
                    <th scope="col">{t('pacs.dicomTags.tagName')}</th>
                    <th scope="col">VR</th>
                    <th scope="col">{t('pacs.dicomTags.value')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTags.map((tag) => (
                    <tr key={tag.tagId}>
                      <td className={styles.tagId}>{tag.tagId}</td>
                      <td className={styles.tagName}>{tag.tagName}</td>
                      <td>{tag.vr}</td>
                      <td className={styles.tagValue}>{tag.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Text className={styles.tagCount}>
              {t('pacs.dicomTags.tagCount')
                .replace('{filtered}', String(filteredTags.length))
                .replace('{total}', String(allTags.length))}
            </Text>
          </>
        )}
      </Stack>
    </EMRModal>
  );
}
