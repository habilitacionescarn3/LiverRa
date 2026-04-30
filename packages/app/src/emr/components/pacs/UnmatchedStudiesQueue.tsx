// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// UnmatchedStudiesQueue (LiverRa)
// ============================================================================
// Admin queue for imaging studies that arrived at the PACS with a PatientID
// that doesn't match any LiverRa patient. Reviewer inspects DICOM metadata
// and links each study to the correct patient — a "lost and found" bin for
// medical images.
//
// Ported from MediMind with these adaptations:
//   - `useMedplum()` → `useLiverraFhir()`.
//   - `RequirePermission` switched to LiverRa's typed guard with
//     `study.delete` (closest LiverRa permission to MediMind's
//     `manage-imaging`).
//   - `EMRTable` → local `LiverraPacsTable` shim.
//   - Event-engine subscription dropped (LiverRa has no event engine yet);
//     60-second polling still keeps the board fresh.
// ============================================================================

import React, {
  memo,
  useMemo,
  useCallback,
  useState,
  useEffect,
  useRef,
} from 'react';
import {
  Box,
  Group,
  Text,
  Stack,
  Skeleton,
  TextInput,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconLink,
  IconRefresh,
  IconSearch,
  IconCheck,
  IconPhotoOff,
} from '@tabler/icons-react';
import { EMRTable, type EMRTableColumn } from './LiverraPacsTable';
import { EMRModal } from '../common/EMRModal';
import { RequirePermission } from '../access-control/RequirePermission';
import { useTranslation } from '../../contexts/TranslationContext';
import { useLiverraFhir } from '../../hooks/useLiverraFhir';
import type { FhirResourceLike } from '../../services/fhirClient';
import {
  listUnmatchedStudies,
  linkStudyToPatient,
  type ImagingStudyLike,
} from '../../services/pacs/imagingStudyService';
import styles from './UnmatchedStudiesQueue.module.css';

// ============================================================================
// Local FHIR shapes
// ============================================================================

interface PatientLike extends FhirResourceLike {
  resourceType: 'Patient';
  id?: string;
  name?: Array<{ family?: string; given?: string[] }>;
  birthDate?: string;
  identifier?: Array<{ system?: string; value?: string }>;
}

interface UnmatchedStudyRow {
  id: string;
  dicomPatientName: string;
  dicomPatientId: string;
  studyDate: string;
  modalities: string[];
  description: string;
  imageCount: number;
  timeInQueueMs: number;
  isOverdue: boolean;
  raw: ImagingStudyLike;
}

// ============================================================================
// Constants
// ============================================================================

const AUTO_REFRESH_MS = 60_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

const DICOM_UID_SYSTEM = 'urn:dicom:uid';

// ============================================================================
// Helpers
// ============================================================================

function toUnmatchedRow(study: ImagingStudyLike): UnmatchedStudyRow {
  const dicomPatientName =
    study.subject?.display || study.description || 'UNKNOWN';
  const dicomPatientId =
    study.identifier?.find((id) => id.system === DICOM_UID_SYSTEM)?.value || '';

  const modalities: string[] = [];
  for (const series of study.series || []) {
    const mod = series.modality?.code;
    if (mod && !modalities.includes(mod)) {
      modalities.push(mod);
    }
  }

  let imageCount = 0;
  for (const series of study.series || []) {
    imageCount += series.numberOfInstances ?? series.instance?.length ?? 0;
  }

  // meta.lastUpdated isn't in our loose `ImagingStudyLike`; fall back to now.
  const meta = (study as { meta?: { lastUpdated?: string } }).meta;
  const createdAt = meta?.lastUpdated
    ? new Date(meta.lastUpdated).getTime()
    : Date.now();
  const timeInQueueMs = Date.now() - createdAt;

  return {
    id: study.id || '',
    dicomPatientName,
    dicomPatientId,
    studyDate: study.started || '',
    modalities,
    description: study.description || '',
    imageCount: study.numberOfInstances ?? imageCount,
    timeInQueueMs,
    isOverdue: timeInQueueMs > TWENTY_FOUR_HOURS_MS,
    raw: study,
  };
}

function formatTimeInQueue(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

// ============================================================================
// Modality chips
// ============================================================================

function ModalityChips({
  modalities,
}: {
  modalities: string[];
}): React.ReactElement {
  if (modalities.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Group gap={4} wrap="wrap">
      {modalities.map((mod) => (
        <span key={mod} className={styles.modalityChip}>
          {mod}
        </span>
      ))}
    </Group>
  );
}

// ============================================================================
// Loading skeleton
// ============================================================================

function QueueSkeleton(): React.ReactElement {
  return (
    <Stack gap="xs">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} height={48} radius="sm" />
      ))}
    </Stack>
  );
}

