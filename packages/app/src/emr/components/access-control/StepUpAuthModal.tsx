// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * StepUpAuthModal — LiverRa MFA step-up prompt (T101).
 *
 * Plain-English: when a user attempts a high-risk action (finalize report,
 * execute erasure), the API returns `step_up_required` and our
 * `errorClient.ts` dispatches a `liverra:step-up-required` DOM event. This
 * modal is mounted once in the app shell, listens for that event, and
 * redirects the user through Cognito with `prompt=login&max_age=0` so
 * Cognito forces a fresh MFA challenge. Once the user returns, their
 * access-token `auth_time` claim is fresh and the retry succeeds.
 *
 * Renamed from MediMind's `EmergencyAccessModal` (which was a break-glass
 * reason-capture flow). LiverRa's step-up has no reason field — the user
 * just reauthenticates.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Alert, Stack, Text } from '@mantine/core';
import { IconShieldLock, IconAlertTriangle } from '@tabler/icons-react';
import type { UserManager } from 'oidc-client-ts';

import { EMRModal } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';
import { LIVERRA_ERROR_EVENTS } from '../../services/errorClient';

/** Payload dispatched on `liverra:step-up-required`. */
export interface StepUpRequiredDetail {
  /** What the user was trying to do (translation key or human text). */
  action?: string;
  /** Optional request instance ID for audit correlation. */
  instance?: string;
}

export interface StepUpAuthModalProps {
  /**
   * OIDC UserManager — provided by AuthContext. When the user confirms the
   * prompt we call `.signinRedirect({ prompt: 'login', max_age: 0 })` on it.
   */
  userManager?: UserManager | null;
  /** Override: provide a custom `onConfirm` instead of using `userManager`. */
  onConfirm?: (detail: StepUpRequiredDetail | null) => void | Promise<void>;
}

/**
 * StepUpAuthModal — subscribes to the `liverra:step-up-required` DOM event
 * (dispatched by errorClient.ts on 401/403 with `code: step_up_required`)
 * and triggers a Cognito reauth with `prompt=login&max_age=0`.
 */
export function StepUpAuthModal({ userManager, onConfirm }: StepUpAuthModalProps): ReactElement {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [detail, setDetail] = useState<StepUpRequiredDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handler = (event: Event): void => {
      const custom = event as CustomEvent<StepUpRequiredDetail>;
      setDetail(custom.detail ?? null);
      setOpened(true);
    };
    window.addEventListener(LIVERRA_ERROR_EVENTS.StepUpRequired, handler);
    return () => window.removeEventListener(LIVERRA_ERROR_EVENTS.StepUpRequired, handler);
  }, []);

  const handleClose = useCallback(() => {
    if (submitting) return;
    setOpened(false);
    setDetail(null);
  }, [submitting]);

  const handleConfirm = useCallback(async () => {
    setSubmitting(true);
    try {
      if (onConfirm) {
        await onConfirm(detail);
      } else if (userManager) {
        // Force Cognito to require a fresh MFA challenge. `max_age=0` means
        // "token's auth_time must be newer than now" — Cognito therefore
        // ignores the existing session cookie and prompts for MFA.
        await userManager.signinRedirect({
          extraQueryParams: { prompt: 'login', max_age: '0' },
        });
      } else {
        console.warn(
          '[StepUpAuthModal] no userManager or onConfirm provided — cannot trigger reauth.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  }, [detail, onConfirm, userManager]);

  return (
    <EMRModal
      opened={opened}
      onClose={handleClose}
      size="sm"
      icon={IconShieldLock}
      title={t('common:stepUp.title')}
      closeOnClickOutside={false}
      closeOnEscape={!submitting}
      withCloseButton={!submitting}
      cancelLabel={t('common:cancel')}
      submitLabel={t('common:stepUp.reauthenticate')}
      onSubmit={handleConfirm}
      submitLoading={submitting}
    >
      <Stack gap="md">
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
          <Text size="sm">{t('common:stepUp.explanation')}</Text>
        </Alert>

        {detail?.action && (
          <Text size="sm" c="var(--emr-text-secondary)">
            {t('common:stepUp.actionLabel')}: <strong>{detail.action}</strong>
          </Text>
        )}
      </Stack>
    </EMRModal>
  );
}

export default StepUpAuthModal;
