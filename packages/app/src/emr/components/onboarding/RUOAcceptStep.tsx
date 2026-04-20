// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * RUOAcceptStep (T302).
 *
 * Plain-English: third step — shows the Research Use Only terms in the
 * user's preferred locale, requires an explicit checkbox, and POSTs a
 * signed acceptance to /auth/ruo-accept. The backend HMAC-signs
 * (user_id | timestamp | tenant_genesis | version) and stamps it on
 * the audit trail — non-repudiable per FR-031.
 */
import { useState } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import { IconFileCertificate } from '@tabler/icons-react';
import { EMRButton } from '../common/EMRButton';
import { EMRAlert } from '../common/EMRAlert';
import { EMRCheckbox } from '../shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';
import { trackOnboardingStep } from './telemetry';

const RUO_VERSION = '2026-04-01';

export interface RUOAcceptStepProps {
  onContinue: () => void;
}

export function RUOAcceptStep({ onContinue }: RUOAcceptStepProps): React.ReactElement {
  const { t, locale } = useTranslation();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/v1/auth/ruo-accept', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: RUO_VERSION, locale }),
      });
      if (!r.ok) throw new Error(`ruo-accept failed: ${r.status}`);
      trackOnboardingStep('ruo', 'completed', { version: RUO_VERSION, locale });
      onContinue();
    } catch (e) {
      setError((e as Error).message);
      trackOnboardingStep('ruo', 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="md">
      <Group gap="sm" wrap="wrap">
        <IconFileCertificate size={22} color="var(--emr-primary)" />
        <Text fw={600} fz="var(--emr-font-lg)">
          {t('onboarding:ruo.title') || 'Research Use Only — accept the terms'}
        </Text>
      </Group>
      <Box
        style={{
          maxHeight: 320,
          overflowY: 'auto',
          padding: 16,
          borderRadius: 'var(--emr-border-radius-lg)',
          background: 'var(--emr-bg-subtle)',
          border: '1px solid var(--emr-gray-200)',
        }}
      >
        <Text fz="var(--emr-font-sm)" style={{ whiteSpace: 'pre-wrap' }}>
          {t('onboarding:ruo.body') ||
            'LiverRa is classified as Research Use Only. Outputs are not a medical device and must not be used as the sole basis for clinical decisions. You remain the responsible clinician. All analyses are logged to an immutable audit trail.'}
        </Text>
      </Box>
      <EMRCheckbox
        checked={accepted}
        onChange={(value) => setAccepted(value)}
        label={t('onboarding:ruo.checkbox') || 'I have read and accept the Research Use Only terms.'}
      />
      <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)">
        {t('onboarding:ruo.version') || 'Version'}: {RUO_VERSION} · {locale}
      </Text>
      {error && <EMRAlert variant="error">{error}</EMRAlert>}
      <Group justify="flex-end">
        <EMRButton
          variant="primary"
          onClick={submit}
          disabled={!accepted || busy}
          loading={busy}
        >
          {t('onboarding:ruo.accept') || 'Accept and continue'}
        </EMRButton>
      </Group>
    </Stack>
  );
}

export default RUOAcceptStep;
