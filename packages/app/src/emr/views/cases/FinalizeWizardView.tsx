// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FinalizeWizardView — route view for `/cases/:id/finalize`.
 *
 * Plain-English: walks the surgeon through five gated steps — attest,
 * watermark preview, PACS choice, review summary, ship — before flipping
 * the analysis into a finalized Report (PDF + DICOM-SEG + DICOM-SR).
 * The final "Finalize" action runs through a `PermissionButton` with
 * step-up MFA (`report.finalize`); on success we swap the wizard for a
 * success card that polls PACS delivery status.
 *
 * Why this file owns the step state rather than re-using
 * `components/report/FinalizeWizard.tsx`:
 *   - The route view composes a full-page shell (header, back link,
 *     seat banner, analysis-status gate). The component version lives
 *     inside an EMRModal and has a different information density. Each
 *     surface needs its own orchestration; keeping the state here
 *     avoids coupling the two.
 *
 * Outer `<Guarded>` already checks `report.finalize`; this view still
 * wraps the submit control in `PermissionButton` so the tooltip /
 * disabled-when-denied UX is consistent with the other write actions.
 */

import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Group, Paper, Radio, Stack, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconClipboardCheck,
  IconFileText,
  IconLock,
  IconRadar,
  IconSend,
} from '@tabler/icons-react';

import {
  EMRAlert,
  EMRButton,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRWizardStepper,
} from '../../components/common';
import type { WizardStep } from '../../components/common/EMRWizardStepper';
import { PermissionButton, RecordLockBanner } from '../../components/access-control';
import { PACSPushPanel } from '../../components/report/PACSPushPanel';
import { EMRCheckbox } from '../../components/shared/EMRFormFields/EMRCheckbox';
import { EMRTextarea } from '../../components/shared/EMRFormFields/EMRTextarea';

import { useAnalysis } from '../../hooks/useAnalysis';
import { useReviewSeat } from '../../hooks/useReviewSeat';
import { useFinalize, type FinalizeResponse } from '../../hooks/useFinalize';
import { useAuth } from '../../services/auth';
import { useTranslation } from '../../contexts/TranslationContext';
import { LIVERRA_ROUTES, buildPath } from '../../constants/routes';

// ---------------------------------------------------------------------------
// Step keys (ordered)
// ---------------------------------------------------------------------------

type StepKey = 'attest' | 'watermark' | 'pacs' | 'review' | 'ship';

const STEP_ORDER: readonly StepKey[] = ['attest', 'watermark', 'pacs', 'review', 'ship'];

type PacsChoice = 'push' | 'skip';

// ---------------------------------------------------------------------------
// Internal: summary row helper
// ---------------------------------------------------------------------------

function SummaryRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <Group
      justify="space-between"
      wrap="wrap"
      style={{
        padding: '8px 0',
        borderBottom: '1px solid var(--emr-border-color)',
      }}
    >
      <Text size="sm" c="var(--emr-text-secondary)">
        {label}
      </Text>
      <Text size="sm" fw={600} c="var(--emr-text-primary)" style={{ minWidth: 0 }}>
        {value}
      </Text>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Inner view (wrapped in an EMRErrorBoundary below)
// ---------------------------------------------------------------------------

