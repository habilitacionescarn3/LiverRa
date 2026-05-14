// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// StudyManagementPanel (LiverRa)
// ============================================================================
// Admin-only panel for reassigning or deleting imaging studies. Lives inside
// the admin imaging view. Two flows:
//   1. Reassign a study to a different patient (wrong patient linked).
//   2. Delete a study (blocked if any DiagnosticReport references it).
//
// Both flows will emit AuditEvent rows in Phase 4. For now the AuditEvent
// writes are no-ops (MediMind used `logStudyModify` / `logStudyDelete` from
// `auditService` — not ported yet).
//
// Ported from MediMind. Adaptations:
//   - `useMedplum()` → `useLiverraFhir()`; `usePermissionCheck` →
//     `useHasPermission`; `manage-imaging` → `study.delete` (LiverRa closest
//     typed equivalent).
//   - `auditService` calls replaced with inline `console.info` stubs that log
//     the payload we'd emit. Phase 4 replaces those with real Supabase writes.
//   - `@medplum/fhirtypes` imports dropped in favour of loose local types.
// ============================================================================

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Box,
  Center,
  Group,
  Stack,
  Text,
  Loader,
  Alert,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconSearch,
  IconArrowsExchange,
  IconTrash,
  IconAlertTriangle,
  IconCheck,
  IconUser,
  IconLock,
} from '@tabler/icons-react';
import { EMRModal } from '../common/EMRModal';
import { EMRButton } from '../common/EMRButton';
import { EMRTextInput } from '../shared/EMRFormFields/EMRTextInput';
import { EMRTextarea } from '../shared/EMRFormFields/EMRTextarea';
import { useTranslation } from '../../contexts/TranslationContext';
import { toLocaleDateForPacs } from '../../services/pacs/dateFormatHelpers';
import type { Locale } from '../../services/localeService';
import { useHasPermission } from '../../contexts/PermissionContext';
import { useLiverraFhir } from '../../hooks/useLiverraFhir';
import type { FhirResourceLike } from '../../services/fhirClient';
import { phaseStubLog } from '../../services/pacs/phaseStubLog';
import {
  getById,
  getByAccessionNumber,
  reassignStudy,
  findReportsForStudy,
  deleteStudy,
  deleteStudyAnnotations,
  type ImagingStudyLike,
  type DiagnosticReportLike,
} from '../../services/pacs/imagingStudyService';
import styles from './StudyManagementPanel.module.css';

// ============================================================================
// Local Patient shape
// ============================================================================

interface PatientLike extends FhirResourceLike {
  resourceType: 'Patient';
  id?: string;
  name?: Array<{ family?: string; given?: string[] }>;
  birthDate?: string;
  identifier?: Array<{ system?: string; value?: string }>;
}

// ============================================================================
// Stub constants — mirror MediMind's PACS_IDENTIFIER_SYSTEMS.ACCESSION_NUMBER
// ============================================================================

const ACCESSION_NUMBER_SYSTEM = 'http://liverra.ai/fhir/sid/accession-number';

// ============================================================================
// Helpers
// ============================================================================

function getPatientDisplay(study: ImagingStudyLike): string {
  return (
    study.subject?.display ||
    study.subject?.reference?.replace('Patient/', '') ||
    ''
  );
}

function getPatientId(study: ImagingStudyLike): string {
  const ref = study.subject?.reference || '';
  return ref.replace('Patient/', '');
}

function getAccession(study: ImagingStudyLike): string {
  return (
    study.identifier?.find((id) => id.system === ACCESSION_NUMBER_SYSTEM)
      ?.value || ''
  );
}

function formatPatientName(patient: PatientLike): string {
  const name = patient.name?.[0];
  if (!name) return patient.id || 'Unknown';
  const parts = [name.family, ...(name.given || [])].filter(Boolean);
  return parts.join(' ') || patient.id || 'Unknown';
}

function getPersonalId(patient: PatientLike): string {
  return (
    patient.identifier?.find((id) => id.system?.includes('personal-id'))
      ?.value || ''
  );
}

// ============================================================================
// Audit stubs (TODO(phase-4): replace with Supabase-backed AuditEvent writes)
// ============================================================================