// ============================================================================
// Empty state
// ============================================================================

function EmptyState({
  t,
}: {
  t: (key: string) => string;
}): React.ReactElement {
  return (
    <Box className={styles.emptyState}>
      <Box className={styles.emptyIcon}>
        <IconCheck size={28} style={{ color: 'var(--emr-success)' }} />
      </Box>
      <Text size="md" fw={500} style={{ color: 'var(--emr-text-primary)' }}>
        {t('pacs.unmatched.empty')}
      </Text>
      <Text size="sm" c="dimmed" mt={4}>
        {t('pacs.unmatched.emptyDescription')}
      </Text>
    </Box>
  );
}

// ============================================================================
// Patient search modal
// ============================================================================

interface PatientSearchModalProps {
  opened: boolean;
  onClose: () => void;
  onSelect: (patient: PatientLike) => void;
  t: (key: string) => string;
}

function PatientSearchModal({
  opened,
  onClose,
  onSelect,
  t,
}: PatientSearchModalProps): React.ReactElement {
  const fhir = useLiverraFhir();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientLike[]>([]);
  const [searching, setSearching] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const bundle = await fhir.search('Patient', {
        name: query,
        _count: '20',
        _sort: '-_lastUpdated',
      });
      const patients = (bundle.entry ?? [])
        .map((e) => e.resource as PatientLike | undefined)
        .filter(
          (r): r is PatientLike => !!r && r.resourceType === 'Patient'
        );
      setResults(patients);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[UnmatchedStudiesQueue] Patient search failed:', err);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [fhir, query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        void handleSearch();
      }
    },
    [handleSearch]
  );

  useEffect(() => {
    if (!opened) {
      setQuery('');
      setResults([]);
    }
  }, [opened]);

  const getPatientDisplay = (patient: PatientLike): string => {
    const name = patient.name?.[0];
    if (!name) return patient.id || 'Unknown';
    const parts = [name.family, ...(name.given || [])].filter(Boolean);
    return parts.join(' ') || patient.id || 'Unknown';
  };

  const getPatientId = (patient: PatientLike): string => {
    return (
      patient.identifier?.find((id) => id.system?.includes('personal-id'))
        ?.value ||
      patient.id ||
      ''
    );
  };

  return (
    <EMRModal
      opened={opened}
      onClose={onClose}
      size="md"
      icon={IconSearch}
      title={t('pacs.unmatched.searchPatient')}
      subtitle={t('pacs.unmatched.searchPatientSubtitle')}
    >
      <Stack gap="md">
        <Group gap="sm">
          <TextInput
            placeholder={t('pacs.unmatched.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            leftSection={<IconSearch size={16} />}
            style={{ flex: 1 }}
            data-testid="patient-search-input"
          />
          <button
            className={styles.linkButton}
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            data-testid="patient-search-button"
          >
            {searching ? '...' : t('common.search')}
          </button>
        </Group>

        {results.length > 0 && (
          <Stack gap={0}>
            {results.map((patient) => (
              <Box
                key={patient.id}
                className={styles.patientResultRow}
                onClick={() => onSelect(patient)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(patient);
                  }
                }}
                data-testid={`patient-result-${patient.id}`}
              >
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <Text size="sm" fw={500}>
                    {getPatientDisplay(patient)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {getPatientId(patient)}
                  </Text>
                </Group>
                {patient.birthDate && (
                  <Text size="xs" c="dimmed">
                    {t('pacs.management.dob')}: {patient.birthDate}
                  </Text>
                )}
              </Box>
            ))}
          </Stack>
        )}

        {results.length === 0 && query && !searching && (
          <Text size="sm" c="dimmed" ta="center" py="md">
            {t('pacs.unmatched.noPatientResults')}
          </Text>
        )}
      </Stack>
    </EMRModal>
  );
}

// ============================================================================
// Auto-refresh indicator
// ============================================================================

function RefreshIndicator({
  lastUpdated,
  t,
}: {
  lastUpdated: Date | null;
  t: (key: string) => string;
}): React.ReactElement {
  const timeStr = lastUpdated
    ? lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  return (
    <span className={styles.refreshIndicator}>
      <span className={styles.refreshDot} />
      {t('pacs.unmatched.autoRefresh')} · {t('pacs.unmatched.lastUpdate')}:{' '}
      {timeStr}
    </span>
  );
}

// ============================================================================
// Mobile card
// ============================================================================

interface MobileCardProps {
  study: UnmatchedStudyRow;
  onLink: () => void;
  t: (key: string) => string;
}

