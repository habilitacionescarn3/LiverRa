// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// TODO(audit LAB-L5): add focused tests for runQCA — synthetic 256x256 fixture
// with a known straight-vessel pattern + ground-truth diameter, plus error-path
// coverage (path-too-short, validation failures). Pipeline is heavy on image
// processing and needs careful fixture design rather than a quick happy-path test.

// ============================================================================
// QCA Orchestrator — Single entry point for the full QCA analysis pipeline
// ============================================================================
// Chains all four QCA steps into one call: the user clicks two points on a
// vessel, and this function returns a complete stenosis analysis. Like pressing
// "Analyze" on the QCA tool — it handles blur, edge detection, pathfinding,
// wall measurement, and clinical metric computation in sequence.
// ============================================================================

import { gaussianBlur3x3, sobelGradient, buildCostImage } from './qcaImageProcessing';
import { dijkstraCenterline, smoothCenterline, resampleCenterline } from './qcaCenterline';
import { detectWalls } from './qcaWallDetection';
import { computeQCAResults } from './qcaMeasurements';

import type { PixelArray } from './qcaImageProcessing';
import type { Point } from './qcaCenterline';
import type { QCAResult, QCAError } from './qcaMeasurements';

// ============================================================================
// Re-exports for convenience — consumers only need to import from qcaService
// ============================================================================

export type { QCAResult, QCAError } from './qcaMeasurements';
export type { Point } from './qcaCenterline';

export type QCAErrorCode =
  | 'invalidImageDimensions'
  | 'invalidCalibration'
  | 'startPointOutOfBounds'
  | 'endPointOutOfBounds'
  | 'pathTooShort'
  | 'pipelineFailed';

export interface QCARunError extends QCAError {
  code: QCAErrorCode;
}

// ============================================================================
// Input Validation
// ============================================================================

function validateInputs(
  w: number,
  h: number,
  startPoint: Point,
  endPoint: Point,
  mmPerPixel: number
): QCARunError | null {
  if (w <= 0 || h <= 0) {
    return { success: false as const, code: 'invalidImageDimensions', message: `Invalid image dimensions: ${w}x${h}` };
  }
  if (mmPerPixel <= 0) {
    return { success: false as const, code: 'invalidCalibration', message: `Invalid calibration: mmPerPixel must be > 0, got ${mmPerPixel}` };
  }
  if (startPoint.x < 0 || startPoint.x >= w || startPoint.y < 0 || startPoint.y >= h) {
    return { success: false as const, code: 'startPointOutOfBounds', message: `Start point (${startPoint.x}, ${startPoint.y}) is outside image bounds (${w}x${h})` };
  }
  if (endPoint.x < 0 || endPoint.x >= w || endPoint.y < 0 || endPoint.y >= h) {
    return { success: false as const, code: 'endPointOutOfBounds', message: `End point (${endPoint.x}, ${endPoint.y}) is outside image bounds (${w}x${h})` };
  }
  return null;
}

// ============================================================================
// Pipeline Orchestrator
// ============================================================================

/**
 * Run the full QCA analysis pipeline on a greyscale angiogram image.
 *
 * @param pixelData  - Flat greyscale pixel array (row-major, length = w * h)
 * @param w          - Image width in pixels
 * @param h          - Image height in pixels
 * @param startPoint - Proximal point clicked by the user (integer pixel coords)
 * @param endPoint   - Distal point clicked by the user (integer pixel coords)
 * @param mmPerPixel - Calibration factor (millimeters per pixel)
 * @param vesselsAreBright - Display polarity of the lumen. Standard XA shows
 *   vessels DARK (default `false`); MONOCHROME1 or a viewport-inverted study
 *   shows them bright. Threaded into the centerline cost map so the tracer
 *   follows the lumen regardless of polarity.
 * @returns QCAResult with clinical metrics, or QCAError if something went wrong
 */
export function runQCA(
  pixelData: PixelArray,
  w: number,
  h: number,
  startPoint: Point,
  endPoint: Point,
  mmPerPixel: number,
  vesselsAreBright = false
): QCAResult | QCARunError {
  try {
    const startTime = performance.now();

    // --- Validate inputs ---
    const validationError = validateInputs(w, h, startPoint, endPoint, mmPerPixel);
    if (validationError) {
      return validationError;
    }

    // --- Step 1: Gaussian blur — reduce noise ---
    const blurred = gaussianBlur3x3(pixelData, w, h);

    // --- Step 2: Sobel gradient — detect edges ---
    const gradient = sobelGradient(blurred, w, h);

    // --- Step 3: Build cost image for pathfinding ---
    const costImage = buildCostImage(blurred, gradient.magnitude, w, h, vesselsAreBright);

    // --- Step 4: Dijkstra pathfinding — trace vessel centerline ---
    const rawPath = dijkstraCenterline(costImage, w, h, startPoint, endPoint);

    if (rawPath.length <= 5) {
      return { success: false as const, code: 'pathTooShort', message: `Path too short (${rawPath.length} points). Ensure points are on a visible vessel.` };
    }

    // --- Step 5: Smooth and resample centerline ---
    const smoothed = smoothCenterline(rawPath, 5);
    const resampled = resampleCenterline(smoothed, 2.0);

    // --- Step 6: Detect vessel walls ---
    const wallResult = detectWalls(resampled, blurred, w, h, 30);

    // --- Step 7: Compute clinical metrics ---
    const result = computeQCAResults(wallResult, resampled, mmPerPixel);
    result.computeTimeMs = performance.now() - startTime;

    return result;
  } catch (error) {
    console.warn('[qcaService] best-effort PACS operation failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown QCA pipeline error';
    return { success: false as const, code: 'pipelineFailed', message: `QCA pipeline failed: ${message}` };
  }
}
