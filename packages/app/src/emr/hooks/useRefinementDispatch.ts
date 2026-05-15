// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useRefinementDispatch (T249 wiring slot).
 *
 * Plain-English: the shortcut every refine click takes through the
 * system. A caller (e.g. the 3D viewer's onClick) calls
 * `dispatchMaskRefine(...)` and this hook:
 *
 *   1. Pushes the edit onto the undo stack (optimistic UI).
 *   2. Enqueues the POST into `offlineQueue` so sync is durable.
 *   3. Nudges the `syncWorker` to flush right now.
 *
 * The caller never talks to the server — the worker does. That keeps
 * refine clicks snappy AND offline-safe by construction.
 *
 * This hook is a thin, side-file helper so T249 wiring does NOT have
 * to touch `AnalysisDetailView.tsx` directly (owned by another agent).
 *
 * Spec refs: FR-017, FR-018c; plan §Offline reviewer-edit durability.
 */

import { useCallback } from 'react';

import { useRefinementUndo } from '../contexts/RefinementUndoContext';
import { useReviewSeatContext } from '../contexts/ReviewSeatContext';
import { SYNC_WORKER_EVENT } from '../contexts/SyncContext';
import { offlineQueue, type OfflineEditType } from '../services/offline/offlineQueue';

export interface DispatchMaskRefineInput {
  analysisId: string;
  segmentationId: string;
  clickType: 'add' | 'subtract' | 'point';
  voxel: [number, number, number];
  clientVersion?: number;
  /** Previous voxel state for the inverse undo record. */
  inverse?: {
    clickType: 'add' | 'subtract' | 'point';
    voxel: [number, number, number];
  };
}

export interface DispatchClassificationInput {
  analysisId: string;
  lesionId: string;
  newClass: string;
  priorClass: string | null;
  reason: string;
  /** Optimistic-lock tag (H-LOCK-3). The backend CAS-bumps the lesion row. */
  clientVersion?: number;
}

export interface UseRefinementDispatchResult {
  dispatchMaskRefine(input: DispatchMaskRefineInput): Promise<string>;
  dispatchClassificationOverride(
    input: DispatchClassificationInput,
  ): Promise<string>;
}

export function useRefinementDispatch(): UseRefinementDispatchResult {
  const seat = useReviewSeatContext();
  const undo = useRefinementUndo();

  const nudge = useCallback((): void => {
    try {
      window.dispatchEvent(new CustomEvent(`${SYNC_WORKER_EVENT}:nudge`));
    } catch {
      /* ignore */
    }
  }, []);

  const dispatchMaskRefine = useCallback(
    async (input: DispatchMaskRefineInput): Promise<string> => {
      if (!seat.reviewId) {
        throw new Error('No active reviewer seat — acquire() first.');
      }
      const editType: OfflineEditType = 'mask_refine';
      const edit = await offlineQueue.enqueue({
        analysis_id: input.analysisId,
        edit_type: editType,
        payload: {
          review_id: seat.reviewId,
          analysis_id: input.analysisId,
          segmentation_id: input.segmentationId,
          click_type: input.clickType,
          voxel: input.voxel,
          client_version: input.clientVersion ?? 1,
        },
        endpoint: `/reviews/${seat.reviewId}/mask-refine`,
      });

      if (input.inverse) {
        await undo.push({
          id: edit.id,
          analysisId: input.analysisId,
          editType,
          inverse: {
            review_id: seat.reviewId,
            analysis_id: input.analysisId,
            segmentation_id: input.segmentationId,
            click_type: input.inverse.clickType,
            voxel: input.inverse.voxel,
            client_version: (input.clientVersion ?? 1) + 1,
          },
          label: `${input.clickType} @ (${input.voxel.join(',')})`,
        });
      }

      nudge();
      return edit.id;
    },
    [seat.reviewId, undo, nudge],
  );

  const dispatchClassificationOverride = useCallback(
    async (input: DispatchClassificationInput): Promise<string> => {
      if (!seat.reviewId) {
        throw new Error('No active reviewer seat — acquire() first.');
      }
      const editType: OfflineEditType = 'classification_override';
      const edit = await offlineQueue.enqueue({
        analysis_id: input.analysisId,
        edit_type: editType,
        payload: {
          review_id: seat.reviewId,
          lesion_id: input.lesionId,
          new_class: input.newClass,
          reason: input.reason,
          // H-LOCK-3: thread the version the UI last observed so the
          // backend can CAS-bump and reject stale overwrites.
          client_version: input.clientVersion ?? 1,
        },
        endpoint: `/reviews/${seat.reviewId}/classification-override`,
      });

      if (input.priorClass) {
        await undo.push({
          id: edit.id,
          analysisId: input.analysisId,
          editType,
          inverse: {
            review_id: seat.reviewId,
            lesion_id: input.lesionId,
            new_class: input.priorClass,
            reason: `undo of override → ${input.newClass}`,
            client_version: 2,
          },
          label: `class → ${input.newClass}`,
        });
      }

      nudge();
      return edit.id;
    },
    [seat.reviewId, undo, nudge],
  );

  return { dispatchMaskRefine, dispatchClassificationOverride };
}

export default useRefinementDispatch;
