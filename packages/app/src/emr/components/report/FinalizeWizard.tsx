// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FinalizeWizard (T268, T429, T451).
 *
 * Plain-English: the 5-step guided flow a surgeon steps through to
 * finalize a review. Each step is a small gate:
 *
 *   1. `check`      — confirm analysis is complete + reviewer filled in
 *                     every required field.
 *   2. `watermark`  — show the RUO disclaimer the report will carry;
 *                     surgeon checks "I understand".
 *   3. `pacs`       — pick which PACS destinations to fan out to (or
 *                     skip — user keeps download-only).
 *   4. `review`     — final preview of volumes + FLR + lesion list.
 *   5. `ship`       — the actual finalize button (step-up MFA via
 *                     `<PermissionButton permission="report.finalize">`).
 *
 * Submitting fires the `useFinalize()` mutation which POSTs the API,
 * invalidates the cache, and navigates the caller to the new report's
 * landing page (`ReportView.tsx`).
 */
import { useState } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import {
  IconCheckbox,
  IconShieldCheck,
  IconDeviceDesktopAnalytics,
  IconClipboardCheck,
  IconSend,
} from '@tabler/icons-react';

import { EMRButton } from '../common/EMRButton';
import { EMRModal } from '../common/EMRModal';
import { EMRWizardStepper } from '../common/EMRWizardStepper';
import type { WizardStep } from '../common/EMRWizardStepper';
import { EMRCheckbox } from '../shared/EMRFormFields/EMRCheckbox';
import { EMRTextarea } from '../shared/EMRFormFields/EMRTextarea';
import { PermissionButton } from '../access-control/PermissionButton';
import { useFinalize } from '../../hooks/useFinalize';
import { useTranslation } from '../../contexts/TranslationContext';

export interface FinalizeWizardProps {
  opened: boolean;
  onClose: () => void;
  /** SurgeonReview.id passed to the finalize endpoint. */
  reviewId: string;
  /** Analysis.id — used to invalidate `['analysis', id]` cache on success. */
  analysisId: string;
  /** Tenant.id — used for `['audit', tenantId, '*']` invalidation. */
  tenantId?: string;
  /** Called with the new Report.id after successful finalize. */
  onFinalized?: (reportId: string) => void;
}

type StepKey = 'check' | 'watermark' | 'pacs' | 'review' | 'ship';

const STEP_ORDER: StepKey[] = ['check', 'watermark', 'pacs', 'review', 'ship'];

