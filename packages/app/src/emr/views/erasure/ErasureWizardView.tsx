// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ErasureWizardView (T330, US9).
 *
 * Plain-English:
 *   5-step wizard the DPO walks through to execute a GDPR Art. 17
 *   erasure. Steps:
 *     1. Select — pick the study to erase.
 *     2. Justify — record the Art. 17 grounds (1000-char max).
 *     3. MFA — step-up re-authentication (delegated to the global
 *        step-up modal via 401 → StepUp).
 *     4. Review — show an unmissable warning + summary.
 *     5. Confirm — call the API; on success swap in `ErasureConfirmation`.
 *
 *   The final "Confirm & Execute" button is the irreversible click.
 *   We put it behind a red filled button AND a "type ERASE" confirmation
 *   input so an accidental tap can't delete a patient's case.
 */

import {
  Alert,
  Badge,
  Group,
  Stack,
  Stepper,
  Text,
} from '@mantine/core';
import { IconAlertTriangle, IconShieldLock } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import {
  EMRButton,
  EMRCard,
  EMRErrorBoundary,
  EMRPageHeader,
} from '../../components/common';
import { EMRTextInput, EMRTextarea } from '../../components/shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';
import { ErasureConfirmation } from '../../components/erasure/ErasureConfirmation';

const CONFIRMATION_PHRASE = 'ERASE';