const MobileCard = memo(function MobileCard({
  study,
  onLink,
  t,
}: MobileCardProps): React.ReactElement {
  return (
    <Box className={styles.mobileCard} data-testid={`unmatched-card-${study.id}`}>
      <Group justify="space-between" wrap="wrap" gap="xs" mb="xs">
        <Text size="sm" fw={500} style={{ color: 'var(--emr-text-primary)' }}>
          {study.dicomPatientName}
        </Text>
        {study.isOverdue && (
          <span className={styles.warningBadge}>
            <IconAlertTriangle size={12} />
            &gt;24h
          </span>
        )}
      </Group>

      <Group gap="xs" mb="xs" wrap="wrap">
        <ModalityChips modalities={study.modalities} />
        <Text size="xs" c="dimmed">
          {study.description}
        </Text>
      </Group>

      <Group justify="space-between" wrap="wrap" gap="xs">
        <Text size="xs" c="dimmed">
          {study.studyDate
            ? new Date(study.studyDate).toLocaleDateString()
            : ''}{' '}
          · {study.imageCount} {t('pacs.images')}
        </Text>
        <button
          className={styles.linkButton}
          onClick={onLink}
          data-testid={`link-btn-${study.id}`}
        >
          <IconLink size={14} />
          {t('pacs.unmatched.linkToPatient')}
        </button>
      </Group>
    </Box>
  );
});

// ============================================================================
// Inner panel (assumes caller is already permission-gated)
// ============================================================================

