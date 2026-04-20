// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ConflictResolutionModal (T245).
 *
 * Plain-English analogy:
 *   Two surgeons edited the same lesion mask in two tabs. When the
 *   sync worker tries to post yours and the server says "wait, there's
 *   a newer version", we pop this modal. Three choices:
 *     - Keep mine   → force-push the local edit on top.
 *     - Keep theirs → drop my edit, accept the server version.
 *     - Manual     → open a diff view and let me merge by hand.
 *
 * Defaults to "Keep theirs" (server_wins) so if the user closes the
 * modal without picking, we never silently overwrite peer work.
 *
 * The modal listens for `LIVERRA_ERROR_EVENTS.ConflictResolution` which
 * `conflictResolver.resolve()` dispatches on a 409; it replies via
 * `submitDecision(conflictId, resolution)`.
 *
 * Spec refs: FR-018c, plan §Conflict resolution.
 */

import { Stack, Text } from '@mantine/core';
import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
} from 'react';

import { useTranslation } from '../../contexts/TranslationContext';
import { EMRModal } from '../common';
import { EMRButton } from '../common/EMRButton';
import { EMRRadioGroup } from '../shared/EMRFormFields/EMRRadioGroup';
import {
  CONFLICT_DECISION_EVENT,
  submitDecision,
  type ConflictResolution,
  type ConflictResolutionDetail,
} from '../../services/offline/conflictResolver';
import { LIVERRA_ERROR_EVENTS } from '../../services/errorClient';

export function ConflictResolutionModal(): ReactElement | null {
  const { t } = useTranslation();
  const [active, setActive] = useState<
    (ConflictResolutionDetail & { conflictId: string }) | null
  >(null);
  const [choice, setChoice] = useState<ConflictResolution>('server_wins');

  useEffect(() => {
    const onConflict = (ev: Event): void => {
      const detail = (
        ev as CustomEvent<ConflictResolutionDetail & { conflictId: string }>
      ).detail;
      if (!detail) return;
      setActive(detail);
      setChoice('server_wins');
    };
    window.addEventListener(
      LIVERRA_ERROR_EVENTS.ConflictResolution,
      onConflict as EventListener,
    );
    return () => {
      window.removeEventListener(
        LIVERRA_ERROR_EVENTS.ConflictResolution,
        onConflict as EventListener,
      );
    };
  }, []);

  const close = useCallback((): void => setActive(null), []);

  const submit = useCallback((): void => {
    if (!active) return;
    submitDecision({ conflictId: active.conflictId, resolution: choice });
    // Emit a side-channel CustomEvent the tests can hook into.
    try {
      window.dispatchEvent(
        new CustomEvent(`${CONFLICT_DECISION_EVENT}:submitted`, {
          detail: { conflictId: active.conflictId, resolution: choice },
        }),
      );
    } catch {
      /* ignore */
    }
    close();
  }, [active, choice, close]);

  if (!active) return null;

  return (
    <EMRModal
      opened
      onClose={close}
      title={t('conflict.title')}
      size="md"
      data-testid="conflict-resolution-modal"
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('conflict.subtitle', {
            clientVersion: active.clientVersion,
            serverVersion: active.serverVersion,
          })}
        </Text>

        <EMRRadioGroup
          value={choice}
          onChange={(v) => setChoice(v as ConflictResolution)}
          name="conflict-resolution"
          label={t('conflict.chooseLabel')}
          required
          options={[
            {
              value: 'server_wins',
              label: t('conflict.option.serverWins'),
              description: t('conflict.option.serverWinsDescription'),
            },
            {
              value: 'client_wins',
              label: t('conflict.option.clientWins'),
              description: t('conflict.option.clientWinsDescription'),
            },
            {
              value: 'manual',
              label: t('conflict.option.manual'),
              description: t('conflict.option.manualDescription'),
            },
          ]}
        />

        <EMRButton onClick={submit} data-testid="conflict-submit">
          {t('conflict.confirm')}
        </EMRButton>
      </Stack>
    </EMRModal>
  );
}

export default ConflictResolutionModal;
