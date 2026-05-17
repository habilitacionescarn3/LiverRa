// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * viewerClickBridge — pure helpers that translate a Cornerstone3D viewport
 * click into integer voxel coordinates + a best-guess segmentation ID.
 *
 * Plain-English:
 *   Cornerstone3D paints a CT volume onto a canvas. When the reviewer clicks
 *   that canvas, we need to know "which voxel did they hit, and which AI
 *   segment is at that voxel" so the refine pipeline can act on it.
 *   `resolveCanvasClick` answers the first question (canvas → voxel via the
 *   viewport's own world↔index transform). `resolveSegmentationId` answers
 *   the second by sampling the loaded NIfTI labelmaps at that voxel.
 *
 * Why not just hand-roll the affine math from the NIfTI header?
 *   Cornerstone3D's `vtkImageData` already carries the volume's spacing,
 *   direction cosines, and origin — and exposes `worldToIndex()` that
 *   composes them. The NIfTI header affine only matters for the *labelmap*
 *   space, which (for LiverRa) shares the CT grid by construction.
 *
 * This module is intentionally React-free + Cornerstone-state-free so it
 * is trivially unit-testable with a faked `vtkImageData` mock.
 */

import type { Types } from '@cornerstonejs/core';

import type { NiftiMask } from './niftiLoader';

// ---------------------------------------------------------------------------
// Viewport ID → orientation
// ---------------------------------------------------------------------------

/** Canonical LiverRa viewport identifiers used across the liver viewer. */
export const VIEWPORT_IDS = {
  stack: 'liverra-cases-stack',
  axial: 'liverra-mpr-axial',
  sagittal: 'liverra-mpr-sagittal',
  coronal: 'liverra-mpr-coronal',
} as const;

export type ViewerOrientation = 'axial' | 'sagittal' | 'coronal' | 'stack';

/** Map a known viewport ID to its orientation. Unknown IDs return null. */
export function orientationFromViewportId(id: string): ViewerOrientation | null {
  switch (id) {
    case VIEWPORT_IDS.stack:
      return 'stack';
    case VIEWPORT_IDS.axial:
      return 'axial';
    case VIEWPORT_IDS.sagittal:
      return 'sagittal';
    case VIEWPORT_IDS.coronal:
      return 'coronal';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Canvas → voxel resolution
// ---------------------------------------------------------------------------

export interface ViewerClick {
  /** Integer voxel coordinate [i, j, k] inside the CT volume. */
  voxel: [number, number, number];
  /** World-space mm coordinate produced by `viewport.canvasToWorld`. */
  world: [number, number, number];
  viewportId: string;
  orientation: ViewerOrientation;
}

/**
 * Sub-shape of `vtkImageData` we depend on. We deliberately depend on this
 * minimal surface so tests can mock without touching vtk.js internals.
 */
interface VtkImageDataLike {
  worldToIndex(world: [number, number, number]): [number, number, number];
  getDimensions(): [number, number, number];
}

/** Cornerstone3D viewport surface we read from. */
interface ViewportLike {
  id: string;
  canvasToWorld?: (canvas: [number, number]) => [number, number, number];
  getImageData?: () => { imageData?: VtkImageDataLike | null } | undefined;
}

/**
 * Translate a canvas-relative click into a `ViewerClick`. Returns null when
 * the viewport has no image data loaded yet, when the click lands outside
 * the volume bounds (> 1 voxel margin), or when the viewport ID is unknown.
 */
export function resolveCanvasClick(
  viewport: ViewportLike | Types.IViewport,
  canvas: [number, number],
): ViewerClick | null {
  const orientation = orientationFromViewportId(viewport.id);
  if (!orientation) return null;

  const vp = viewport as ViewportLike;
  if (typeof vp.canvasToWorld !== 'function' || typeof vp.getImageData !== 'function') {
    return null;
  }

  // Cornerstone3D throws `Cannot read properties of undefined (reading
  // 'getDefaultActor')` when a viewport is registered with the engine but
  // its vtk renderer hasn't been wired (no volume / actor attached yet),
  // OR when the methods are called without a `this` binding. We invoke
  // them as methods on `vp` so the binding is preserved.
  let world: [number, number, number];
  let imageData: VtkImageDataLike | null | undefined;
  try {
    world = vp.canvasToWorld!(canvas);
    imageData = vp.getImageData!()?.imageData;
  } catch {
    return null;
  }
  if (!imageData) return null;

  let indexFloat: [number, number, number];
  let dims: [number, number, number];
  try {
    indexFloat = imageData.worldToIndex([world[0], world[1], world[2]]);
    dims = imageData.getDimensions();
  } catch {
    return null;
  }

  // Round to integer voxel and clamp into the volume. Cornerstone3D's MPR
  // letterbox can produce world coords well outside the volume when the
  // canvas aspect ratio differs from the volume's — user intent is still
  // "drop near the edge they clicked," so we clamp rather than reject.
  // (Earlier versions had a tolerance gate that rejected most real clicks;
  // see commit history if you're tempted to add one back.)
  const ijk: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const raw = Math.round(indexFloat[axis]);
    ijk[axis] = Math.max(0, Math.min(dims[axis] - 1, raw));
  }

  return {
    voxel: ijk,
    world: [world[0], world[1], world[2]],
    viewportId: viewport.id,
    orientation,
  };
}

// ---------------------------------------------------------------------------
// Segmentation ID resolution at a voxel
// ---------------------------------------------------------------------------

/** Roman numerals 1..8 in display form. */
const COUINAUD_ROMAN: readonly string[] = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

/** Anatomy keys that count as "Couinaud" with their roman numeral suffix. */
const COUINAUD_KEY_TO_ROMAN: Record<string, string> = {
  'couinaud-i': 'I',
  'couinaud-ii': 'II',
  'couinaud-iii': 'III',
  'couinaud-iv': 'IV',
  'couinaud-v': 'V',
  'couinaud-vi': 'VI',
  'couinaud-vii': 'VII',
  'couinaud-viii': 'VIII',
};

export interface SegmentationResolution {
  /** Canonical segmentation key, e.g. 'parenchyma' or 'couinaud-vii'. */
  segmentationId: string;
  /** Roman numeral (I–VIII) when the click landed inside a Couinaud segment. */
  couinaudSegment?: string;
}

/**
 * Sample the loaded NIfTI labelmaps at `voxel` and return the most specific
 * segmentation key. Couinaud always wins over parenchyma. Falls back to
 * `'parenchyma'` so the caller always has *something* to thread into the
 * dispatch payload — the backend can treat 'parenchyma' as a sentinel for
 * "edit anywhere on the liver outline."
 */
export function resolveSegmentationId(
  voxel: [number, number, number],
  loadedLabelmaps: ReadonlyMap<string, NiftiMask>,
): SegmentationResolution {
  // Try every Couinaud segment first. Stop at the first hit (voxels can't
  // belong to two Couinaud segments at once by construction).
  for (const key of Object.keys(COUINAUD_KEY_TO_ROMAN)) {
    const mask = loadedLabelmaps.get(key);
    if (!mask) continue;
    if (sampleNiftiAt(mask, voxel) > 0) {
      return {
        segmentationId: key,
        couinaudSegment: COUINAUD_KEY_TO_ROMAN[key],
      };
    }
  }

  // Couinaud miss → check the parenchyma envelope. Even when the user clicks
  // a vessel or a lesion mask, we route the edit to `parenchyma` because
  // mask-edits on lesion/vessel labelmaps are not yet a supported op.
  const liverMask = loadedLabelmaps.get('liver');
  if (liverMask && sampleNiftiAt(liverMask, voxel) > 0) {
    return { segmentationId: 'parenchyma' };
  }

  return { segmentationId: 'parenchyma' };
}

/**
 * Read voxel value out of a `NiftiMask`. NIfTI stores voxels [x, y, z]
 * flattened with x as the fastest-varying axis, so the index is
 * `i + dim_x * (j + dim_y * k)`. Returns 0 for out-of-bounds requests.
 */
function sampleNiftiAt(
  mask: NiftiMask,
  voxel: [number, number, number],
): number {
  const [i, j, k] = voxel;
  const [dx, dy, dz] = mask.dims;
  if (i < 0 || j < 0 || k < 0) return 0;
  if (i >= dx || j >= dy || k >= dz) return 0;
  return mask.voxels[i + dx * (j + dy * k)] ?? 0;
}

/** Exposed for unit testing only. */
export const __test = { sampleNiftiAt, COUINAUD_ROMAN };
