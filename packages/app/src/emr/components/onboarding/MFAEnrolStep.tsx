// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * MFAEnrolStep (T301).
 *
 * Plain-English: second step — set up multi-factor authentication.
 * Calls `/auth/mfa-enrol` to mint a TOTP secret + 10 backup codes,
 * renders a QR code (the otpauth URI), lets the user download the
 * backup codes, then verifies their first OTP to flip
 * ``mfa_enrolled_at``.
 */
import { useEffect, useState } from 'react';
import { Group, Stack, Text } from '@mantine/core';
import { IconShieldCheck, IconDownload } from '@tabler/icons-react';
import { EMRButton } from '../common/EMRButton';
import { EMRAlert } from '../common/EMRAlert';
import { EMRTextInput } from '../shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';
import { trackOnboardingStep } from './telemetry';

interface MFAStart {
  secret: string;
  otpauth_uri: string;
  backup_codes: string[];
}

export interface MFAEnrolStepProps {
  onContinue: () => void;
}

export function MFAEnrolStep({ onContinue }: MFAEnrolStepProps): React.ReactElement {
  const { t } = useTranslation();
  const [start, setStart] = useState<MFAStart | null>(null);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    trackOnboardingStep('mfa', 'started');
    setBusy(true);
    fetch('/api/v1/auth/mfa-enrol', {
      method: 'POST',
      credentials: 'include',
    })
      .then((r) => {
        if (!r.ok) throw new Error(`mfa-enrol failed: ${r.status}`);
        return r.json() as Promise<MFAStart>;
      })
      .then(setStart)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, []);

  const downloadCodes = (): void => {
    if (!start) return;
    const blob = new Blob([start.backup_codes.join('\n') + '\n'], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'liverra-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const verify = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/v1/auth/mfa-enrol/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ otp }),
      });
      if (!r.ok) throw new Error(`verify failed: ${r.status}`);
      trackOnboardingStep('mfa', 'completed');
      onContinue();
    } catch (e) {
      setError((e as Error).message);
      trackOnboardingStep('mfa', 'failed');
    } finally {
      setBusy(false);
    }
  };

  const qrSrc = start
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(start.otpauth_uri)}`
    : '';

  return (
    <Stack gap="md">
      <Group gap="sm" wrap="wrap">
        <IconShieldCheck size={22} color="var(--emr-primary)" />
        <Text fw={600} fz="var(--emr-font-lg)">
          {t('onboarding:mfa.title') || 'Set up multi-factor authentication'}
        </Text>
      </Group>
      <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
        {t('onboarding:mfa.subtitle') ||
          'Scan the QR code with your authenticator app (Google Authenticator, 1Password, Authy), save the backup codes somewhere safe, then enter a code to confirm.'}
      </Text>

      {error && <EMRAlert variant="error">{error}</EMRAlert>}

      {start && (
        <Stack gap="md">
          <Group gap="md" align="flex-start" wrap="wrap">
            <img
              src={qrSrc}
              width={200}
              height={200}
              alt={t('onboarding:mfa.qrAlt') || 'MFA QR code'}
              style={{
                borderRadius: 'var(--emr-border-radius)',
                background: 'var(--emr-bg-card)',
                padding: 8,
                border: '1px solid var(--emr-gray-200)',
              }}
            />
            <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
              <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
                {t('onboarding:mfa.secretLabel') || 'Or enter this secret manually:'}
              </Text>
              <Text
                fz="var(--emr-font-sm)"
                style={{
                  fontFamily: 'var(--emr-font-mono)',
                  wordBreak: 'break-all',
                }}
              >
                {start.secret}
              </Text>
              <EMRButton
                variant="ghost"
                icon={IconDownload}
                onClick={downloadCodes}
                size="sm"
              >
                {t('onboarding:mfa.downloadBackup') || 'Download backup codes'}
              </EMRButton>
            </Stack>
          </Group>

          <EMRTextInput
            label={t('onboarding:mfa.enterCode') || 'Enter 6-digit code'}
            value={otp}
            onChange={(v) => setOtp(String(v).replace(/\D/g, '').slice(0, 8))}
            required
          />
          <Group justify="flex-end">
            <EMRButton
              variant="primary"
              onClick={verify}
              disabled={busy || otp.length < 6}
              loading={busy}
            >
              {t('common:continue') || 'Continue'}
            </EMRButton>
          </Group>
        </Stack>
      )}

      {busy && !start && (
        <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
          {t('onboarding:mfa.loading') || 'Generating secret and backup codes…'}
        </Text>
      )}
    </Stack>
  );
}

export default MFAEnrolStep;
