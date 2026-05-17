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

/**
 * Seed point for a new lesion via MedSAM-2 / equivalent prompt model.
 * Posts to `/reviews/{review_id}/lesion-prompt` — server runs the prompt
 * model on the supplied voxel and returns a new lesion row.
 */
export interface DispatchLesionPromptInput {
  analysisId: string;
  voxel: [number, number, number];
  /** Optional anatomy hint when the reviewer is prompting inside a known segment. */
  couinaudSegment?: string;
  clientVersion?: number;
}

/**
 * Reviewer-placed marker (sticky note in voxel space). Posts to
 * `/reviews/{review_id}/marker`. Markers are additive — DELETE goes through
 * a separate dispatcher once the marker-edit UI lands.
 */
export interface DispatchMarkerInput {
  analysisId: string;
  voxel: [number, number, number];
  /** Couinaud segment roman (I-VIII) at the marker voxel, if any. */
  couinaudSegment?: string;
  /** Canonical segmentation key (e.g. 'parenchyma', 'couinaud-vii'). */
  segmentationId?: string;
  /** One-word reviewer label (max 80 chars). */
  label?: string;
  /** Free-text note (max 2000 chars). */
  note?: string;
  clientVersion?: number;
}

export interface UseRefinementDispatchResult {
  dispatchMaskRefine(input: DispatchMaskRefineInput): Promise<string>;
  dispatchLesionPrompt(input: DispatchLesionPromptInput): Promise<string>;
  dispatchMarker(input: DispatchMarkerInput): Promise<string>;
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

  const dispatchLesionPrompt = useCallback(
    async (input: DispatchLesionPromptInput): Promise<string> => {
      if (!seat.reviewId) {
        throw new Error('No active reviewer seat — acquire() first.');
      }
      const editType: OfflineEditType = 'lesion_prompt';
      const edit = await offlineQueue.enqueue({
        analysis_id: input.analysisId,
        edit_type: editType,
        payload: {
          review_id: seat.reviewId,
          analysis_id: input.analysisId,
          voxel: input.voxel,
          couinaud_segment: input.couinaudSegment ?? null,
          client_version: input.clientVersion ?? 1,
        },
        endpoint: `/reviews/${seat.reviewId}/lesion-prompt`,
      });
      nudge();
      return edit.id;
    },
    [seat.reviewId, nudge],
  );

  const dispatchMarker = useCallback(
    async (input: DispatchMarkerInput): Promise<string> => {
      if (!seat.reviewId) {
        throw new Error('No active reviewer seat — acquire() first.');
      }
      const editType: OfflineEditType = 'marker';
      const edit = await offlineQueue.enqueue({
        analysis_id: input.analysisId,
        edit_type: editType,
        payload: {
          review_id: seat.reviewId,
          analysis_id: input.analysisId,
          voxel: input.voxel,
          couinaud_segment: input.couinaudSegment ?? null,
          segmentation_id: input.segmentationId ?? null,
          label: input.label ?? null,
          note: input.note ?? null,
          client_version: input.clientVersion ?? 1,
        },
        endpoint: `/reviews/${seat.reviewId}/marker`,
      });
      nudge();
      return edit.id;
    },
    [seat.reviewId, nudge],
  );

  return {
    dispatchMaskRefine,
    dispatchLesionPrompt,
    dispatchMarker,
    dispatchClassificationOverride,
  };
}

export default useRefinementDispatch;