function FinalizeWizardViewInner(): ReactElement {
  const { id: analysisIdParam } = useParams<{ id: string }>();
  const analysisId = analysisIdParam ?? '';
  const navigate = useNavigate();
  const { t } = useTranslation();

  // ---- Data -------------------------------------------------------------
  const { analysis, isLoading: analysisLoading } = useAnalysis(analysisId);
  const seat = useReviewSeat(analysisId);
  const { tenant } = useAuth();
  const finalize = useFinalize();

  // ---- Wizard state ----------------------------------------------------
  const [step, setStep] = useState<StepKey>('attest');
  const [reviewedConfirmed, setReviewedConfirmed] = useState(false);
  const [ruoAcknowledged, setRuoAcknowledged] = useState(false);
  const [pacsChoice, setPacsChoice] = useState<PacsChoice>('push');
  const [notes, setNotes] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ slug?: string; message: string } | null>(null);
  const [finalized, setFinalized] = useState<FinalizeResponse | null>(null);

  // ---- Derived ---------------------------------------------------------
  const analysisStatus = analysis?.status;
  const analysisReady = analysisStatus === 'completed';
  const seatLost = !seat.hasSeat && seat.status !== 'idle' && seat.status !== 'acquiring';

  const canAdvanceByStep = useMemo<Record<StepKey, boolean>>(
    () => ({
      attest: reviewedConfirmed && ruoAcknowledged,
      watermark: true,
      pacs: Boolean(pacsChoice),
      review: true,
      // ship has no "next" — the final control is PermissionButton.
      ship: false,
    }),
    [reviewedConfirmed, ruoAcknowledged, pacsChoice],
  );

  const steps: WizardStep[] = useMemo(
    () => [
      {
        key: 'attest',
        label: t('report:finalize.step.check'),
        description: t('report:finalize.step.checkDesc'),
        icon: IconClipboardCheck,
        isValid: canAdvanceByStep.attest,
      },
      {
        key: 'watermark',
        label: t('report:finalize.step.watermark'),
        description: t('report:finalize.step.watermarkDesc'),
        icon: IconFileText,
        isValid: true,
      },
      {
        key: 'pacs',
        label: t('report:finalize.step.pacs'),
        description: t('report:finalize.step.pacsDesc'),
        icon: IconRadar,
        isValid: true,
        optional: true,
      },
      {
        key: 'review',
        label: t('report:finalize.step.review'),
        description: t('report:finalize.step.reviewDesc'),
        icon: IconCheck,
        isValid: true,
      },
      {
        key: 'ship',
        label: t('report:finalize.step.ship'),
        description: t('report:finalize.step.shipDesc'),
        icon: IconSend,
        isValid: false,
      },
    ],
    [t, canAdvanceByStep.attest],
  );

  const currentIdx = STEP_ORDER.indexOf(step);

  // ---- Navigation ------------------------------------------------------
  const goBackToCase = useCallback(() => {
    navigate(buildPath(LIVERRA_ROUTES.CASE_DETAIL, { id: analysisId }));
  }, [navigate, analysisId]);

  const goNext = useCallback(() => {
    if (currentIdx < STEP_ORDER.length - 1) {
      setStep(STEP_ORDER[currentIdx + 1]);
    }
  }, [currentIdx]);

  const goPrev = useCallback(() => {
    if (currentIdx > 0) {
      setStep(STEP_ORDER[currentIdx - 1]);
    }
  }, [currentIdx]);

  const onStepperChange = useCallback(
    (key: string) => {
      const idx = STEP_ORDER.indexOf(key as StepKey);
      if (idx === -1) return;
      // Only allow jumping to a step if every prior step's gate is satisfied.
      for (let i = 0; i < idx; i += 1) {
        if (!canAdvanceByStep[STEP_ORDER[i]]) return;
      }
      setStep(STEP_ORDER[idx]);
    },
    [canAdvanceByStep],
  );

  // ---- Submit ----------------------------------------------------------
  const handleSubmit = useCallback(async () => {
    if (!seat.reviewId) {
      setSubmitError({
        slug: 'no_review_seat',
        message: t('errors:finalize.no_review_seat'),
      });
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await finalize.mutateAsync({
        reviewId: seat.reviewId,
        analysisId,
        tenantId: tenant?.id,
      });
      setFinalized(res);
    } catch (err) {
      const e = err as Error & { slug?: string };
      const slug = e.slug ?? 'generic';
      const translated = t(`errors:finalize.${slug}`);
      // If the translation key is missing, `t()` returns the key itself —
      // fall back to the raw error message for user-visible copy.
      const message =
        translated && !translated.startsWith('errors:finalize.')
          ? translated
          : e.message || t('errors:finalize.generic');
      setSubmitError({ slug, message });
    } finally {
      setSubmitting(false);
    }
  }, [seat.reviewId, finalize, analysisId, tenant?.id, t]);

  // ---------------------------------------------------------------------
  // Render: success screen (post-finalize) takes precedence over the wizard
  // ---------------------------------------------------------------------
  if (finalized) {
    return (
      <Stack gap="lg" p="lg" data-testid="finalize-success-screen">
        <Paper
          p="xl"
          radius="lg"
          style={{
            maxWidth: 720,
            margin: '0 auto',
            textAlign: 'center',
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-border-color)',
            boxShadow: 'var(--emr-shadow-lg)',
          }}
        >
          <Stack gap="md" align="center">
            <Box
              style={{
                width: 72,
                height: 72,
                borderRadius: '50%',
                background: 'var(--emr-success-alpha-10)',
                color: 'var(--emr-success)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconCheck size={40} stroke={2.2} />
            </Box>
            <Text
              size="xl"
              fw={700}
              c="var(--emr-text-primary)"
              data-testid="finalize-success-title"
            >
              {t('report:finalize.success.title')}
            </Text>
            <Text size="sm" c="var(--emr-text-secondary)">
              {t('report:finalize.success.subtitle')}
            </Text>
            <Box
              data-testid="finalize-success-report-id"
              style={{
                padding: '8px 14px',
                background: 'var(--emr-bg-hover, var(--emr-gray-alpha-04))',
                borderRadius: 'var(--emr-border-radius)',
                fontFamily: 'monospace',
                fontSize: 'var(--emr-font-sm)',
                color: 'var(--emr-text-primary)',
              }}
            >
              {t('report:finalize.success.reportIdLabel')}: {finalized.report_id}
            </Box>
            <EMRButton
              variant="primary"
              onClick={() =>
                navigate(buildPath(LIVERRA_ROUTES.REPORT_VIEW, { id: finalized.report_id }))
              }
              data-testid="finalize-success-view-report"
            >
              {t('report:finalize.success.viewReport')}
            </EMRButton>
          </Stack>
        </Paper>

        {pacsChoice === 'push' && (
          <Paper
            p="lg"
            radius="lg"
            style={{
              maxWidth: 960,
              margin: '0 auto',
              width: '100%',
              background: 'var(--emr-bg-card)',
              border: '1px solid var(--emr-border-color)',
            }}
            data-testid="finalize-success-pacs-panel-wrapper"
          >
            <PACSPushPanel reportId={finalized.report_id} />
          </Paper>
        )}
      </Stack>
    );
  }

  // ---------------------------------------------------------------------
  // Render: analysis status gate (cannot finalize unless completed)
  // ---------------------------------------------------------------------
  if (!analysisLoading && analysis && !analysisReady) {
    return (
      <Stack gap="lg" p="lg" data-testid="finalize-status-blocked">
        <EMRPageHeader
          icon={IconFileText}
          title={t('report:finalize.title')}
          showBack
          onBack={goBackToCase}
        />
        <EMRAlert
          variant="warning"
          title={t('report:finalize.check.notReadyTitle')}
          data-testid="finalize-status-alert"
        >
          <Stack gap="sm">
            <Text size="sm">
              {t('report:finalize.check.notReady', {
                status: analysisStatus ?? 'unknown',
              })}
            </Text>
            <Box>
              <EMRButton
                variant="secondary"
                icon={IconArrowLeft}
                onClick={goBackToCase}
                data-testid="finalize-back-to-case"
              >
                {t('report:finalize.backToCase')}
              </EMRButton>
            </Box>
          </Stack>
        </EMRAlert>
      </Stack>
    );
  }

  // ---------------------------------------------------------------------
  // Render: wizard
  // ---------------------------------------------------------------------
  const nextDisabled = !canAdvanceByStep[step] || seatLost;

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' }} data-testid="finalize-wizard-view">
      <EMRPageHeader
        icon={IconFileText}
        title={t('report:finalize.title')}
        subtitle={t('report:finalize.subtitle')}
        showBack
        onBack={goBackToCase}
      />

      {/* Seat-lost banner sits above the stepper so the user always sees it. */}
      {seatLost && (
        <RecordLockBanner
          status={{ isLocked: true, timeRemainingMs: 0, canOverride: false }}
        />
      )}

      <Paper
        p={{ base: 'sm', md: 'md' }}
        radius="lg"
        style={{
          background: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-border-color)',
          boxShadow: 'var(--emr-shadow-card)',
        }}
      >
        <EMRWizardStepper
          steps={steps}
          currentStep={step}
          onStepChange={onStepperChange}
          data-testid="finalize-wizard-stepper"
        />
      </Paper>

      <Paper
        p={{ base: 'md', md: 'lg' }}
        radius="lg"
        style={{
          background: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-border-color)',
          boxShadow: 'var(--emr-shadow-card)',
        }}
        data-testid={`finalize-step-${step}`}
      >
        {step === 'attest' && (
          <Stack gap="md">
            <Text size="lg" fw={600} c="var(--emr-text-primary)">
              {t('report:finalize.step.check')}
            </Text>
            <Text size="sm" c="var(--emr-text-secondary)">
              {t('report:finalize.check.body')}
            </Text>
            <Stack gap="sm">
              <EMRCheckbox
                checked={reviewedConfirmed}
                onChange={(checked) => setReviewedConfirmed(checked)}
                label={t('report:finalize.check.reviewedConfirm')}
                data-testid="finalize-attest-reviewed"
              />
              <EMRCheckbox
                checked={ruoAcknowledged}
                onChange={(checked) => setRuoAcknowledged(checked)}
                label={t('report:finalize.watermark.ack')}
                data-testid="finalize-attest-ruo"
              />
            </Stack>
          </Stack>
        )}

        {step === 'watermark' && (
          <Stack gap="md">
            <Text size="lg" fw={600} c="var(--emr-text-primary)">
              {t('report:finalize.step.watermark')}
            </Text>
            <Box
              data-testid="finalize-watermark-preview"
              style={{
                position: 'relative',
                padding: '32px 24px',
                borderRadius: 'var(--emr-border-radius-lg)',
                background:
                  'linear-gradient(135deg, var(--emr-warning-alpha-10) 0%, var(--emr-warning-alpha-20) 100%)',
                border: '2px dashed var(--emr-warning)',
                color: 'var(--emr-text-primary)',
                textAlign: 'center',
                overflow: 'hidden',
              }}
            >
              <Box
                aria-hidden
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                  opacity: 0.08,
                  backgroundImage:
                    'repeating-linear-gradient(-18deg, transparent 0 40px, var(--emr-warning) 40px 42px)',
                }}
              />
              <Stack gap="xs" style={{ position: 'relative', zIndex: 1 }}>
                <Text size="sm" fw={700} c="var(--emr-warning)">
                  {t('report:finalize.watermark.heading')}
                </Text>
                <Text size="sm" c="var(--emr-text-secondary)">
                  {t('report:finalize.watermark.body')}
                </Text>
              </Stack>
            </Box>
          </Stack>
        )}

        {step === 'pacs' && (
          <Stack gap="md">
            <Text size="lg" fw={600} c="var(--emr-text-primary)">
              {t('report:finalize.step.pacs')}
            </Text>
            <Radio.Group
              value={pacsChoice}
              onChange={(value) => setPacsChoice(value as PacsChoice)}
              data-testid="finalize-pacs-choice"
            >
              <Stack gap="sm">
                <Radio
                  value="push"
                  label={t('report:finalize.pacs.enable')}
                  data-testid="finalize-pacs-push-option"
                />
                <Radio
                  value="skip"
                  label={t('report:finalize.pacs.skip')}
                  data-testid="finalize-pacs-skip-option"
                />
              </Stack>
            </Radio.Group>
            <Text size="xs" c="var(--emr-text-secondary)">
              {t('report:finalize.pacs.hint')}
            </Text>
          </Stack>
        )}

        {step === 'review' && (
          <Stack gap="md">
            <Text size="lg" fw={600} c="var(--emr-text-primary)">
              {t('report:finalize.step.review')}
            </Text>
            <Paper
              p="md"
              radius="md"
              style={{
                background: 'var(--emr-bg-hover, var(--emr-gray-alpha-04))',
                border: '1px solid var(--emr-border-color)',
              }}
              data-testid="finalize-review-summary"
            >
              <Stack gap={0}>
                <SummaryRow
                  label={t('report:finalize.review.summary.analysisId')}
                  value={analysisId}
                />
                <SummaryRow
                  label={t('report:finalize.review.summary.status')}
                  value={analysisStatus ?? '—'}
                />
                <SummaryRow
                  label={t('report:finalize.review.summary.pacsPlan')}
                  value={
                    pacsChoice === 'push'
                      ? t('report:finalize.pacs.enable')
                      : t('report:finalize.pacs.skip')
                  }
                />
              </Stack>
            </Paper>
            <EMRTextarea
              value={notes}
              onChange={(value) => setNotes(value)}
              label={t('report:finalize.review.notesLabel')}
              autosize
              minRows={3}
              maxRows={8}
              data-testid="finalize-review-notes"
            />
            <Text size="xs" c="var(--emr-text-secondary)">
              {t('report:finalize.review.hint')}
            </Text>
          </Stack>
        )}

        {step === 'ship' && (
          <Stack gap="md">
            <Text size="lg" fw={600} c="var(--emr-text-primary)">
              {t('report:finalize.step.ship')}
            </Text>
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <IconLock size={18} color="var(--emr-secondary)" style={{ flexShrink: 0 }} />
              <Text size="sm" c="var(--emr-text-secondary)">
                {t('report:finalize.ship.body')}
              </Text>
            </Group>
            {submitError && (
              <EMRAlert
                variant="error"
                title={t('report:finalize.error.title')}
                icon={IconAlertTriangle}
                data-testid="finalize-error-alert"
              >
                {submitError.message}
              </EMRAlert>
            )}
          </Stack>
        )}
      </Paper>

      <Group justify="space-between" wrap="wrap" gap="sm">
        <EMRButton
          variant="secondary"
          icon={IconArrowLeft}
          onClick={goPrev}
          disabled={currentIdx === 0 || submitting}
          data-testid="finalize-back-button"
        >
          {t('common:back')}
        </EMRButton>

        {step !== 'ship' ? (
          <EMRButton
            variant="primary"
            icon={IconArrowRight}
            iconPosition="right"
            onClick={goNext}
            disabled={nextDisabled}
            data-testid="finalize-next-button"
          >
            {t('common:next')}
          </EMRButton>
        ) : seatLost || submitting ? (
          <EMRButton
            variant="primary"
            icon={IconSend}
            disabled
            loading={submitting}
            data-testid="finalize-submit-button"
          >
            {t('report:finalize.submit')}
          </EMRButton>
        ) : (
          <PermissionButton
            permission="report.finalize"
            variant="primary"
            icon={IconSend}
            onClick={() => void handleSubmit()}
            loading={submitting}
            data-testid="finalize-submit-button"
          >
            {t('report:finalize.submit')}
          </PermissionButton>
        )}
      </Group>
    </Stack>
  );
}

/**
 * Route-level export. Wraps the inner view in an error boundary so a
 * crash inside the stepper doesn't black-screen the whole app.
 */
export default function FinalizeWizardView(): ReactElement {
  const { t } = useTranslation();
  return (
    <EMRErrorBoundary
      componentName="FinalizeWizardView"
      errorTitle={t('common:somethingWentWrong')}
    >
      <FinalizeWizardViewInner />
    </EMRErrorBoundary>
  );
}
