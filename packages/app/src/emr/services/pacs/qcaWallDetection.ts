// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// QCA Wall Detection — Vessel wall edge detection along perpendicular profiles
// ============================================================================
// At each point on the vessel centerline, we look left and right perpendicular
// to the vessel direction and sample brightness values. Where brightness drops
// sharply (the steepest gradient) is the vessel wall. The distance between the
// left and right walls gives us the vessel diameter at that point.
//
// Think of it like measuring the width of a road: walk along the center line,
// and at each step hold a ruler across the road. The edges of the pavement
// (where brightness changes) tell you how wide the road is.
// ============================================================================

import type { Point } from './qcaCenterline';
import type { PixelArray } from './qcaImageProcessing';

// ============================================================================
// Types
// ============================================================================

/** A single wall measurement at one centerline point. */
export interface WallPoint {
  /** Left wall position in image coordinates */
  left: Point;
  /** Right wall position in image coordinates */
  right: Point;
  /** Distance between left and right walls in pixels */
  diameter: number;
}

/** Full wall detection result for the entire centerline. */
export interface WallDetectionResult {
  /** One WallPoint per centerline point */
  walls: WallPoint[];
  /** Diameter at each centerline point (pixels) — same as walls[i].diameter */
  diameters: number[];
}

const MIN_EDGE_GRADIENT = 8;

// ============================================================================
// Bilinear Sampling Helper
// ============================================================================

/**
 * Read a pixel value with bilinear interpolation for sub-pixel accuracy.
 * Coordinates are clamped to image bounds so out-of-range positions return
 * the nearest edge pixel value.
 */
function sampleBilinear(pixels: PixelArray, x: number, y: number, w: number, h: number): number {
  const cx = Math.max(0, Math.min(x, w - 1));
  const cy = Math.max(0, Math.min(y, h - 1));

  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);

  const fx = cx - x0;
  const fy = cy - y0;

  const v00 = pixels[y0 * w + x0];
  const v10 = pixels[y0 * w + x1];
  const v01 = pixels[y1 * w + x0];
  const v11 = pixels[y1 * w + x1];

  return v00 * (1 - fx) * (1 - fy) +
         v10 * fx * (1 - fy) +
         v01 * (1 - fx) * fy +
         v11 * fx * fy;
}

// ============================================================================
// sampleProfile — Intensity values along a perpendicular line
// ============================================================================

/**
 * Sample intensity values along a line centered at `center` in the direction
 * of `normal`, extending `radius` pixels on each side.
 *
 * Returns an array of `2 * radius + 1` values. Index 0 is the far-left
 * sample (center - normal * radius), the middle index is the center itself,
 * and the last index is the far-right sample (center + normal * radius).
 */
export function sampleProfile(
  pixels: PixelArray,
  center: Point,
  normal: Point,
  radius: number,
  w: number,
  h: number
): number[] {
  const count = 2 * radius + 1;
  const profile: number[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const t = i - radius; // ranges from -radius to +radius
    const px = center.x + normal.x * t;
    const py = center.y + normal.y * t;
    profile[i] = sampleBilinear(pixels, px, py, w, h);
  }

  return profile;
}

// ============================================================================
// findEdge — Locate the steepest gradient in a 1D profile
// ============================================================================

/**
 * Find the edge location in a 1D intensity profile by looking for the
 * steepest gradient (largest absolute change between adjacent samples).
 *
 * - `'left'` searches from the center toward index 0 (left wall).
 * - `'right'` searches from the center toward the end (right wall).
 *
 * A minimum threshold filters out low-contrast profiles. Returns the index of
 * the detected edge, or null when no meaningful edge is present.
 */
export function findEdge(profile: number[], side: 'left' | 'right'): number | null {
  const mid = Math.floor(profile.length / 2);

  // Compute gradient (absolute first derivative) for the entire profile
  const grad: number[] = new Array(profile.length).fill(0);
  let maxGrad = 0;
  for (let i = 1; i < profile.length; i++) {
    grad[i] = Math.abs(profile[i] - profile[i - 1]);
    if (grad[i] > maxGrad) {
      maxGrad = grad[i];
    }
  }

  if (maxGrad < MIN_EDGE_GRADIENT) {
    return null;
  }

  const threshold = Math.max(MIN_EDGE_GRADIENT, maxGrad * 0.1);

  if (side === 'left') {
    // Search from center toward the left, find max gradient
    let bestIdx: number | null = null;
    let bestGrad = 0;
    for (let i = mid; i >= 1; i--) {
      if (grad[i] > bestGrad && grad[i] >= threshold) {
        bestGrad = grad[i];
        bestIdx = i;
      }
    }
    return bestIdx;
  } else {
    // Search from center toward the right, find max gradient
    let bestIdx: number | null = null;
    let bestGrad = 0;
    for (let i = mid + 1; i < profile.length; i++) {
      if (grad[i] > bestGrad && grad[i] >= threshold) {
        bestGrad = grad[i];
        bestIdx = i;
      }
    }
    return bestIdx;
  }
}

