// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Mammography 4-up hanging protocol — pane assignment
// ============================================================================
// Pure logic that maps a set of MG (FFDM) images to the four standard
// screening panes (RCC/LCC/RMLO/LMLO) in the back-to-back hanging layout, and
// decides which panes get a horizontal flip. No React, no Cornerstone, never
// throws — the entire feature's correctness is unit-tested here.
//
// Render-order panes (the viewer fills viewport-0..3, the CSS grid places them
// left-to-right, top-to-bottom):
//   0 = LCC  (top-left)     2 = LMLO (bottom-left)
//   1 = RCC  (top-right)    3 = RMLO (bottom-right)
// Left breast on the viewer's LEFT; the right breast is mirrored so the two
// chest walls meet in the middle (standard mammography mounting).
// ============================================================================

import type { MammoImageDescriptor } from '../../types/pacs';

export interface MammoPaneAssignment {
  /** Render order 0..3 — maps to viewport-0..3 (see header for the grid). */
  viewportIndex: 0 | 1 | 2 | 3;
  /** The image to load, or null for an empty pane (missing view). */
  imageId: string | null;
  /** Mirror the right breast so the two sides face each other. */
  flipHorizontal: boolean;
}

export interface MammoLayoutResult {
  /** Always length 4, in render order: LCC, RCC, LMLO, RMLO. */
  panes: MammoPaneAssignment[];
  /** Non-standard / surplus views (spot, mag, ML, XCCL, duplicates, …). */
  extras: MammoImageDescriptor[];
  /** false → no standard pane could be filled; caller should fall back to 1-up. */
  usable: boolean;
}

/** A standard screening slot in render order. */
interface Slot {
  index: 0 | 1 | 2 | 3;
  laterality: 'L' | 'R';
  view: 'CC' | 'MLO';
}

const STANDARD_SLOTS: Slot[] = [
  { index: 0, laterality: 'L', view: 'CC' }, // LCC  — top-left
  { index: 1, laterality: 'R', view: 'CC' }, // RCC  — top-right
  { index: 2, laterality: 'L', view: 'MLO' }, // LMLO — bottom-left
  { index: 3, laterality: 'R', view: 'MLO' }, // RMLO — bottom-right
];

/** True only for the exact standard screening views (not ML, XCCL, spot, mag…). */
function isStandardView(view: string | undefined): view is 'CC' | 'MLO' {
  return view === 'CC' || view === 'MLO';
}

/**
 * Decide whether a pane needs a horizontal flip.
 *
 * The hanging rule mirrors the right breast so the two chest walls meet in the
 * middle. But some studies arrive ALREADY mirrored — the detector flipped them
 * (FieldOfViewHorizontalFlip = 'YES') or PatientOrientation marks a flipped
 * row direction. Blindly flipping the right breast on top of that double-flips
 * it. So when an orientation hint says the image is already mirrored, we XOR it
 * out. When no orientation tags are present we fall back to the laterality rule.
 */
function resolveFlipHorizontal(
  slotLaterality: 'L' | 'R',
  image: MammoImageDescriptor | undefined
): boolean {
  const wantsMirror = slotLaterality === 'R';
  if (!image) {
    return wantsMirror;
  }

  const fovFlip = image.fieldOfViewHorizontalFlip?.trim().toUpperCase();
  if (fovFlip === 'YES') {
    return !wantsMirror;
  }
  if (fovFlip === 'NO') {
    return wantsMirror;
  }

  // PatientOrientation row direction: for MG the first component is the patient
  // direction toward the LEFT edge of the image. A right-breast image whose row
  // direction already points laterally outward (R) is stored mirrored.
  const rowDirection = image.patientOrientation?.split('\\')[0]?.trim().toUpperCase();
  if (rowDirection === 'L' || rowDirection === 'R') {
    const alreadyMirrored = rowDirection === slotLaterality;
    return wantsMirror !== alreadyMirrored;
  }

  return wantsMirror;
}

/**
 * Assign MG images to the four standard screening panes.
 *
 * - Dedupes For-Processing vs For-Presentation duplicates of the same
 *   (laterality, view) — keeps PRESENTATION, demotes the loser to `extras`.
 * - Fills LCC/RCC/LMLO/RMLO; every non-standard or surplus view (ML, XCCL,
 *   spot-compression, magnification, ID/Eklund, rolled, duplicates) → `extras`.
 * - Flips the right-breast panes so the two sides mount back-to-back.
 * - `usable` is true when at least one standard pane is filled; when false the
 *   caller should fall back to a 1-up layout rather than show 4 empty panes.
 *
 * Pure and defensive: never throws on missing fields or malformed input.
 */
export function assignMammoPanes(images: MammoImageDescriptor[]): MammoLayoutResult {
  const safeImages = Array.isArray(images)
    ? images.filter((img) => img && typeof img.imageId === 'string' && img.imageId.length > 0)
    : [];

  // 1. Dedupe per (laterality, view); non-standard views go straight to extras.
  const chosenByKey = new Map<string, MammoImageDescriptor>();
  const extras: MammoImageDescriptor[] = [];
  for (const img of safeImages) {
    if (!img.laterality || !isStandardView(img.view)) {
      extras.push(img);
      continue;
    }
    const key = `${img.laterality}-${img.view}`;
    const existing = chosenByKey.get(key);
    if (!existing) {
      chosenByKey.set(key, img);
      continue;
    }
    // A duplicate of an already-claimed view. Prefer the FOR PRESENTATION copy
    // (the diagnostic-display image) over FOR PROCESSING; demote the loser.
    if (existing.presentationIntent !== 'PRESENTATION' && img.presentationIntent === 'PRESENTATION') {
      chosenByKey.set(key, img);
      extras.push(existing);
    } else {
      extras.push(img);
    }
  }

  // 2. Build the four panes in render order; flip the right-breast panes.
  let filled = 0;
  const panes: MammoPaneAssignment[] = STANDARD_SLOTS.map((slot) => {
    const match = chosenByKey.get(`${slot.laterality}-${slot.view}`);
    if (match) {
      filled += 1;
    }
    return {
      viewportIndex: slot.index,
      imageId: match ? match.imageId : null,
      flipHorizontal: resolveFlipHorizontal(slot.laterality, match),
    };
  });

  return { panes, extras, usable: filled > 0 };
}
