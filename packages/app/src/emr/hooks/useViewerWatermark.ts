// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useViewerWatermark (T188 — wiring).
 *
 * Plain-English: bolts the "Research Use Only" watermark onto a canvas
 * whenever the current claim registry says the underlying AI output is
 * still RUO. Two moving parts:
 *   1. Read the claim for the canvas's primary output (default:
 *      `parenchyma_segmentation` — the baseline liver mask that backs
 *      every viewport layer).
 *   2. Re-stamp the canvas whenever its contents change (new frame
 *      painted, layer toggled). We detect changes via `MutationObserver`
 *      on the canvas element + a one-shot on mount.
 *
 * Analogy: a wax seal that re-stamps itself every time someone touches
 * the envelope — you can't forget to reapply it.
 *
 * Spec refs: T188 from tasks.md, FR-028a, plan.md §UI Conventions.
 *
 * Note on `RUODisclaimer` text overlay: its mount is `EMRPage`'s job
 * (T112) — this hook only handles the burn-in watermark on imaging
 * surfaces.
 */

import { useEffect, type RefObject } from 'react';

import { burnWatermark, type WatermarkOptions } from '@liverra/imaging';

import type { ClaimKey } from '../contexts/RUOClaimRegistryContext';
import { useRUOClaim } from './useRUOClaim';

export interface UseViewerWatermarkOptions {
  /**
   * Which claim gates the watermark? Defaults to `parenchyma_segmentation`
   * because the parenchyma mask is the common foundation of every viewer
   * frame; an individual frame may composite further layers (lesions,
   * segments) but if the baseline is RUO the whole frame must be marked.
   */
  claimKey?: ClaimKey;
  /** Watermark appearance overrides forwarded to `burnWatermark`. */
  watermarkOptions?: WatermarkOptions;
  /**
   * If `true`, re-stamp on every `MutationObserver` hit against the
   * canvas. Set to `false` when the caller already calls `burnWatermark`
   * at the end of each render pass.
   */
  observe?: boolean;
}

/**
 * Attach an RUO watermark to a canvas ref.
 *
 * Safe to call when `canvasRef.current` is `null` (hook no-ops until a
 * canvas is attached) and when the claim is no longer RUO (hook no-ops
 * + tears down any observer). Idempotent across re-renders.
 */
export function useViewerWatermark(
  canvasRef: RefObject<HTMLCanvasElement>,
  options: UseViewerWatermarkOptions = {},
): void {
  const { claimKey = 'parenchyma_segmentation', watermarkOptions, observe = true } = options;
  const claim = useRUOClaim(claimKey);
  const { watermarkRequired } = claim;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!watermarkRequired) return;

    // Initial stamp.
    burnWatermark(canvas, watermarkOptions);

    if (!observe || typeof MutationObserver === 'undefined') return;

    const obs = new MutationObserver(() => {
      if (canvasRef.current) burnWatermark(canvasRef.current, watermarkOptions);
    });
    obs.observe(canvas, { attributes: true, childList: true, subtree: false });

    return () => obs.disconnect();
  }, [canvasRef, watermarkRequired, watermarkOptions, observe]);
}
