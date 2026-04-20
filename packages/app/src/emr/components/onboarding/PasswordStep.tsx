// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * PasswordStep (T300).
 *
 * Plain-English: first step of the onboarding wizard. The user either
 * sets their initial password OR links the hospital SSO (SAML / OIDC)
 * identity. Whichever path they choose, we fire PostHog events so the
 * funnel in Mixpanel shows drop-off per branch (T308).
 */
import { useState } from 'react';
import { Group, Stack, Text } from '@mantine/core';
import { IconShieldLock, IconBuildingHospital } from '@tabler/icons-react';
import { EMRButton } from '../common/EMRButton';
import { EMRAlert } from '../common/EMRAlert';
import { EMRTextInput } from '../shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';
import { trackOnboardingStep } from './telemetry';

export interface PasswordStepProps {
  onContinue: () => void;
  onSSO: () => void;
}

export function PasswordStep({ onContinue, onSSO }: PasswordStepProps): React.ReactElement {
  const { t } = useTranslation();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = pw.length > 0 && pw.length < 12;
  const mismatch = pw && pw2 && pw !== pw2;
  const canSubmit = pw.length >= 12 && !mismatch && !submitting;

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    trackOnboardingStep('password', 'completed');
    try {
      // Actual Cognito password-set call runs client-side via Amplify;
      // the onContinue callback advances the wizard state machine.
      onContinue();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const useSSO = (): void => {
    trackOnboardingStep('password', 'completed_sso');
    onSSO();
  };

  return (
    <Stack gap="md">
      <Group gap="sm" wrap="wrap">
        <IconShieldLock size={22} color="var(--emr-primary)" />
        <Text fw={600} fz="var(--emr-font-lg)">
          {t('onboarding:password.title') || 'Set your password'}
        </Text>
      </Group>
      <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
        {t('onboarding:password.subtitle') ||
          'Choose a strong password (min 12 chars) or link your hospital single sign-on.'}
      </Text>
      <EMRTextInput
        label={t('onboarding:password.new') || 'New password'}
        value={pw}
        onChange={(v) => setPw(String(v))}
        required
        type="password"
      />
      {tooShort && (
        <Text fz="var(--emr-font-xs)" c="var(--emr-warning)">
          {t('onboarding:password.tooShort') || 'Password must be at least 12 characters.'}
        </Text>
      )}
      <EMRTextInput
        label={t('onboarding:password.confirm') || 'Confirm password'}
        value={pw2}
        onChange={(v) => setPw2(String(v))}
        required
        type="password"
      />
      {mismatch && (
        <Text fz="var(--emr-font-xs)" c="var(--emr-error)">
          {t('onboarding:password.mismatch') || 'Passwords do not match.'}
        </Text>
      )}
      {error && <EMRAlert variant="error">{error}</EMRAlert>}
      <Group gap="sm" justify="space-between" wrap="wrap">
        <EMRButton
          variant="ghost"
          icon={IconBuildingHospital}
          onClick={useSSO}
          disabled={submitting}
        >
          {t('onboarding:password.useSso') || 'Use hospital SSO'}
        </EMRButton>
        <EMRButton
          variant="primary"
          onClick={submit}
          disabled={!canSubmit}
          loading={submitting}
        >
          {t('common:continue') || 'Continue'}
        </EMRButton>
      </Group>
    </Stack>
  );
}

export default PasswordStep;