// ============================================================================
// detectWalls — Full wall detection along the centerline
// ============================================================================

/**
 * Detect vessel walls at every point along the centerline.
 *
 * For each centerline point:
 * 1. Compute the tangent direction (which way the vessel is going)
 * 2. Compute the normal (perpendicular to the tangent)
 * 3. Sample a brightness profile along the normal
 * 4. Find the left and right edges (steepest brightness drop)
 * 5. Convert edge positions back to image coordinates
 *
 * @param centerline - Ordered array of points along the vessel center
 * @param pixels - Greyscale image pixel data (flat array, row-major)
 * @param w - Image width
 * @param h - Image height
 * @param searchRadius - How far (in pixels) to search on each side of the centerline
 */
export function detectWalls(
  centerline: Point[],
  pixels: PixelArray,
  w: number,
  h: number,
  searchRadius = 30
): WallDetectionResult {
  const walls: WallPoint[] = [];
  const diameters: number[] = [];
  const validIndexes: number[] = [];

  for (let i = 0; i < centerline.length; i++) {
    const pt = centerline[i];

    // --- Step 1: Compute tangent using central, forward, or backward diff ---
    let tx: number;
    let ty: number;
    if (i === 0) {
      tx = centerline[1].x - centerline[0].x;
      ty = centerline[1].y - centerline[0].y;
    } else if (i === centerline.length - 1) {
      tx = centerline[i].x - centerline[i - 1].x;
      ty = centerline[i].y - centerline[i - 1].y;
    } else {
      tx = centerline[i + 1].x - centerline[i - 1].x;
      ty = centerline[i + 1].y - centerline[i - 1].y;
    }

    // Normalize tangent
    const tLen = Math.sqrt(tx * tx + ty * ty);
    if (tLen > 0) {
      tx /= tLen;
      ty /= tLen;
    } else {
      tx = 1;
      ty = 0;
    }

    // --- Step 2: Normal is perpendicular to tangent ---
    const normal: Point = { x: -ty, y: tx };

    // --- Step 3: Sample intensity profile ---
    const profile = sampleProfile(pixels, pt, normal, searchRadius, w, h);

    // --- Step 4: Find left and right edges ---
    const leftIdx = findEdge(profile, 'left');
    const rightIdx = findEdge(profile, 'right');
    if (leftIdx === null || rightIdx === null || rightIdx <= leftIdx) {
      continue;
    }

    // --- Step 5: Convert indices back to image coordinates ---
    const leftOffset = leftIdx - searchRadius;
    const rightOffset = rightIdx - searchRadius;

    const leftPt: Point = {
      x: pt.x + normal.x * leftOffset,
      y: pt.y + normal.y * leftOffset,
    };
    const rightPt: Point = {
      x: pt.x + normal.x * rightOffset,
      y: pt.y + normal.y * rightOffset,
    };

    // --- Step 6: Diameter = distance between walls ---
    const dx = rightPt.x - leftPt.x;
    const dy = rightPt.y - leftPt.y;
    const diameter = Math.sqrt(dx * dx + dy * dy);

    walls.push({ left: leftPt, right: rightPt, diameter });
    diameters.push(diameter);
    validIndexes.push(i);
  }

  const minValidCount = centerline.length <= 5 ? centerline.length : Math.max(6, Math.floor(centerline.length * 0.5));
  const centralStart = Math.floor(centerline.length * 0.25);
  const centralEnd = Math.ceil(centerline.length * 0.75);
  const centralLength = Math.max(0, centralEnd - centralStart);
  const centralValidCount = validIndexes.filter((idx) => idx >= centralStart && idx < centralEnd).length;
  const minCentralValidCount = centralLength <= 5 ? centralLength : Math.max(3, Math.floor(centralLength * 0.5));
  if (walls.length < minValidCount || centralValidCount < minCentralValidCount) {
    throw new Error(
      `QCA wall detection failed: ${walls.length}/${centerline.length} valid wall pairs, ${centralValidCount}/${centralLength} central pairs`
    );
  }

  return { walls, diameters };
}
