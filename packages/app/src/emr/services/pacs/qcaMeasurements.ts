// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// QCA Measurements — Clinical stenosis metrics from wall detection data
// ============================================================================
// Once we know the vessel wall positions and diameters along the centerline
// (from wall detection, Step 3), this module computes the clinical numbers
// that cardiologists care about:
//
//   - MLD  (Minimum Lumen Diameter)  — the narrowest point
//   - RVD  (Reference Vessel Diameter) — estimated "healthy" vessel size
//   - %DS  (Percent Diameter Stenosis) — how much narrower vs. normal
//   - %AS  (Percent Area Stenosis)     — assumes circular cross-section
//   - Lesion length — how long the narrowed segment is in mm
//
// Think of it like measuring a pinch in a garden hose: MLD is the pinch
// width, RVD is the normal hose width, and %DS tells you how much flow
// is restricted.
// ============================================================================

import type { Point } from './qcaCenterline';

// ============================================================================
// Types
// ============================================================================

/** A single wall measurement at one centerline point */
export interface WallPoint {
  left: Point;
  right: Point;
  diameter: number;
  centerlineIndex?: number;
}

/** A wall measurement aligned back to its original centerline point */
export interface AlignedWallMeasurement {
  centerlineIndex: number;
  left: Point;
  right: Point;
  diameter: number;
}

/** Full QCA measurement results */
export interface QCAResult {
  /** Minimum Lumen Diameter in mm */
  mld: number;
  /** Reference Vessel Diameter in mm (estimated normal) */
  rvd: number;
  /** Percent Diameter Stenosis: ((RVD - MLD) / RVD) × 100 */
  percentDS: number;
  /** Percent Area Stenosis: (1 - (MLD/RVD)²) × 100 */
  percentAS: number;
  /** Length of stenotic segment in mm */
  lesionLength: number;
  /** Index in aligned wall measurement arrays where MLD occurs */
  mldIndex: number;
  /** Original centerline index where MLD occurs */
  mldCenterlineIndex: number;
  /** Diameter in mm at each centerline point */
  diameters: number[];
  /** Centerline points (image coords) */
  centerline: Point[];
  /** Left wall contour points (image coords) */
  leftContour: Point[];
  /** Right wall contour points (image coords) */
  rightContour: Point[];
  /** Wall measurements aligned to their original centerline indexes */
  wallMeasurements: AlignedWallMeasurement[];
  /** Pipeline execution time (set by orchestrator) */
  computeTimeMs: number;
}

/** Error result when QCA pipeline fails */
export interface QCAError {
  success: false;
  message: string;
}

// ============================================================================
// MLD — Minimum Lumen Diameter
// ============================================================================

/** Find the smallest diameter and its position along the centerline. */
export function findMLD(diameters: number[]): { value: number; index: number } {
  let minVal = Infinity;
  let minIdx = 0;
  for (let i = 0; i < diameters.length; i++) {
    if (diameters[i] < minVal) {
      minVal = diameters[i];
      minIdx = i;
    }
  }
  return { value: minVal, index: minIdx };
}

// ============================================================================
// RVD — Reference Vessel Diameter
// ============================================================================

/**
 * Estimate the "normal" vessel diameter using healthy segments.
 *
 * Uses the MLD location to find the stenotic run, then samples nearby healthy
 * proximal/distal reference windows. If no healthy reference exists, throws so
 * the caller can fall back to manual reference selection instead of reporting a
 * misleading stenosis percentage.
 */
export function estimateRVD(diameters: number[], mldIndex: number): number {
  const n = diameters.length;
  // Sentinel: return 0 when no samples are available. Callers (computeQCAResults,
  // computeAreaStenosis) already guard against rvd <= 0 to avoid NaN stenosis %.
  if (n <= 0) { return 0; }
  const clampedMldIndex = Math.min(Math.max(Math.round(mldIndex), 0), n - 1);
  const sorted = [...diameters].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const healthyThreshold = Math.max(median, diameters[clampedMldIndex]) * 0.9;

  let lesionStart = clampedMldIndex;
  let lesionEnd = clampedMldIndex;
  while (lesionStart > 0 && diameters[lesionStart - 1] < healthyThreshold) {
    lesionStart--;
  }
  while (lesionEnd < n - 1 && diameters[lesionEnd + 1] < healthyThreshold) {
    lesionEnd++;
  }

  const windowSize = Math.max(3, Math.floor(n * 0.25));
  const proximal = diameters
    .slice(Math.max(0, lesionStart - windowSize), lesionStart)
    .filter((d) => d >= healthyThreshold);
  const distal = diameters
    .slice(lesionEnd + 1, Math.min(n, lesionEnd + 1 + windowSize))
    .filter((d) => d >= healthyThreshold);
  let references = [...proximal, ...distal];

  if (references.length < 3) {
    references = diameters.filter((d, i) => (i < lesionStart || i > lesionEnd) && d >= healthyThreshold);
  }
  if (references.length === 0) {
    throw new Error('QCA requires manual reference points: no healthy RVD reference segment found');
  }

  return references.reduce((a, b) => a + b, 0) / references.length;
}

// ============================================================================
// Lesion Length
// ============================================================================

/**
 * Compute the length of the stenotic (narrowed) segment in mm.
 *
 * The stenotic region is where diameter drops below 90% of RVD.
 * We find the contiguous segment containing the MLD point and
 * measure its arc length along the centerline.
 */
