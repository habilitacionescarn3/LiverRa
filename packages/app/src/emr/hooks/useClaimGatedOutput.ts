// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useClaimGatedOutput (T415 — wiring audit helper).
 *
 * Plain-English: a tiny adapter every AI-output component pipes its data
 * through. It asks `useRUOClaim` about the component's claim key and
 * returns the output along with render flags — visible? hide entirely?
 * watermarked? which disclaimer variant to mount alongside it? — so the
 * UI layer never has to hand-roll the per-claim branching.
 *
 * Analogy: a bouncer at the door. The output passes through unless the
 * claim registry says "this claim is scope-narrowed out" — in which case
 * the bouncer returns `null` + `gate: 'hidden'` and the caller renders a
 * stub or nothing.
 *
 * Why a hook instead of editing each consumer directly:
 *   The UI components (`FLRPanel`, `LesionBadge`, `LesionDetailPanel`,
 *   `PDFPreview`, `SampleDataBadge`) are owned by the frontend-designer
 *   agent. Giving them a single-line hook keeps the RUO scope-narrowing
 *   plumbing (FR-028b) consistent across all five surfaces + auditable
 *   in one place.
 *
 * Consumer → claim-key mapping (authoritative list — keep in sync when
 * new AI outputs land):
 *
 *   TODO [wiring]: FLRPanel.tsx              → useClaimGatedOutput('flr_volumetry', flr)
 *   TODO [wiring]: LesionBadge.tsx (T218)    → useClaimGatedOutput('lesion_classification', cls)
 *   TODO [wiring]: LesionDetailPanel.tsx     → useClaimGatedOutput('lesion_detection', lesion)
 *   TODO [wiring]: PDFPreview.tsx (T269)     → useClaimGatedOutput('dicom_export', preview)
 *   TODO [wiring]: SampleDataBadge.tsx (T310)→ useClaimGatedOutput('parenchyma_segmentation', sample)
 *
 * Each consumer should:
 *   1. Call `useClaimGatedOutput(CLAIM_KEY, rawOutput)`
 *   2. If `gate === 'hidden'` → return `null` (or a placeholder)
 *   3. If `watermark === true` and the surface renders a canvas →
 *      call `useViewerWatermark` with the same claim key
 *   4. Mount `<RUODisclaimer variant={disclaimerVariant} />` next to the
 *      output
 *
 * Spec refs: T415 in tasks.md, FR-028b (scope narrowing must flow
 * through every surface, not just RUODisclaimer + burnWatermark).
 */

import { useMemo } from 'react';

import type { ClaimKey, DisclaimerVariant, UiGate } from '../contexts/RUOClaimRegistryContext';
import { useRUOClaim } from './useRUOClaim';

export interface ClaimGatedOutput<T> {
  /** The original output, or `null` if the gate is `hidden`. */
  output: T | null;
  /** Which disclaimer variant the consumer should mount. */
  disclaimerVariant: DisclaimerVariant;
  /** `true` when the canvas/image must be watermarked. */
  watermark: boolean;
  /** Render gate — consumers branch on this. */
  gate: UiGate;
  /** The underlying claim key (echoed for convenience in logging). */
  claimKey: ClaimKey;
}

/**
 * Gate an arbitrary output behind its regulatory claim.
 *
 * @example
 *   // Inside FLRPanel.tsx:
 *   const { output, disclaimerVariant, watermark, gate } =
 *     useClaimGatedOutput('flr_volumetry', flrResult);
 *   if (gate === 'hidden' || !output) return null;
 *   return (
 *     <>
 *       <FLRReadout value={output} />
 *       {watermark && <WatermarkBadge />}
 *       <RUODisclaimer variant={disclaimerVariant} />
 *     </>
 *   );
 */
export function useClaimGatedOutput<T>(claimKey: ClaimKey, output: T): ClaimGatedOutput<T> {
  const claim = useRUOClaim(claimKey);

  return useMemo<ClaimGatedOutput<T>>(() => {
    if (claim.uiGate === 'hidden') {
      return {
        output: null,
        disclaimerVariant: claim.disclaimerVariant,
        watermark: false,
        gate: 'hidden',
        claimKey,
      };
    }
    return {
      output,
      disclaimerVariant: claim.disclaimerVariant,
      watermark: claim.watermarkRequired,
      gate: claim.uiGate,
      claimKey,
    };
  }, [claim, output, claimKey]);
}
