// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// CriticalAlertModal — Form for radiologists to report critical findings
// ============================================================================
// When a radiologist spots a life-threatening finding (e.g., hepatic arterial
// bleed), they open this modal to flag it. It creates a FHIR Communication
// alert that notifies the referring clinician and starts an escalation timer.
//
// Uses EMRModal + EMR form fields, following existing PACS component patterns.
//
// Ported from MediMind (components/pacs/CriticalAlertModal.tsx) with:
//   - Translation keys in the `pacs.criticalAlert.*` namespace (already in use).
// ============================================================================

import { memo, useState, useCallback, useMemo } from 'react';
import { Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { EMRModal } from '../common/EMRModal';
import { EMRRadioGroup, EMRTextarea, EMRSelect } from '../shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';
import type { AlertSeverity, CreateCriticalAlertParams } from '../../services/pacs/criticalAlertService';

// ============================================================================
// Types
// ============================================================================

export interface CriticalAlertModalProps {
  /** Whether the modal is open */
  opened: boolean;
  /** Close the modal */
  onClose: () => void;
  /** Function to create a critical alert (from useCriticalAlerts hook) */
  onCreateAlert: (params: CreateCriticalAlertParams) => Promise<unknown>;
  /** DiagnosticReport ID of the current study's report */
  reportId: string;
  /** Patient ID for the current study */
  patientId: string;
  /** Pre-populated referring clinician ID (from the study's order) */
  defaultRecipientId?: string;
  /** Available recipients (referring clinicians) */
  recipients: Array<{ value: string; label: string }>;
}

// ============================================================================
// Constants
// ============================================================================

const MIN_FINDING_LENGTH = 10;

// ============================================================================
// Component
// ============================================================================

export const CriticalAlertModal = memo(function CriticalAlertModal({
  opened,
  onClose,
  onCreateAlert,
  reportId,
  patientId,
  defaultRecipientId,
  recipients,
}: CriticalAlertModalProps) {
  const { t } = useTranslation();

  // ── Form state ──
  const [severity, setSeverity] = useState<AlertSeverity>('critical');
  const [finding, setFinding] = useState('');
  const [recipientId, setRecipientId] = useState<string | null>(defaultRecipientId ?? null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ── Severity options ──
  const severityOptions = useMemo(() => [
    {
      value: 'critical',
      label: t('pacs.criticalAlert.severity.critical'),
    },
    {
      value: 'urgent',
      label: t('pacs.criticalAlert.severity.urgent'),
    },
  ], [t]);

  // ── Reset form ──
  const resetForm = useCallback(() => {
    setSeverity('critical');
    setFinding('');
    setRecipientId(defaultRecipientId ?? null);
    setErrors({});
  }, [defaultRecipientId]);

  // ── Validation ──
  const validate = useCallback((): boolean => {
    const newErrors: Record<string, string> = {};

    if (!severity) {
      newErrors.severity = t('pacs.criticalAlert.validationRequired');
    }
    if (!finding.trim()) {
      newErrors.finding = t('pacs.criticalAlert.validationRequired');
    } else if (finding.trim().length < MIN_FINDING_LENGTH) {
      newErrors.finding = t('pacs.criticalAlert.findingMinLength');
    }
    if (!recipientId) {
      newErrors.recipient = t('pacs.criticalAlert.validationRequired');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [severity, finding, recipientId, t]);

  // ── Submit ──
  const handleSubmit = useCallback(async () => {
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      await onCreateAlert({
        severity,
        finding: finding.trim(),
        recipientId: recipientId as string,
        reportId,
        patientId,
      });

      notifications.show({
        title: t('pacs.criticalAlert.title'),
        message: t('pacs.criticalAlert.success'),
        color: 'green',
      });

      // Reset form and close
      resetForm();
      onClose();
    } catch {
      setErrors({ submit: t('pacs.criticalAlert.error') });
    } finally {
      setIsSubmitting(false);
    }
  }, [validate, severity, finding, recipientId, reportId, patientId, onCreateAlert, onClose, resetForm, t]);

  // ── Close handler (reset form on close) ──
  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  return (
    <EMRModal
      opened={opened}
      onClose={handleClose}
      title={t('pacs.criticalAlert.title')}
      subtitle={t('pacs.criticalAlert.subtitle')}
      icon={IconAlertTriangle}
      size="sm"
      cancelLabel={t('pacs.criticalAlert.cancel')}
      submitLabel={t('pacs.criticalAlert.submit')}
      onSubmit={handleSubmit}
      submitLoading={isSubmitting}
      testId="critical-alert-report-modal"
    >
      <Stack gap="md">
        {/* Severity radio group */}
        <EMRRadioGroup
          label={t('pacs.criticalAlert.severity')}
          options={severityOptions}
          value={severity}
          onChange={(val) => {
            setSeverity(val as AlertSeverity);
            setErrors((prev) => ({ ...prev, severity: '' }));
          }}
          orientation="horizontal"
          required
          error={errors.severity}
          data-testid="critical-alert-severity"
        />

        {/* Finding description */}
        <EMRTextarea
          label={t('pacs.criticalAlert.finding')}
          placeholder={t('pacs.criticalAlert.findingPlaceholder')}
          value={finding}
          onChange={(val) => {
            setFinding(val);
            if (val.trim().length >= MIN_FINDING_LENGTH) {
              setErrors((prev) => ({ ...prev, finding: '' }));
            }
          }}
          rows={4}
          required
          error={errors.finding}
          data-testid="critical-alert-finding"
        />

        {/* Recipient selection */}
        <EMRSelect
          label={t('pacs.criticalAlert.recipient')}
          placeholder={t('pacs.criticalAlert.recipientPlaceholder')}
          data={recipients}
          value={recipientId}
          onChange={(val) => {
            setRecipientId(val);
            setErrors((prev) => ({ ...prev, recipient: '' }));
          }}
          required
          searchable
          error={errors.recipient}
          data-testid="critical-alert-recipient"
        />

        {/* Submit error */}
        {errors.submit && (
          <Text size="sm" c="var(--emr-error)" data-testid="critical-alert-submit-error">
            {errors.submit}
          </Text>
        )}
      </Stack>
    </EMRModal>
  );
});
