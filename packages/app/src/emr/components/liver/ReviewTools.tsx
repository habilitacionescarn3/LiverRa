// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ReviewTools (T248 wiring slot).
 *
 * Plain-English: a tiny composition that the AnalysisDetailView can drop
 * into its Review drawer tab. It renders `RefineTools` plus the
 * `ClassificationOverride` modal AND gates both behind
 * `useReviewSeat().hasSeat` so a read-only viewer cannot mutate masks.
 *
 * This file exists so T248 wiring does NOT have to touch
 * `AnalysisDetailView.tsx` directly — the parent file is owned by a
 * sibling agent. The caller adds a single import:
 *
 *   import { ReviewTools } from '../../components/liver/ReviewTools';
 *
 * Spec refs: FR-017a (read-only gating), FR-015, FR-016.
 */

import { Stack, Text } from '@mantine/core';
import {
  useCallback,
  useState,
  type ReactElement,
} from 'react';

import { useReviewSeatContext } from '../../contexts/ReviewSeatContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { ClassificationOverride, type LesionClass } from './ClassificationOverride';
import { RefineTools, type RefineToolId } from './RefineTools';

export interface ReviewToolsProps {
  analysisId: string;
  /** Currently selected lesion (for the override modal). */
  selectedLesionId?: string | null;
  selectedLesionClass?: LesionClass | null;
  /** Called by the caller to apply the new class via dispatch hook. */
  onSubmitOverride?: (args: {
    lesionId: string;
    newClass: LesionClass;
    reason: string;
  }) => Promise<void> | void;
  onToolChange?: (tool: RefineToolId | null) => void;
}

export function ReviewTools({
  analysisId,
  selectedLesionId = null,
  selectedLesionClass = null,
  onSubmitOverride,
  onToolChange,
}: ReviewToolsProps): ReactElement {
  const { t } = useTranslation();
  const seat = useReviewSeatContext();
  const [tool, setTool] = useState<RefineToolId | null>(null);
  const [overrideOpen, setOverrideOpen] = useState<boolean>(false);

  const disabled = !seat.hasSeat;

  const handleTool = useCallback(
    (next: RefineToolId | null): void => {
      setTool(next);
      onToolChange?.(next);
    },
    [onToolChange],
  );

  const handleOverrideSubmit = useCallback(
    async (args: {
      lesionId: string;
      newClass: LesionClass;
      reason: string;
    }): Promise<void> => {
      if (!onSubmitOverride) return;
      await onSubmitOverride(args);
    },
    [onSubmitOverride],
  );

  return (
    <Stack gap="sm" data-testid="review-tools" data-analysis-id={analysisId}>
      {disabled && (
        <Text size="xs" c="dimmed">
          {t('review.readOnlyNotice')}
        </Text>
      )}
      <RefineTools
        activeTool={tool}
        onToolChange={handleTool}
        disabled={disabled}
      />
      {selectedLesionId && (
        <button
          type="button"
          onClick={() => setOverrideOpen(true)}
          disabled={disabled}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--emr-primary)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            padding: 0,
            textAlign: 'left',
            font: 'inherit',
            fontSize: 'var(--emr-font-sm, 14px)',
          }}
          data-testid="review-tools-open-override"
        >
          {t('review.openClassificationOverride')}
        </button>
      )}
      <ClassificationOverride
        opened={overrideOpen}
        lesionId={selectedLesionId}
        currentClass={selectedLesionClass}
        onClose={() => setOverrideOpen(false)}
        onSubmit={handleOverrideSubmit}
      />
    </Stack>
  );
}

export default ReviewTools;