function logStudyModify(payload: {
  studyId?: string;
  patientId?: string;
  description: string;
}): void {
  phaseStubLog('audit-stub', 'logStudyModify', payload as Record<string, unknown>);
}

function logStudyDelete(payload: {
  studyId?: string;
  patientId?: string;
  description: string;
}): void {
  phaseStubLog('audit-stub', 'logStudyDelete', payload as Record<string, unknown>);
}

// ============================================================================
// Study info card
// ============================================================================

interface StudyInfoProps {
  study: ImagingStudyLike;
  t: (key: string) => string;
  locale: Locale;
}

function StudyInfoCard({ study, t, locale }: StudyInfoProps): React.ReactElement {
  const modalities =
    study.series
      ?.map((s) => s.modality?.code)
      .filter(Boolean)
      .join(', ') || '—';
  const imageCount = study.numberOfInstances ?? 0;

  return (
    <Box className={styles.studyCard}>
      <Text
        size="sm"
        fw={600}
        mb="xs"
        style={{ color: 'var(--emr-text-primary)' }}
      >
        {t('pacs.management.studyInfo')}
      </Text>
      <Box className={styles.studyMeta}>
        <Box className={styles.metaItem}>
          <Text size="xs" c="dimmed">
            {t('pacs.management.accession')}
          </Text>
          <Text size="sm" fw={500}>
            {getAccession(study) || '—'}
          </Text>
        </Box>
        <Box className={styles.metaItem}>
          <Text size="xs" c="dimmed">
            {t('pacs.management.modality')}
          </Text>
          <Text size="sm" fw={500}>
            {modalities}
          </Text>
        </Box>
        <Box className={styles.metaItem}>
          <Text size="xs" c="dimmed">
            {t('pacs.management.date')}
          </Text>
          <Text size="sm" fw={500}>
            {study.started ? toLocaleDateForPacs(study.started, locale) : '—'}
          </Text>
        </Box>
        <Box className={styles.metaItem}>
          <Text size="xs" c="dimmed">
            {t('pacs.management.description')}
          </Text>
          <Text size="sm" fw={500}>
            {study.description || '—'}
          </Text>
        </Box>
        <Box className={styles.metaItem}>
          <Text size="xs" c="dimmed">
            {t('pacs.management.images')}
          </Text>
          <Text size="sm" fw={500}>
            {imageCount}
          </Text>
        </Box>
        <Box className={styles.metaItem}>
          <Text size="xs" c="dimmed">
            {t('pacs.management.patient')}
          </Text>
          <Text size="sm" fw={500}>
            {getPatientDisplay(study) || '—'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

// ============================================================================
// Reassign modal
// ============================================================================

interface ReassignModalProps {
  opened: boolean;
  onClose: () => void;
  study: ImagingStudyLike;
  onSuccess: () => void;
}

function ReassignModal({
  opened,
  onClose,
  study,
  onSuccess,
}: ReassignModalProps): React.ReactElement {
  const { t, locale } = useTranslation();
  const fhir = useLiverraFhir();

  const [patientQuery, setPatientQuery] = useState('');
  const [patientResults, setPatientResults] = useState<PatientLike[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState<PatientLike | null>(
    null
  );

  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // M-HOOK-6: abort in-flight searches when the modal closes or the
  // user kicks off another search. Today the FHIR client is a stub
  // that does not honor ``signal``; once the real client lands the
  // controller is plumbed through ready-to-go.
  const searchAbortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef<boolean>(false);

  useEffect(() => {
    if (!opened) {
      setPatientQuery('');
      setPatientResults([]);
      setSelectedPatient(null);
      setReason('');
      // Abort any in-flight search the modal initiated.
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
    }
  }, [opened]);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
    };
  }, []);

  const handlePatientSearch = useCallback(async () => {
    if (!patientQuery.trim()) return;
    // Abort any prior search so a fast double-Enter does not race two
    // setState calls into the React tree.
    searchAbortRef.current?.abort();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;
    setSearching(true);
    try {
      const bundle = await fhir.search('Patient', {
        name: patientQuery,
        _count: '15',
        _sort: '-_lastUpdated',
      });
      if (ctrl.signal.aborted || cancelledRef.current) return;
      const patients = (bundle.entry ?? [])
        .map((e) => e.resource as PatientLike | undefined)
        .filter(
          (r): r is PatientLike => !!r && r.resourceType === 'Patient'
        );
      setPatientResults(patients);
    } catch (err) {
      if (ctrl.signal.aborted || cancelledRef.current) return;
      // eslint-disable-next-line no-console
      console.warn('[StudyManagementPanel] Patient search failed:', err);
      setPatientResults([]);
    } finally {
      if (!ctrl.signal.aborted && !cancelledRef.current) {
        setSearching(false);
      }
    }
  }, [fhir, patientQuery]);

  const handlePatientKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') void handlePatientSearch();
    },
    [handlePatientSearch]
  );

  const canSubmit = !!(
    selectedPatient &&
    reason.trim().length >= 10 &&
    selectedPatient.id !== getPatientId(study) &&
    !submitting
  );

  const handleSubmit = useCallback(async () => {
    if (!selectedPatient?.id || !canSubmit) return;

    if (selectedPatient.id === getPatientId(study)) {
      notifications.show({
        title: t('common.error'),
        message: t('pacs.management.reassign.samePatient'),
        color: 'red',
      });
      return;
    }

    setSubmitting(true);
    try {
      const targetDisplay = formatPatientName(selectedPatient);
      const oldPatientId = getPatientId(study);
      const oldPatientDisplay = getPatientDisplay(study);

      const reassignResult = await reassignStudy(
        fhir,
        study.id!,
        selectedPatient.id,
        targetDisplay
      );

      logStudyModify({
        studyId: study.id,
        patientId: selectedPatient.id,
        description: `Study reassigned from ${oldPatientDisplay} (${oldPatientId}) to ${targetDisplay} (${selectedPatient.id}). Reason: ${reason}`,
      });

      if (reassignResult.failures.length > 0) {
        notifications.show({
          title: t('pacs.management.reassign.partialSuccess'),
          message: `${reassignResult.failures.length} resource(s) failed to update`,
          color: 'yellow',
          icon: <IconAlertTriangle size={16} />,
        });
      } else {
        notifications.show({
          title: t('pacs.management.reassign.success'),
          message: `${getAccession(study)} → ${targetDisplay}`,
          color: 'green',
          icon: <IconCheck size={16} />,
        });
      }

      onSuccess();
      onClose();
    } catch {
      notifications.show({
        title: t('common.error'),
        message: t('pacs.management.reassign.error'),
        color: 'red',
      });
    } finally {
      setSubmitting(false);
    }
  }, [selectedPatient, canSubmit, study, fhir, reason, t, onSuccess, onClose]);

  const currentPatientId = getPatientId(study);
  const currentPatientDisplay = getPatientDisplay(study);

  return (
    <EMRModal
      opened={opened}
      onClose={onClose}
      size="md"
      icon={IconArrowsExchange}
      title={t('pacs.management.reassign.title')}
      subtitle={t('pacs.management.reassign.subtitle')}
      submitLabel={t('pacs.management.reassign.confirm')}
      cancelLabel={t('common.cancel')}
      onSubmit={handleSubmit}
      submitLoading={submitting}
      submitDisabled={!canSubmit}
      testId="reassign-study-modal"
    >
      <Stack gap="md">
        <StudyInfoCard study={study} t={t} locale={locale} />

        <Box>
          <Text size="sm" fw={600} mb={4}>
            {t('pacs.management.reassign.currentPatient')}
          </Text>
          {currentPatientId ? (
            <Box className={styles.patientCard}>
              <Group gap="xs">
                <IconUser
                  size={16}
                  style={{
                    color: 'var(--emr-secondary)',
                    flexShrink: 0,
                  }}
                />
                <Text size="sm" fw={500}>
                  {currentPatientDisplay}
                </Text>
                <Text size="xs" c="dimmed">
                  {currentPatientId}
                </Text>
              </Group>
            </Box>
          ) : (
            <Text size="sm" c="dimmed">
              {t('pacs.management.reassign.noPatient')}
            </Text>
          )}
        </Box>

        <Box>
          <Text size="sm" fw={600} mb={4}>
            {t('pacs.management.reassign.targetPatient')}
          </Text>
          {selectedPatient ? (
            <Box className={styles.patientCard}>
              <Group justify="space-between" wrap="wrap" gap="xs">
                <Group gap="xs">
                  <IconUser
                    size={16}
                    style={{
                      color: 'var(--emr-success)',
                      flexShrink: 0,
                    }}
                  />
                  <Text size="sm" fw={500}>
                    {formatPatientName(selectedPatient)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {getPersonalId(selectedPatient)}
                  </Text>
                </Group>
                <Text
                  size="xs"
                  c="blue"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelectedPatient(null)}
                  data-testid="change-target-patient"
                >
                  {t('common.change')}
                </Text>
              </Group>
            </Box>
          ) : (
            <>
              <Group gap="sm">
                <EMRTextInput
                  placeholder={t('pacs.management.reassign.searchTarget')}
                  value={patientQuery}
                  onChange={setPatientQuery}
                  onKeyDown={handlePatientKeyDown}
                  leftSection={<IconSearch size={16} />}
                  style={{ flex: 1 }}
                  data-testid="target-patient-search"
                />
                <EMRButton
                  onClick={handlePatientSearch}
                  disabled={searching || !patientQuery.trim()}
                  loading={searching}
                  size="sm"
                  data-testid="target-patient-search-btn"
                >
                  {t('common.search')}
                </EMRButton>
              </Group>

              {patientResults.length > 0 && (
                <Stack
                  gap={0}
                  mt="xs"
                  style={{ maxHeight: 200, overflow: 'auto' }}
                >
                  {patientResults.map((patient) => (
                    <Box
                      key={patient.id}
                      className={styles.patientResult}
                      onClick={() => setSelectedPatient(patient)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedPatient(patient);
                        }
                      }}
                      data-testid={`target-patient-${patient.id}`}
                    >
                      <Group justify="space-between" wrap="wrap" gap="xs">
                        <Text size="sm" fw={500}>
                          {formatPatientName(patient)}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {getPersonalId(patient)}
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
            </>
          )}
        </Box>

        <EMRTextarea
          label={t('pacs.management.reassign.reason')}
          placeholder={t('pacs.management.reassign.reasonPlaceholder')}
          value={reason}
          onChange={setReason}
          minRows={2}
          maxRows={4}
          error={
            reason.length > 0 && reason.length < 10
              ? t('pacs.management.reassign.reasonMinLength')
              : undefined
          }
          data-testid="reassign-reason"
        />
      </Stack>
    </EMRModal>
  );
}

// ============================================================================
// Delete modal
// ============================================================================

interface DeleteModalProps {
  opened: boolean;
  onClose: () => void;
  study: ImagingStudyLike;
  onSuccess: () => void;
}

function DeleteModal({
  opened,
  onClose,
  study,
  onSuccess,
}: DeleteModalProps): React.ReactElement {
  const { t, locale } = useTranslation();
  const fhir = useLiverraFhir();

  const [reports, setReports] = useState<DiagnosticReportLike[]>([]);
  const [checkingRefs, setCheckingRefs] = useState(true);
  const isBlocked = reports.length > 0;

  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [reportCheckFailed, setReportCheckFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!opened || !study.id) return;
    let cancelled = false;

    setCheckingRefs(true);
    setReports([]);
    setReason('');
    setConfirmText('');
    setReportCheckFailed(false);

    findReportsForStudy(fhir, study.id)
      .then((found) => {
        if (!cancelled) setReports(found);
      })
      .catch(() => {
        if (!cancelled) setReportCheckFailed(true);
      })
      .finally(() => {
        if (!cancelled) setCheckingRefs(false);
      });

    return () => {
      cancelled = true;
    };
  }, [opened, study.id, fhir]);

  const canSubmit =
    !isBlocked &&
    !checkingRefs &&
    !reportCheckFailed &&
    reason.trim().length >= 10 &&
    confirmText === 'DELETE' &&
    !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !study.id) return;

    setSubmitting(true);
    try {
      const patientId = getPatientId(study);
      const patientDisplay = getPatientDisplay(study);

      const annotationsDeleted = await deleteStudyAnnotations(fhir, study.id);
      await deleteStudy(fhir, study.id);

      logStudyDelete({
        studyId: study.id,
        patientId: patientId || undefined,
        description: `Study deleted (${getAccession(study) || study.id}). Patient: ${
          patientDisplay || 'none'
        }. Annotations removed: ${annotationsDeleted}. Reason: ${reason}`,
      });

      const message =
        annotationsDeleted > 0
          ? `${annotationsDeleted} ${t(
              'pacs.management.delete.annotationsDeleted'
            )}`
          : t('pacs.management.delete.success');

      notifications.show({
        title: t('pacs.management.delete.success'),
        message,
        color: 'green',
        icon: <IconCheck size={16} />,
      });

      onSuccess();
      onClose();
    } catch {
      notifications.show({
        title: t('common.error'),
        message: t('pacs.management.delete.error'),
        color: 'red',
      });
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, study, fhir, reason, t, onSuccess, onClose]);

  return (
    <EMRModal
      opened={opened}
      onClose={onClose}
      size="md"
      icon={IconTrash}
      title={t('pacs.management.delete.title')}
      subtitle={t('pacs.management.delete.subtitle')}
      submitLabel={t('pacs.management.delete.confirm')}
      cancelLabel={t('common.cancel')}
      onSubmit={handleSubmit}
      submitLoading={submitting}
      submitDisabled={!canSubmit}
      submitColor="red"
      testId="delete-study-modal"
    >
      <Stack gap="md">
        <StudyInfoCard study={study} t={t} locale={locale} />

        {checkingRefs && (
          <Group gap="sm" justify="center" py="md">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
              {t('pacs.management.delete.checking')}
            </Text>
          </Group>
        )}

        {!checkingRefs && isBlocked && (
          <Box>
            <Alert
              icon={<IconAlertTriangle size={18} />}
              title={t('pacs.management.delete.blocked')}
              color="red"
              variant="light"
            >
              <Text size="sm">
                {t('pacs.management.delete.blockedDescription')}
              </Text>
              <Text size="sm" fw={600} mt="xs">
                {t('pacs.management.delete.referencedReports')}:
              </Text>
              <ul className={styles.reportList}>
                {reports.map((r) => (
                  <li key={r.id}>
                    {(
                      r as unknown as {
                        code?: { text?: string; coding?: Array<{ display?: string }> };
                      }
                    ).code?.text ||
                      (
                        r as unknown as {
                          code?: { coding?: Array<{ display?: string }> };
                        }
                      ).code?.coding?.[0]?.display ||
                      r.id}{' '}
                    — {r.status}
                  </li>
                ))}
              </ul>
            </Alert>
          </Box>
        )}

        {!checkingRefs && reportCheckFailed && (
          <Alert
            icon={<IconAlertTriangle size={18} />}
            title={t('pacs.management.delete.reportCheckFailed')}
            color="orange"
            variant="light"
          >
            <Text size="sm">
              {t('pacs.management.delete.reportCheckFailedDescription')}
            </Text>
          </Alert>
        )}

        {!checkingRefs && !isBlocked && !reportCheckFailed && (
          <>
            <EMRTextarea
              label={t('pacs.management.delete.reason')}
              placeholder={t('pacs.management.delete.reasonPlaceholder')}
              value={reason}
              onChange={setReason}
              minRows={2}
              maxRows={4}
              error={
                reason.length > 0 && reason.length < 10
                  ? t('pacs.management.reassign.reasonMinLength')
                  : undefined
              }
              data-testid="delete-reason"
            />

            <EMRTextInput
              label={t('pacs.management.delete.typeConfirm')}
              placeholder={t('pacs.management.delete.typeConfirmPlaceholder')}
              value={confirmText}
              onChange={setConfirmText}
              error={
                confirmText.length > 0 && confirmText !== 'DELETE'
                  ? t('pacs.management.delete.typeDeleteError')
                  : undefined
              }
              data-testid="delete-confirm-text"
            />
          </>
        )}
      </Stack>
    </EMRModal>
  );
}

