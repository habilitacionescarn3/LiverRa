// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * SampleCaseStep (T304).
 *
 * Plain-English: final step — the user hits "Run demo case", the
 * server seeds (idempotently) a demo analysis in their tenant and
 * we redirect to it with a "Sample data — not real patient" badge.
 * This is also re-runnable from the Help menu per SC-013.
 */
import { useState } from 'react';
import { Group, Stack, Text } from '@mantine/core';
import { IconFlask, IconArrowRight } from '@tabler/icons-react';
import { EMRButton } from '../common/EMRButton';
import { EMRAlert } from '../common/EMRAlert';
import { useTranslation } from '../../contexts/TranslationContext';
import { trackOnboardingStep } from './telemetry';

export interface SampleCaseStepProps {
  onFinish: (analysisId?: string) => void;
  onSkip: () => void;
}

export function SampleCaseStep({ onFinish, onSkip }: SampleCaseStepProps): React.ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    trackOnboardingStep('sample_case', 'started');
    try {
      const r = await fetch('/api/v1/auth/me/onboarding-status', { credentials: 'include' });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const data = (await r.json()) as { sample_case_analysis_id?: string };
      setAnalysisId(data.sample_case_analysis_id ?? null);
      trackOnboardingStep('sample_case', 'completed');
      onFinish(data.sample_case_analysis_id);
    } catch (e) {
      setError((e as Error).message);
      trackOnboardingStep('sample_case', 'failed');
    } finally {
      setBusy(false);
    }
  };

  const skip = (): void => {
    trackOnboardingStep('sample_case', 'skipped');
    onSkip();
  };

  return (
    <Stack gap="md">
      <Group gap="sm" wrap="wrap">
        <IconFlask size={22} color="var(--emr-primary)" />
        <Text fw={600} fz="var(--emr-font-lg)">
          {t('onboarding:sample.title') || 'Run a demo case'}
        </Text>
      </Group>
      <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
        {t('onboarding:sample.subtitle') ||
          'Open a pre-seeded demo analysis to explore the 3D viewer, FLR calculator, and finalize flow. This is synthetic data — no real patient information is shown.'}
      </Text>
      {error && <EMRAlert variant="error">{error}</EMRAlert>}
      {analysisId && (
        <EMRAlert variant="success" title={t('onboarding:sample.ready') || 'Demo ready'}>
          {t('onboarding:sample.redirecting') || 'Redirecting you to the demo case…'}
        </EMRAlert>
      )}
      <Group justify="space-between" wrap="wrap">
        <EMRButton variant="ghost" onClick={skip} disabled={busy}>
          {t('common:skip') || 'Skip'}
        </EMRButton>
        <EMRButton
          variant="primary"
          icon={IconArrowRight}
          onClick={run}
          disabled={busy}
          loading={busy}
        >
          {t('onboarding:sample.run') || 'Run demo case'}
        </EMRButton>
      </Group>
    </Stack>
  );
}

export default SampleCaseStep;
