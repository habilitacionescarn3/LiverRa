// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * UserInviteModal (T287).
 *
 * Plain-English: the modal that opens when an admin clicks "Invite user".
 * It collects email + role + display name + locale, fires the hook's
 * ``invite()`` mutation, and closes on success. On failure the EMRAlert
 * stays visible with a retry affordance.
 */
import { useState } from 'react';
import { Stack } from '@mantine/core';
import { EMRModal } from '../common/EMRModal';
import { EMRButton } from '../common/EMRButton';
import { EMRAlert } from '../common/EMRAlert';
import {
  EMRTextInput,
  EMRSelect,
} from '../shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';
import type { InviteUserPayload } from '../../hooks/useAdminUsers';

export interface UserInviteModalProps {
  opened: boolean;
  onClose: () => void;
  onInvite: (p: InviteUserPayload) => Promise<unknown>;
}

export function UserInviteModal({ opened, onClose, onInvite }: UserInviteModalProps): React.ReactElement {
  const { t } = useTranslation();
  const [values, setValues] = useState<InviteUserPayload>({
    email: '',
    role: 'hpb_surgeon',
    display_name: '',
    locale_preference: 'en',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const update = (patch: Partial<InviteUserPayload>): void => {
    setValues((v) => ({ ...v, ...patch }));
  };

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await onInvite(values);
      onClose();
      setValues({ email: '', role: 'hpb_surgeon', display_name: '', locale_preference: 'en' });
    } catch (e) {
      setError(e as Error);
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    values.email.trim().length > 3 &&
    values.display_name.trim().length > 1 &&
    !submitting;

  return (
    <EMRModal
      opened={opened}
      onClose={onClose}
      title={t('admin:invite.title') || 'Invite user'}
      size="md"
      primaryAction={
        <EMRButton variant="primary" disabled={!canSubmit} onClick={submit} loading={submitting}>
          {t('admin:invite.submit') || 'Send invite'}
        </EMRButton>
      }
      secondaryAction={
        <EMRButton variant="ghost" onClick={onClose} disabled={submitting}>
          {t('common:cancel') || 'Cancel'}
        </EMRButton>
      }
    >
      <Stack gap="md">
        {error && (
          <EMRAlert variant="error" title={t('admin:invite.error') || 'Invite failed'}>
            {error.message}
          </EMRAlert>
        )}
        <EMRTextInput
          label={t('admin:invite.email') || 'Email'}
          value={values.email}
          onChange={(v) => update({ email: String(v) })}
          required
          type="email"
        />
        <EMRTextInput
          label={t('admin:invite.displayName') || 'Display name'}
          value={values.display_name}
          onChange={(v) => update({ display_name: String(v) })}
          required
        />
        <EMRSelect
          label={t('admin:invite.role') || 'Role'}
          value={values.role}
          onChange={(v) => update({ role: String(v ?? 'hpb_surgeon') })}
          data={[
            { value: 'hpb_surgeon', label: t('admin:role.hpb_surgeon') || 'HPB surgeon' },
            { value: 'radiologist', label: t('admin:role.radiologist') || 'Radiologist' },
            { value: 'fellow', label: t('admin:role.fellow') || 'Fellow' },
            { value: 'ops', label: t('admin:role.ops') || 'Ops' },
            { value: 'compliance', label: t('admin:role.compliance') || 'Compliance' },
            { value: 'dpo', label: t('admin:role.dpo') || 'DPO' },
          ]}
          required
        />
        <EMRSelect
          label={t('admin:invite.locale') || 'Locale'}
          value={values.locale_preference}
          onChange={(v) => update({ locale_preference: String(v ?? 'en') })}
          data={[
            { value: 'en', label: 'English' },
            { value: 'de', label: 'Deutsch' },
            { value: 'ka', label: 'ქართული' },
          ]}
          required
        />
      </Stack>
    </EMRModal>
  );
}

export default UserInviteModal;