// ============================================================================
// Main panel
// ============================================================================

export function StudyManagementPanel(): React.ReactElement {
  const { t, locale } = useTranslation();
  const fhir = useLiverraFhir();
  const hasPermission = useHasPermission('study.delete');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedStudy, setSelectedStudy] = useState<ImagingStudyLike | null>(
    null
  );
  const [searchError, setSearchError] = useState('');

  const [reassignOpen, setReassignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;

    setSearchLoading(true);
    setSearchError('');
    setSelectedStudy(null);

    try {
      // Accession first, then fall back to FHIR id.
      let study: ImagingStudyLike | null | undefined =
        await getByAccessionNumber(fhir, q);

      if (!study) {
        try {
          study = await getById(fhir, q);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            '[StudyManagementPanel] Study lookup by ID failed:',
            err
          );
        }
      }

      if (study) {
        setSelectedStudy(study);
      } else {
        setSearchError(t('pacs.management.noStudyFound'));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[StudyManagementPanel] Study search failed:', err);
      setSearchError(t('pacs.management.noStudyFound'));
    } finally {
      setSearchLoading(false);
    }
  }, [fhir, searchQuery, t]);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') void handleSearch();
    },
    [handleSearch]
  );

  const handleSuccess = useCallback(() => {
    setSelectedStudy(null);
    setSearchQuery('');
  }, []);

  if (!hasPermission) {
    return (
      <Box p="md" data-testid="study-management-panel">
        <Stack align="center" gap="sm" py="xl">
          <IconLock
            size={28}
            style={{ color: 'var(--emr-text-secondary)' }}
          />
          <Text
            fw={600}
            size="lg"
            style={{ color: 'var(--emr-text-primary)' }}
          >
            {t('pacs.management.accessDenied')}
          </Text>
          <Text
            size="sm"
            style={{ color: 'var(--emr-text-secondary)' }}
            maw={400}
            ta="center"
          >
            {t('pacs.management.accessDeniedMessage')}
          </Text>
        </Stack>
      </Box>
    );
  }

  return (
    <Box className={styles.panel} data-testid="study-management-panel">
      <Box className={styles.searchRow}>
        <EMRTextInput
          placeholder={t('pacs.management.searchStudyPlaceholder')}
          value={searchQuery}
          onChange={setSearchQuery}
          onKeyDown={handleSearchKeyDown}
          leftSection={<IconSearch size={16} />}
          data-testid="study-search-input"
        />
        <EMRButton
          onClick={handleSearch}
          loading={searchLoading}
          disabled={!searchQuery.trim() || searchLoading}
          size="sm"
          data-testid="study-search-btn"
        >
          {t('pacs.management.searchStudy')}
        </EMRButton>
      </Box>

      {searchError && (
        <Text size="sm" c="dimmed" mt="md" ta="center">
          {searchError}
        </Text>
      )}

      {selectedStudy && (
        <Box>
          <StudyInfoCard study={selectedStudy} t={t} locale={locale} />
          <Box className={styles.actions}>
            <EMRButton
              icon={IconArrowsExchange}
              onClick={() => setReassignOpen(true)}
              size="sm"
              data-testid="open-reassign-modal"
            >
              {t('pacs.management.reassign')}
            </EMRButton>
            <EMRButton
              icon={IconTrash}
              onClick={() => setDeleteOpen(true)}
              variant="danger"
              size="sm"
              data-testid="open-delete-modal"
            >
              {t('pacs.management.delete')}
            </EMRButton>
          </Box>

          <ReassignModal
            opened={reassignOpen}
            onClose={() => setReassignOpen(false)}
            study={selectedStudy}
            onSuccess={handleSuccess}
          />
          <DeleteModal
            opened={deleteOpen}
            onClose={() => setDeleteOpen(false)}
            study={selectedStudy}
            onSuccess={handleSuccess}
          />
        </Box>
      )}
    </Box>
  );
}

export default StudyManagementPanel;