export function computeLesionLength(
  centerline: Point[],
  diameters: number[],
  rvd: number,
  mmPerPixel: number
): number {
  if (centerline.length === 0 || diameters.length === 0 || rvd <= 0) {
    return 0;
  }
  const sampleCount = Math.min(centerline.length, diameters.length);
  const threshold = 0.9 * rvd;
  const { index } = findMLD(diameters.slice(0, sampleCount));
  const mldIdx = Math.min(index, sampleCount - 1);
  if (diameters[mldIdx] >= threshold) {
    return 0;
  }

  // Expand outward from MLD to find stenotic region boundaries
  let start = mldIdx;
  let end = mldIdx;

  while (start > 0 && diameters[start - 1] < threshold) {
    start--;
  }
  while (end < sampleCount - 1 && diameters[end + 1] < threshold) {
    end++;
  }

  const cumulative = new Array<number>(sampleCount).fill(0);
  for (let i = 1; i < sampleCount; i++) {
    const dx = centerline[i].x - centerline[i - 1].x;
    const dy = centerline[i].y - centerline[i - 1].y;
    cumulative[i] = cumulative[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }

  const interpolateCrossing = (i: number, j: number): number => {
    const d0 = diameters[i];
    const d1 = diameters[j];
    if (d0 === d1) {
      return (cumulative[i] + cumulative[j]) / 2;
    }
    const fraction = Math.min(1, Math.max(0, (threshold - d0) / (d1 - d0)));
    return cumulative[i] + fraction * (cumulative[j] - cumulative[i]);
  };

  const startBoundary = start > 0 ? interpolateCrossing(start - 1, start) : cumulative[start];
  const endBoundary = end < sampleCount - 1 ? interpolateCrossing(end, end + 1) : cumulative[end];
  let length = Math.max(0, endBoundary - startBoundary);

  if (start === end) {
    const spacingBefore = start > 0 ? cumulative[start] - cumulative[start - 1] : 0;
    const spacingAfter = start < sampleCount - 1 ? cumulative[start + 1] - cumulative[start] : 0;
    const localSpacing = spacingBefore && spacingAfter
      ? (spacingBefore + spacingAfter) / 2
      : spacingBefore || spacingAfter || 1;
    length = Math.max(length, localSpacing);
  }

  return length * mmPerPixel;
}

// ============================================================================
// Area Stenosis
// ============================================================================

/** Percent area stenosis assuming circular cross-section. */
export function computeAreaStenosis(rvd: number, mld: number): number {
  if (rvd <= 0) { return 0; }
  const ratio = mld / rvd;
  return (1 - ratio * ratio) * 100;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/** Wall detection output shape (from Step 3) */
interface WallDetectionResult {
  walls: WallPoint[];
  diameters: number[];
}

function findClosestCenterlineIndex(wall: WallPoint, centerline: Point[], startIndex: number): number {
  const mid = {
    x: (wall.left.x + wall.right.x) / 2,
    y: (wall.left.y + wall.right.y) / 2,
  };
  let bestIndex = Math.min(Math.max(startIndex, 0), Math.max(centerline.length - 1, 0));
  let bestDistance = Infinity;
  for (let i = bestIndex; i < centerline.length; i++) {
    const dx = centerline[i].x - mid.x;
    const dy = centerline[i].y - mid.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function alignWallMeasurements(
  walls: WallDetectionResult,
  centerline: Point[],
  mmPerPixel: number
): AlignedWallMeasurement[] {
  const aligned: AlignedWallMeasurement[] = [];
  let nextSearchIndex = 0;

  for (let i = 0; i < walls.walls.length; i++) {
    const wall = walls.walls[i];
    const explicitIndex = wall.centerlineIndex;
    const centerlineIndex = explicitIndex !== undefined && explicitIndex >= 0 && explicitIndex < centerline.length
      ? explicitIndex
      : findClosestCenterlineIndex(wall, centerline, nextSearchIndex);
    nextSearchIndex = Math.min(centerlineIndex + 1, centerline.length);
    aligned.push({
      centerlineIndex,
      left: wall.left,
      right: wall.right,
      diameter: (walls.diameters[i] ?? wall.diameter) * mmPerPixel,
    });
  }

  return aligned;
}

/**
 * Compute all QCA clinical metrics from wall detection results.
 *
 * This chains together MLD, RVD, %DS, %AS, and lesion length into
 * a single QCAResult object ready for display.
 */
export function computeQCAResults(
  walls: WallDetectionResult,
  centerline: Point[],
  mmPerPixel: number
): QCAResult {
  const wallMeasurements = alignWallMeasurements(walls, centerline, mmPerPixel);
  if (wallMeasurements.length === 0) {
    throw new Error('QCA wall detection failed: no valid wall measurements');
  }
  const alignedCenterline = wallMeasurements
    .map((w) => centerline[w.centerlineIndex])
    .filter((point): point is Point => Boolean(point));
  const diameters = wallMeasurements.map((w) => w.diameter);

  const { value: mld, index: mldIndex } = findMLD(diameters);
  const rvd = estimateRVD(diameters, mldIndex);
  const percentDS = rvd > 0 ? ((rvd - mld) / rvd) * 100 : 0;
  const percentAS = computeAreaStenosis(rvd, mld);
  const lesionLength = computeLesionLength(alignedCenterline, diameters, rvd, mmPerPixel);

  // Build contour arrays from wall points
  const leftContour = wallMeasurements.map((w) => w.left);
  const rightContour = wallMeasurements.map((w) => w.right);

  return {
    mld,
    rvd,
    percentDS,
    percentAS,
    lesionLength,
    mldIndex,
    mldCenterlineIndex: wallMeasurements[mldIndex]?.centerlineIndex ?? mldIndex,
    diameters,
    centerline: alignedCenterline,
    leftContour,
    rightContour,
    wallMeasurements,
    computeTimeMs: 0, // Set by the orchestrator
  };
}
