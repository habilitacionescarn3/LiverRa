// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * OnboardingWizard (T299, T308).
 *
 * Plain-English: the 5-step mandatory first-login wizard. The user
 * progresses through password → MFA → RUO → tour → sample case in a
 * linear flow. Each step is its own component (telemetry + API calls
 * are owned by those components). This container just stitches them
 * together and navigates on completion.
 */
import { Suspense, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Stack, Text } from '@mantine/core';
import {
  EMRButton,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableSkeleton,
} from '../../components/common';
import { IconShieldLock } from '@tabler/icons-react';
import PasswordStep from '../../components/onboarding/PasswordStep';
import MFAEnrolStep from '../../components/onboarding/MFAEnrolStep';
import RUOAcceptStep from '../../components/onboarding/RUOAcceptStep';
import GuidedTourStep from '../../components/onboarding/GuidedTourStep';
import SampleCaseStep from '../../components/onboarding/SampleCaseStep';
import { useTranslation } from '../../contexts/TranslationContext';
import { trackOnboardingStep } from '../../components/onboarding/telemetry';

const STEPS = ['password', 'mfa', 'ruo', 'tour', 'sample_case'] as const;
type StepName = (typeof STEPS)[number];

function StepIndicator({
  step,
  total,
  labels,
}: {
  step: number;
  total: number;
  labels: string[];
}): React.ReactElement {
  return (
    <Box style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {Array.from({ length: total }, (_, i) => {
        const active = i === step;
        const done = i < step;
        return (
          <Box
            key={labels[i]}
            style={{
              flex: 1,
              minWidth: 80,
              padding: '8px 10px',
              borderRadius: 'var(--emr-border-radius)',
              background: done
                ? 'var(--emr-success)'
                : active
                  ? 'var(--emr-primary)'
                  : 'var(--emr-gray-100)',
              color:
                done || active
                  ? 'var(--emr-text-inverse)'
                  : 'var(--emr-text-secondary)',
              fontSize: 'var(--emr-font-xs)',
              fontWeight: 600,
              textAlign: 'center',
              whiteSpace: 'nowrap',
            }}
          >
            {i + 1}. {labels[i]}
          </Box>
        );
      })}
    </Box>
  );
}

function OnboardingInner(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<StepName>('password');

  const stepIdx = STEPS.indexOf(step);
  const labels = [
    t('onboarding:steps.password') || 'Password',
    t('onboarding:steps.mfa') || 'MFA',
    t('onboarding:steps.ruo') || 'RUO',
    t('onboarding:steps.tour') || 'Tour',
    t('onboarding:steps.sample') || 'Demo',
  ];

  const advance = (): void => {
    trackOnboardingStep(step, 'completed');
    const next = STEPS[stepIdx + 1];
    if (next) setStep(next);
    else navigate('/cases');
  };

  const skip = (): void => {
    trackOnboardingStep(step, 'skipped');
    const next = STEPS[stepIdx + 1];
    if (next) setStep(next);
    else navigate('/cases');
  };

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string}>
      <EMRPageHeader
        icon={IconShieldLock}
        title={t('onboarding:title') || 'Welcome to LiverRa'}
        subtitle={
          t('onboarding:subtitle') ||
          'Complete these 5 steps to activate your account (approx 15 min).'
        }
      />

      <StepIndicator step={stepIdx} total={STEPS.length} labels={labels} />

      <Box
        style={{
          padding: 16,
          borderRadius: 'var(--emr-border-radius-lg)',
          background: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-gray-200)',
        }}
      >
        {step === 'password' && (
          <PasswordStep onContinue={advance} onSSO={advance} />
        )}
        {step === 'mfa' && <MFAEnrolStep onContinue={advance} />}
        {step === 'ruo' && <RUOAcceptStep onContinue={advance} />}
        {step === 'tour' && <GuidedTourStep onContinue={advance} onSkip={skip} />}
        {step === 'sample_case' && (
          <SampleCaseStep
            onFinish={(analysisId) => {
              if (analysisId) navigate(`/cases/${analysisId}`);
              else navigate('/cases');
            }}
            onSkip={() => navigate('/cases')}
          />
        )}
      </Box>

      <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)">
        {t('onboarding:privacyNote') ||
          'This wizard collects no patient information. Every step is auditable.'}
      </Text>
    </Stack>
  );
}

export default function OnboardingWizardView(): React.ReactElement {
  return (
    <EMRErrorBoundary>
      <Suspense fallback={<EMRTableSkeleton rows={4} columns={1} />}>
        <OnboardingInner />
      </Suspense>
    </EMRErrorBoundary>
  );
}