function readApiBaseUrl(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

interface SubmitPayload {
  target_study_id: string;
  justification: string;
}

interface SubmitResult {
  erasure_request_id: string;
  tombstone_hash_hex?: string | null;
  confirmation_pdf_url?: string | null;
}

async function submitErasure(body: SubmitPayload): Promise<SubmitResult> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/erasure/requests`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    // Step-up required — the global interceptor should have popped
    // the StepUp modal already. Surface a typed error so the wizard
    // re-enables the button after re-auth.
    throw new Error('step-up-required');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as SubmitResult;
}

async function pollStatus(
  erasureId: string,
  deadlineSecs: number,
): Promise<SubmitResult> {
  const baseUrl = readApiBaseUrl();
  const started = Date.now();
  while (Date.now() - started < deadlineSecs * 1000) {
    const res = await fetch(`${baseUrl}/erasure/requests/${erasureId}`, {
      credentials: 'include',
    });
    if (res.ok) {
      const body = (await res.json()) as SubmitResult & { status?: string };
      if (body.status === 'completed') {
        return {
          erasure_request_id: erasureId,
          tombstone_hash_hex: body.tombstone_hash_hex ?? null,
          confirmation_pdf_url: body.confirmation_pdf_url ?? null,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('timeout');
}

function ErasureWizardInner(): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [studyId, setStudyId] = useState('');
  const [justification, setJustification] = useState('');
  const [confirmInput, setConfirmInput] = useState('');
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | undefined>(undefined);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submitMutation = useMutation({
    mutationFn: async (payload: SubmitPayload) => {
      const t0 = performance.now();
      const created = await submitErasure(payload);
      // Poll until completed — up to 90s (30s buffer over SC-016 SLA).
      const completed = await pollStatus(created.erasure_request_id, 90);
      setElapsedSeconds((performance.now() - t0) / 1000);
      return completed;
    },
    onSuccess: (res) => {
      setResult(res);
      setStep(5); // jump to confirmation pane
    },
    onError: (err: Error) => {
      setSubmitError(err.message);
    },
  });

  const canNext =
    (step === 0 && studyId.trim().length >= 8) ||
    (step === 1 && justification.trim().length >= 10) ||
    step === 2 || // MFA: nothing to validate here; enforced server-side
    (step === 3 && confirmInput === CONFIRMATION_PHRASE);

  const handleNext = () => {
    if (step < 3) {
      setStep((s) => s + 1);
      return;
    }
    if (step === 3 && confirmInput === CONFIRMATION_PHRASE) {
      setSubmitError(null);
      submitMutation.mutate({
        target_study_id: studyId.trim(),
        justification: justification.trim(),
      });
      setStep(4); // executing
    }
  };

  // Surface confirmation pane once we have a result.
  useEffect(() => {
    if (result) setStep(5);
  }, [result]);

  if (result) {
    return (
      <ErasureConfirmation
        erasureRequestId={result.erasure_request_id}
        tombstoneHashHex={result.tombstone_hash_hex ?? '—'}
        confirmationPdfUrl={result.confirmation_pdf_url ?? null}
        elapsedSeconds={elapsedSeconds}
      />
    );
  }

  return (
    <Stack gap="md" p="md" data-testid="erasure-wizard">
      <EMRPageHeader
        icon={IconShieldLock}
        title={t('erasure:wizard.title')}
      />

      <Alert color="red" icon={<IconAlertTriangle size={18} />} variant="light">
        {t('erasure:wizard.irreversible_warning')}
      </Alert>

      <EMRCard>
      <Stepper active={step} onStepClick={(i) => (i < step ? setStep(i) : undefined)}>
        <Stepper.Step
          label={t('erasure:wizard.step.select_label')}
          description={t('erasure:wizard.step.select_desc')}
        >
          <Stack gap="sm">
            <EMRTextInput
              label={t('erasure:wizard.study_id_label')}
              description={t('erasure:wizard.study_id_help')}
              placeholder="22222222-2222-4222-8222-222222222222"
              value={studyId}
              onChange={(value) => setStudyId(value)}
              required
              data-testid="erasure-wizard-study-id"
            />
          </Stack>
        </Stepper.Step>

        <Stepper.Step
          label={t('erasure:wizard.step.justify_label')}
          description={t('erasure:wizard.step.justify_desc')}
        >
          <Stack gap="sm">
            <EMRTextarea
              label={t('erasure:wizard.justification_label')}
              helpText={t('erasure:wizard.justification_help')}
              placeholder={t('erasure:wizard.justification_placeholder')}
              rows={4}
              required
              value={justification}
              onChange={(value) => setJustification(value)}
              data-testid="erasure-wizard-justification"
            />
            <Badge size="sm" variant="light" color="gray">
              {justification.trim().length} / 2000
            </Badge>
          </Stack>
        </Stepper.Step>

        <Stepper.Step
          label={t('erasure:wizard.step.mfa_label')}
          description={t('erasure:wizard.step.mfa_desc')}
        >
          <Stack gap="sm">
            <Alert color="blue" variant="light">
              {t('erasure:wizard.mfa_body')}
            </Alert>
            <Text c="dimmed" fz="sm">
              {t('erasure:wizard.mfa_help')}
            </Text>
          </Stack>
        </Stepper.Step>

        <Stepper.Step
          label={t('erasure:wizard.step.review_label')}
          description={t('erasure:wizard.step.review_desc')}
        >
          <Stack gap="sm">
            <Text>
              {t('erasure:wizard.review_study_id')} <code>{studyId}</code>
            </Text>
            <Text style={{ whiteSpace: 'pre-wrap' }}>
              {t('erasure:wizard.review_justification')}
              {'\n'}
              {justification}
            </Text>
            <Alert color="red" icon={<IconAlertTriangle size={18} />} variant="light">
              {t('erasure:wizard.review_irreversible')}
            </Alert>
            <EMRTextInput
              label={t('erasure:wizard.confirm_phrase_label')}
              description={t('erasure:wizard.confirm_phrase_help', {
                phrase: CONFIRMATION_PHRASE,
              })}
              value={confirmInput}
              onChange={(value) => setConfirmInput(value)}
              required
              data-testid="erasure-wizard-confirm-input"
            />
          </Stack>
        </Stepper.Step>

        <Stepper.Step
          label={t('erasure:wizard.step.execute_label')}
          description={t('erasure:wizard.step.execute_desc')}
          loading={submitMutation.isPending}
        >
          <Stack gap="sm">
            {submitError ? (
              <Alert color="red" title={t('erasure:wizard.error_title')}>
                {submitError === 'step-up-required'
                  ? t('erasure:wizard.step_up_required')
                  : submitError === 'timeout'
                    ? t('erasure:wizard.timeout_body')
                    : submitError}
              </Alert>
            ) : (
              <Text c="dimmed">{t('erasure:wizard.executing_body')}</Text>
            )}
          </Stack>
        </Stepper.Step>
      </Stepper>
      </EMRCard>

      <Group justify="flex-end" wrap="wrap" gap="sm">
        {step > 0 && step < 4 ? (
          <EMRButton variant="subtle" onClick={() => setStep((s) => Math.max(0, s - 1))}>
            {t('common:back')}
          </EMRButton>
        ) : null}
        {step < 4 ? (
          <EMRButton
            variant={step === 3 ? 'danger' : 'primary'}
            disabled={!canNext || submitMutation.isPending}
            loading={submitMutation.isPending && step === 3}
            onClick={handleNext}
            data-testid={
              step === 3 ? 'erasure-wizard-execute-btn' : 'erasure-wizard-next-btn'
            }
          >
            {step === 3
              ? t('erasure:wizard.execute_cta')
              : t('erasure:wizard.next_cta')}
          </EMRButton>
        ) : null}
      </Group>
    </Stack>
  );
}

export default function ErasureWizardView(): JSX.Element {
  return (
    <EMRErrorBoundary componentName="ErasureWizardView">
      <ErasureWizardInner />
    </EMRErrorBoundary>
  );
}
