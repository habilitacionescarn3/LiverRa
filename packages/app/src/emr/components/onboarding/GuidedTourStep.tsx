// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * GuidedTourStep (T303).
 *
 * Plain-English: fourth step — a 5-tooltip walkthrough over the
 * upload → viewer → finalize flow. Users can advance, skip, or replay
 * the tour. We emit a PostHog event per tooltip so the funnel tracks
 * drop-off per hotspot.
 */
import { useState } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import { IconRoute, IconPlayerSkipForward } from '@tabler/icons-react';
import { EMRButton } from '../common/EMRButton';
import { useTranslation } from '../../contexts/TranslationContext';
import { trackOnboardingStep } from './telemetry';

export interface GuidedTourStepProps {
  onContinue: () => void;
  onSkip: () => void;
}

const STOPS: { key: string; defaultText: string }[] = [
  { key: 'onboarding:tour.s1', defaultText: 'Drop a DICOM archive here to start a new analysis.' },
  { key: 'onboarding:tour.s2', defaultText: 'Watch the per-stage status — each checkpoint is audited.' },
  { key: 'onboarding:tour.s3', defaultText: 'Drag the resection plane to see FLR update live.' },
  { key: 'onboarding:tour.s4', defaultText: 'Append or refine lesions with the AI assistant.' },
  { key: 'onboarding:tour.s5', defaultText: 'Finalize when ready — the PDF + DICOM-SEG are saved to PACS.' },
];

export function GuidedTourStep({ onContinue, onSkip }: GuidedTourStepProps): React.ReactElement {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);

  const current = STOPS[step];
  const isLast = step === STOPS.length - 1;

  const advance = (): void => {
    trackOnboardingStep('tour', 'started', { stop: step });
    if (isLast) {
      trackOnboardingStep('tour', 'completed');
      onContinue();
    } else {
      setStep((s) => s + 1);
    }
  };

  const skip = (): void => {
    trackOnboardingStep('tour', 'skipped', { at_stop: step });
    onSkip();
  };

  return (
    <Stack gap="md">
      <Group gap="sm" wrap="wrap">
        <IconRoute size={22} color="var(--emr-primary)" />
        <Text fw={600} fz="var(--emr-font-lg)">
          {t('onboarding:tour.title') || 'Quick tour'}
        </Text>
        <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
          {step + 1} / {STOPS.length}
        </Text>
      </Group>
      <Box
        style={{
          padding: 16,
          borderRadius: 'var(--emr-border-radius-lg)',
          border: '1px solid var(--emr-gray-200)',
          background: 'var(--emr-bg-card)',
        }}
      >
        <Text fz="var(--emr-font-md)">{t(current.key) || current.defaultText}</Text>
      </Box>
      <Group justify="space-between" wrap="wrap">
        <EMRButton variant="ghost" icon={IconPlayerSkipForward} onClick={skip}>
          {t('onboarding:tour.skip') || 'Skip tour'}
        </EMRButton>
        <EMRButton variant="primary" onClick={advance}>
          {isLast ? (t('common:continue') || 'Continue') : (t('onboarding:tour.next') || 'Next')}
        </EMRButton>
      </Group>
    </Stack>
  );
}

export default GuidedTourStep;
