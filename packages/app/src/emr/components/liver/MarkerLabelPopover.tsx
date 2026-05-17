// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * MarkerLabelPopover (Phase G5).
 *
 * Plain-English: when the reviewer drops a marker by clicking the
 * viewer with the Marker tool active, a small floating card pops up at
 * the click position with a single text input + Save button. They type
 * a one-word label (e.g. "recheck"), optionally a longer note, and
 * Save closes the popover.
 *
 * Strategy chosen for label persistence (per Phase G5 task notes):
 *   PATCH /reviews/{review_id}/marker/{marker_id} does NOT yet exist on
 *   the backend (it lands in G7). For v1 we **optimistically patch the
 *   TanStack Query cache** for `['analysis', analysisId, 'markers']` so
 *   the label shows up in the MarkersList rail immediately, and we
 *   leave a TODO so the next phase can wire the real PATCH call. The
 *   bare marker (no label/note) is already persisted by the existing
 *   POST /reviews/{review_id}/marker that fired before this popover
 *   opened — so the worst case is the label "ghost" disappears on a
 *   hard refresh until G7 lands. That is acceptable for v1.
 *
 * Auto-close triggers:
 *   - Save button (commits label + note to the local cache)
 *   - Skip button (closes without committing)
 *   - Escape key
 *   - Click outside the popover card
 *   - 8-second inactivity timeout (so the popover never gets stuck if
 *     the reviewer wanders off)
 *
 * Position: `absolute` inside the viewer wrapper Box, which is already
 * `position: relative` in RefinementView. `anchorX/anchorY` are
 * wrapper-relative pixel coords passed in by the parent.
 */

import { Paper, Stack, Group, Text } from '@mantine/core';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { EMRButton } from '../common';
import { EMRTextInput, EMRTextarea } from '../shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';
import {
  markersQueryKey,
  type ReviewerMarker,
} from '../../hooks/useMarkers';

export interface MarkerLabelPopoverProps {
  /** The just-created marker's id (from POST /reviews/{id}/marker). */
  markerId: string;
  analysisId: string;
  reviewId: string;
  apiBaseUrl: string;
  /** Wrapper-relative pixel coords for absolute positioning. */
  anchorX: number;
  anchorY: number;
  onClose: () => void;
}

const POPOVER_WIDTH = 280;
const AUTO_CLOSE_MS = 8_000;
const LABEL_MAX = 80;
const NOTE_MAX = 2000;

export function MarkerLabelPopover({
  markerId,
  analysisId,
  reviewId: _reviewId,
  apiBaseUrl: _apiBaseUrl,
  anchorX,
  anchorY,
  onClose,
}: MarkerLabelPopoverProps): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset the 8-second auto-close any time the user interacts.
  const resetAutoClose = useMemo(
    () => (): void => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => onClose(), AUTO_CLOSE_MS);
    },
    [onClose],
  );

  useEffect(() => {
    resetAutoClose();
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, [resetAutoClose]);

  // Esc + click-outside close handlers.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        onClose();
      }
    };
    const onDocClick = (ev: MouseEvent): void => {
      const card = cardRef.current;
      if (!card) return;
      if (ev.target instanceof Node && !card.contains(ev.target)) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    // Defer mousedown listener by a tick so the click that opened the
    // popover doesn't immediately close it.
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onDocClick);
    }, 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [onClose]);

  const handleSave = (): void => {
    // TODO(phase-G7): wire PATCH /reviews/{review_id}/marker/{marker_id}
    // once the endpoint lands. For now, optimistically patch the local
    // TanStack cache so the label shows up in MarkersList immediately.
    queryClient.setQueryData<ReviewerMarker[] | undefined>(
      markersQueryKey(analysisId),
      (prev) => {
        if (!prev) return prev;
        return prev.map((m) =>
          m.id === markerId
            ? { ...m, label: label.trim() || null, note: note.trim() || null }
            : m,
        );
      },
    );
    onClose();
  };

  const handleSkip = (): void => {
    onClose();
  };

  // Clamp anchor so the popover doesn't render off-screen-right.
  const clampedLeft = Math.max(
    8,
    Math.min(anchorX, (typeof window !== 'undefined' ? window.innerWidth : 1600) - POPOVER_WIDTH - 8),
  );
  const clampedTop = Math.max(8, anchorY);

  return (
    <div
      ref={cardRef}
      data-testid="marker-popover"
      style={{
        position: 'absolute',
        top: clampedTop,
        left: clampedLeft,
        width: POPOVER_WIDTH,
        zIndex: 50,
      }}
      onMouseMove={resetAutoClose}
      onClick={resetAutoClose}
    >
      <Paper p="sm" shadow="lg" radius="md" withBorder>
        <Stack gap="xs">
          <Text fz="var(--emr-font-sm)" fw={600} c="var(--emr-text-primary)">
            {t('refine:marker.save')}
          </Text>
          <EMRTextInput
            data-testid="marker-popover-label-input"
            name="marker-label"
            placeholder={t('refine:marker.labelPlaceholder')}
            value={label}
            onChange={(v) => setLabel(v)}
            maxLength={LABEL_MAX}
            autoFocus
          />
          <EMRTextarea
            data-testid="marker-popover-note-input"
            name="marker-note"
            placeholder={t('refine:marker.notePlaceholder')}
            value={note}
            onChange={(v) => setNote(v)}
            maxLength={NOTE_MAX}
            minRows={2}
            autosize
          />
          <Group gap="xs" justify="flex-end" wrap="wrap">
            <EMRButton
              size="sm"
              variant="subtle"
              onClick={handleSkip}
              data-testid="marker-popover-skip"
            >
              {t('refine:marker.skip')}
            </EMRButton>
            <EMRButton
              size="sm"
              variant="primary"
              onClick={handleSave}
              data-testid="marker-popover-save"
            >
              {t('refine:marker.save')}
            </EMRButton>
          </Group>
        </Stack>
      </Paper>
    </div>
  );
}

export default MarkerLabelPopover;