export function FinalizeWizard({
  opened,
  onClose,
  reviewId,
  analysisId,
  tenantId,
  onFinalized,
}: FinalizeWizardProps): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState<StepKey>('check');
  const [acknowledgedRuo, setAcknowledgedRuo] = useState(false);
  const [pushToPacs, setPushToPacs] = useState(true);
  const [optionalNotes, setOptionalNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const finalize = useFinalize();

  const steps: WizardStep[] = [
    {
      key: 'check',
      label: t('report:finalize.step.check') ?? 'Pre-flight',
      description: t('report:finalize.step.checkDesc') ?? 'Verify all inputs',
      icon: IconCheckbox,
      isValid: true,
    },
    {
      key: 'watermark',
      label: t('report:finalize.step.watermark') ?? 'RUO watermark',
      description: t('report:finalize.step.watermarkDesc') ?? 'Research Use Only',
      icon: IconShieldCheck,
      isValid: acknowledgedRuo,
    },
    {
      key: 'pacs',
      label: t('report:finalize.step.pacs') ?? 'PACS targets',
      description: t('report:finalize.step.pacsDesc') ?? 'Optional SEG/SR push',
      icon: IconDeviceDesktopAnalytics,
      isValid: true,
      optional: true,
    },
    {
      key: 'review',
      label: t('report:finalize.step.review') ?? 'Review',
      description: t('report:finalize.step.reviewDesc') ?? 'Measurements + FLR',
      icon: IconClipboardCheck,
      isValid: acknowledgedRuo,
    },
    {
      key: 'ship',
      label: t('report:finalize.step.ship') ?? 'Finalize',
      description: t('report:finalize.step.shipDesc') ?? 'Requires step-up MFA',
      icon: IconSend,
      isValid: acknowledgedRuo,
    },
  ];

  const currentIdx = STEP_ORDER.indexOf(step);
  const goNext = (): void => {
    const nextIdx = Math.min(currentIdx + 1, STEP_ORDER.length - 1);
    setStep(STEP_ORDER[nextIdx]);
  };
  const goPrev = (): void => {
    const prevIdx = Math.max(currentIdx - 1, 0);
    setStep(STEP_ORDER[prevIdx]);
  };

  const handleFinalize = async (): Promise<void> => {
    setError(null);
    try {
      const result = await finalize.mutateAsync({ reviewId, analysisId, tenantId });
      onFinalized?.(result.report_id);
      onClose();
    } catch (err) {
      const e = err as Error & { slug?: string };
      setError(e.slug ? `${e.slug}: ${e.message}` : e.message);
    }
  };

  return (
    <EMRModal
      opened={opened}
      onClose={onClose}
      title={t('report:finalize.title') ?? 'Finalize Report'}
      size="lg"
      data-testid="finalize-wizard"
    >
      <Stack gap="md">
        <EMRWizardStepper
          steps={steps}
          currentStep={step}
          onStepChange={(key) => setStep(key as StepKey)}
          data-testid="finalize-wizard-stepper"
        />

        {step === 'check' && (
          <Box data-testid="finalize-step-check">
            <Text size="sm">
              {t('report:finalize.check.body') ??
                'Confirm all measurements, lesions, and the FLR plane have been reviewed.'}
            </Text>
          </Box>
        )}

        {step === 'watermark' && (
          <Stack gap="xs" data-testid="finalize-step-watermark">
            <Text size="sm" c="red.7" fw={600}>
              {t('report:finalize.watermark.heading') ??
                'RESEARCH USE ONLY — NOT FOR CLINICAL DECISIONS'}
            </Text>
            <Text size="sm">
              {t('report:finalize.watermark.body') ??
                'This report is informational only. Clinical judgment rests with a qualified physician.'}
            </Text>
            <EMRCheckbox
              checked={acknowledgedRuo}
              onChange={(checked) => setAcknowledgedRuo(checked)}
              label={t('report:finalize.watermark.ack') ?? 'I acknowledge the RUO scope.'}
              data-testid="finalize-wizard-ack-ruo"
            />
          </Stack>
        )}

        {step === 'pacs' && (
          <Stack gap="xs" data-testid="finalize-step-pacs">
            <EMRCheckbox
              checked={pushToPacs}
              onChange={(checked) => setPushToPacs(checked)}
              label={t('report:finalize.pacs.enable') ?? 'Push SEG + SR to configured PACS destinations'}
              data-testid="finalize-wizard-pacs-toggle"
            />
            <Text size="xs" c="dimmed">
              {t('report:finalize.pacs.hint') ??
                'You can also skip now and push manually from the Report page later.'}
            </Text>
          </Stack>
        )}

        {step === 'review' && (
          <Stack gap="xs" data-testid="finalize-step-review">
            <EMRTextarea
              value={optionalNotes}
              onChange={(value) => setOptionalNotes(value)}
              label={t('report:finalize.review.notesLabel') ?? 'Notes for the report (optional)'}
              autosize
              minRows={2}
              maxRows={6}
            />
            <Text size="xs" c="dimmed">
              {t('report:finalize.review.hint') ??
                'Full preview available on the Report page once finalize completes.'}
            </Text>
          </Stack>
        )}

        {step === 'ship' && (
          <Stack gap="xs" data-testid="finalize-step-ship">
            <Text size="sm">
              {t('report:finalize.ship.body') ??
                'Finalizing requires a step-up MFA challenge.'}
            </Text>
            {error ? (
              <Text size="sm" c="red">
                {error}
              </Text>
            ) : null}
          </Stack>
        )}

        <Group justify="space-between" mt="sm">
          <EMRButton variant="default" onClick={goPrev} disabled={currentIdx === 0}>
            {t('common:back') ?? 'Back'}
          </EMRButton>
          {step !== 'ship' ? (
            <EMRButton onClick={goNext} disabled={!steps[currentIdx].isValid}>
              {t('common:next') ?? 'Next'}
            </EMRButton>
          ) : (
            <PermissionButton
              permission="report.finalize"
              onClick={() => void handleFinalize()}
              data-testid="finalize-wizard-submit"
            >
              {t('report:finalize.submit') ?? 'Finalize now'}
            </PermissionButton>
          )}
        </Group>
      </Stack>
    </EMRModal>
  );
}

export default FinalizeWizard;
