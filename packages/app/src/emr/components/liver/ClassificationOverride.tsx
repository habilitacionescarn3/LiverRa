// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ClassificationOverride (T238).
 *
 * Plain-English: an `EMRModal` that lets the reviewer override the AI's
 * tumor-class pick for a lesion. They pick a new class from a dropdown,
 * type a reason (required, minimum 3 chars), and confirm. Because the
 * action is clinically consequential, the backend route requires step-up
 * auth (`@require_permission(..., step_up=True)`); if the user's last
 * credential challenge is stale, the modal bubbles a `step-up-required`
 * event that the global `StepUpAuthModal` catches.
 *
 * Spec refs: FR-011 edge (classification override with audit reason),
 * FR-017 (retain AI + reviewer versions), plan §Review-time inference.
 */

import { Stack, Text } from '@mantine/core';
import { useCallback, useState, type ReactElement } from 'react';

import { useTranslation } from '../../contexts/TranslationContext';
import { EMRModal } from '../common';
import { EMRButton } from '../common/EMRButton';
import { EMRSelect, EMRTextarea } from '../shared/EMRFormFields';

/** 6-class LiLNet labels (spec §Model cards). */
export const LESION_CLASSES = [
  'hcc',
  'metastasis',
  'cholangiocarcinoma',
  'hemangioma',
  'fnh',
  'cyst',
] as const;

export type LesionClass = (typeof LESION_CLASSES)[number];

export interface ClassificationOverrideProps {
  opened: boolean;
  lesionId: string | null;
  currentClass: LesionClass | null;
  onClose(): void;
  /** Called after submit — parent wires the POST via the dispatch hook. */
  onSubmit(args: {
    lesionId: string;
    newClass: LesionClass;
    reason: string;
  }): Promise<void> | void;
  'data-testid'?: string;
}

export function ClassificationOverride({
  opened,
  lesionId,
  currentClass,
  onClose,
  onSubmit,
  'data-testid': testId = 'classification-override',
}: ClassificationOverrideProps): ReactElement {
  const { t } = useTranslation();
  const [newClass, setNewClass] = useState<LesionClass | null>(null);
  const [reason, setReason] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!lesionId || !newClass) {
      setErr(t('classificationOverride.missingFields'));
      return;
    }
    if (reason.trim().length < 3) {
      setErr(t('classificationOverride.reasonTooShort'));
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      await onSubmit({ lesionId, newClass, reason: reason.trim() });
      setNewClass(null);
      setReason('');
      onClose();
    } catch (e) {
      setErr(
        e instanceof Error ? e.message : t('classificationOverride.genericError'),
      );
    } finally {
      setSubmitting(false);
    }
  }, [lesionId, newClass, reason, onSubmit, onClose, t]);

  return (
    <EMRModal
      opened={opened}
      onClose={onClose}
      title={t('classificationOverride.title')}
      size="md"
      data-testid={testId}
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('classificationOverride.subtitle', {
            currentClass: currentClass ?? '—',
          })}
        </Text>

        <EMRSelect
          label={t('classificationOverride.newClassLabel')}
          placeholder={t('classificationOverride.newClassPlaceholder')}
          required
          data={LESION_CLASSES.map((cls) => ({
            value: cls,
            label: t(`classificationOverride.class.${cls}`),
          }))}
          value={newClass ?? null}
          onChange={(v) => setNewClass((v as LesionClass | null) ?? null)}
          data-testid={`${testId}-class`}
        />

        <EMRTextarea
          label={t('classificationOverride.reasonLabel')}
          placeholder={t('classificationOverride.reasonPlaceholder')}
          required
          autosize
          minRows={3}
          maxRows={6}
          value={reason}
          onChange={(value) => setReason(value)}
          data-testid={`${testId}-reason`}
        />

        {err && (
          <Text size="sm" c="red" role="alert">
            {err}
          </Text>
        )}

        <EMRButton
          onClick={() => void handleSubmit()}
          disabled={!lesionId || !newClass || reason.trim().length < 3}
          loading={submitting}
          data-testid={`${testId}-submit`}
        >
          {t('classificationOverride.submit')}
        </EMRButton>
      </Stack>
    </EMRModal>
  );
}

export default ClassificationOverride;