function UnmatchedStudiesQueueInner(): React.ReactElement {
  const { t } = useTranslation();
  const fhir = useLiverraFhir();
  const isMobile = useMediaQuery('(max-width: 768px)');

  const [studies, setStudies] = useState<UnmatchedStudyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [selectedStudy, setSelectedStudy] = useState<UnmatchedStudyRow | null>(
    null
  );
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStudies = useCallback(async () => {
    try {
      const result = await listUnmatchedStudies(fhir);
      const rows = result.items.map(toUnmatchedRow);
      rows.sort((a, b) => {
        if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
        return b.timeInQueueMs - a.timeInQueueMs;
      });
      setStudies(rows);
      setLastUpdated(new Date());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch unmatched studies:', err);
    } finally {
      setLoading(false);
    }
  }, [fhir]);

  useEffect(() => {
    void fetchStudies();
    refreshTimerRef.current = setInterval(fetchStudies, AUTO_REFRESH_MS);
    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  }, [fetchStudies]);

  const handleLinkClick = useCallback((study: UnmatchedStudyRow) => {
    setSelectedStudy(study);
    setSearchModalOpen(true);
  }, []);

  const handlePatientSelect = useCallback(
    async (patient: PatientLike) => {
      if (!selectedStudy) return;

      try {
        const patientName = (() => {
          const name = patient.name?.[0];
          if (!name) return patient.id || '';
          return [name.family, ...(name.given || [])]
            .filter(Boolean)
            .join(' ');
        })();

        await linkStudyToPatient(
          fhir,
          selectedStudy.id,
          patient.id || '',
          patientName
        );

        setStudies((prev) => prev.filter((s) => s.id !== selectedStudy.id));

        setSearchModalOpen(false);
        setSelectedStudy(null);

        notifications.show({
          title: t('pacs.unmatched.linkSuccess'),
          message: t('pacs.unmatched.linkSuccessMessage'),
          color: 'green',
          icon: <IconCheck size={16} />,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to link study:', err);
        notifications.show({
          title: t('common.error'),
          message: t('pacs.unmatched.linkError'),
          color: 'red',
        });
      }
    },
    [fhir, selectedStudy, t]
  );

  const overdueCount = useMemo(
    () => studies.filter((s) => s.isOverdue).length,
    [studies]
  );

  const columns: EMRTableColumn<UnmatchedStudyRow>[] = useMemo(
    () => [
      {
        key: 'dicomPatientName',
        title: t('pacs.unmatched.column.patientName'),
        width: '150px',
        render: (row) => (
          <Text
            size="sm"
            fw={500}
            lineClamp={1}
            style={{ minWidth: 0 }}
          >
            {row.dicomPatientName}
          </Text>
        ),
      },
      {
        key: 'dicomPatientId',
        title: t('pacs.unmatched.column.patientId'),
        width: '120px',
        hideOnMobile: true,
        render: (row) => (
          <Text size="sm" lineClamp={1} style={{ minWidth: 0 }}>
            {row.dicomPatientId}
          </Text>
        ),
      },
      {
        key: 'studyDate',
        title: t('pacs.unmatched.column.studyDate'),
        width: '100px',
        sortable: true,
        render: (row) => (
          <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
            {row.studyDate ? new Date(row.studyDate).toLocaleDateString() : ''}
          </Text>
        ),
      },
      {
        key: 'modality',
        title: t('pacs.unmatched.column.modality'),
        width: '90px',
        render: (row) => <ModalityChips modalities={row.modalities} />,
      },
      {
        key: 'description',
        title: t('pacs.unmatched.column.description'),
        hideOnMobile: true,
        render: (row) => (
          <Text size="sm" lineClamp={1} style={{ minWidth: 0 }}>
            {row.description}
          </Text>
        ),
      },
      {
        key: 'imageCount',
        title: t('pacs.unmatched.column.images'),
        width: '70px',
        align: 'center',
        hideOnTablet: true,
        render: (row) => <Text size="sm">{row.imageCount}</Text>,
      },
      {
        key: 'timeInQueue',
        title: t('pacs.unmatched.column.timeInQueue'),
        width: '100px',
        sortable: true,
        render: (row) => (
          <Group gap={4} wrap="nowrap">
            {row.isOverdue && (
              <IconAlertTriangle
                size={14}
                style={{ color: 'var(--emr-error)', flexShrink: 0 }}
              />
            )}
            <span
              className={
                row.isOverdue ? styles.timeInQueueWarning : styles.timeInQueue
              }
            >
              {formatTimeInQueue(row.timeInQueueMs)}
            </span>
          </Group>
        ),
      },
      {
        key: 'actions',
        title: '',
        width: '130px',
        align: 'center',
        render: (row) => (
          <button
            className={styles.linkButton}
            onClick={(e) => {
              e.stopPropagation();
              handleLinkClick(row);
            }}
            aria-label={t('pacs.unmatched.linkToPatient')}
            data-testid={`link-btn-${row.id}`}
          >
            <IconLink size={14} />
            {t('pacs.unmatched.linkToPatient')}
          </button>
        ),
      },
    ],
    [t, handleLinkClick]
  );

  const rowLeftBorder = useCallback(
    (row: UnmatchedStudyRow): string | false => {
      if (row.isOverdue) return 'var(--emr-error)';
      return false;
    },
    []
  );

  if (loading) {
    return <QueueSkeleton />;
  }

  return (
    <Box className={styles.container} data-testid="unmatched-studies-queue">
      <Box className={styles.headerRow}>
        <Box className={styles.titleGroup}>
          <Text
            size="lg"
            fw={600}
            style={{
              color: 'var(--emr-text-primary)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {t('pacs.unmatched.title')}
          </Text>
          {studies.length > 0 && (
            <span
              className={styles.countBadge}
              data-testid="unmatched-count"
            >
              {studies.length}
            </span>
          )}
          {overdueCount > 0 && (
            <span className={styles.warningBadge} data-testid="overdue-count">
              <IconAlertTriangle size={12} />
              {overdueCount} &gt;24h
            </span>
          )}
        </Box>

        <Box className={styles.refreshGroup}>
          <RefreshIndicator lastUpdated={lastUpdated} t={t} />
          <IconRefresh
            size={16}
            style={{
              color: 'var(--emr-text-secondary)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            onClick={() => {
              setLoading(true);
              void fetchStudies();
            }}
            aria-label={t('pacs.unmatched.refresh')}
            data-testid="refresh-button"
          />
        </Box>
      </Box>

      {studies.length === 0 ? (
        <EmptyState t={t} />
      ) : isMobile ? (
        <Stack gap={0}>
          {studies.map((study) => (
            <MobileCard
              key={study.id}
              study={study}
              onLink={() => handleLinkClick(study)}
              t={t}
            />
          ))}
        </Stack>
      ) : (
        <EMRTable<UnmatchedStudyRow>
          columns={columns}
          data={studies}
          rowLeftBorder={rowLeftBorder}
          enableKeyboardNavigation
          striped
          stickyHeader
          compact
          ariaLabel={t('pacs.unmatched.tableLabel')}
          emptyState={{
            icon: IconPhotoOff,
            title: t('pacs.unmatched.empty'),
            description: t('pacs.unmatched.emptyDescription'),
          }}
        />
      )}

      <PatientSearchModal
        opened={searchModalOpen}
        onClose={() => {
          setSearchModalOpen(false);
          setSelectedStudy(null);
        }}
        onSelect={handlePatientSelect}
        t={t}
      />
    </Box>
  );
}

// ============================================================================
// Exported (permission-gated) component
// ============================================================================

export const UnmatchedStudiesQueue = memo(function UnmatchedStudiesQueue(): React.ReactElement {
  // MediMind used `manage-imaging`; LiverRa's closest typed permission is
  // `study.delete` (same admin bucket — only study admins can link unmatched
  // studies to a patient).
  return (
    <RequirePermission permission="study.delete">
      <UnmatchedStudiesQueueInner />
    </RequirePermission>
  );
});

export default UnmatchedStudiesQueue;
