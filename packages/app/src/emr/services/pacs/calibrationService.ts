// SPDX-License-Identifier: Apache-2.0

import type { LiverRaFhirClient, FhirResourceLike } from '../fhirClient';
import { updateWithIfMatch } from '../../utils/optimisticLocking';

// ============================================================================
// Calibration Service — French catheter-based pixel-to-mm calibration
// ============================================================================
// (Ported from MediMind; adapted: MedplumClient → LiverRaFhirClient, the
// `requirePermission(medplum, 'manage-imaging')` gate dropped — LiverRa
// guards viewer mutations at the route/permission-context level.)
//
// In angiography (XA) images, doctors need to measure real-world sizes of
// vessels and structures. Since pixel size varies by zoom/distance, we need a
// reference object of known size. French catheters (5F-8F) are commonly
// visible in these images and have standardised diameters:
//   French / 3 = diameter in mm  (e.g. 6F = 2.0 mm)
//
// Workflow:
//   1. User draws a line across the catheter in the image (gives pixelLength)
//   2. User selects the French size (5/6/7/8)
//   3. calculateCalibration() returns mmPerPixel factor
//   4. All subsequent measurements use convertPixelsToMm() with that factor
// ============================================================================

// ============================================================================
// Types
// ============================================================================

/** Minimal FHIR Basic shape for the calibration carrier resource. */
interface Basic extends FhirResourceLike {
  resourceType: 'Basic';
  meta?: { versionId?: string };
}

/** Result of a calibration calculation */
export interface CalibrationResult {
  /** French size used for calibration (5, 6, 7, or 8) */
  frenchSize: number;
  /** Known diameter in mm for the chosen French size */
  knownDiameterMm: number;
  /** Pixel length drawn by the user across the catheter */
  pixelLength: number;
  /** Conversion factor: multiply pixel measurements by this to get mm */
  mmPerPixel: number;
  /** Timestamp of when the calibration was performed */
  calibratedAt: Date;
}

/** Custom error for calibration failures */
export class CalibrationError extends Error {
  override name = 'CalibrationError' as const;

  constructor(message: string) {
    super(message);
  }
}

// ============================================================================
// Constants
// ============================================================================

/**
 * French catheter sizes mapped to their diameter in mm.
 * Formula: French / 3 = diameter in mm
 */
export const FRENCH_SIZES: Record<number, number> = {
  5: 1.667,
  6: 2.0,
  7: 2.333,
  8: 2.667,
};

// ============================================================================
// Functions
// ============================================================================

/**
 * Calculate a pixel-to-mm calibration factor using a French catheter reference.
 *
 * @param frenchSize - The French size of the catheter visible in the image (5, 6, 7, or 8)
 * @param pixelLength - The length (in pixels) the user drew across the catheter diameter
 * @returns CalibrationResult with the mmPerPixel conversion factor
 * @throws CalibrationError if frenchSize is unsupported or pixelLength is not positive
 */
export function calculateCalibration(frenchSize: number, pixelLength: number): CalibrationResult {
  const knownDiameterMm = FRENCH_SIZES[frenchSize];

  if (knownDiameterMm === undefined) {
    throw new CalibrationError('Unsupported French size');
  }

  if (pixelLength <= 0) {
    throw new CalibrationError('Pixel length must be positive');
  }

  const mmPerPixel = knownDiameterMm / pixelLength;

  return {
    frenchSize,
    knownDiameterMm,
    pixelLength,
    mmPerPixel,
    calibratedAt: new Date(),
  };
}

/**
 * Convert a pixel measurement to millimetres using a calibration factor.
 *
 * @param pixelValue - The measurement in pixels to convert
 * @param mmPerPixel - The calibration factor from calculateCalibration()
 * @returns The measurement in millimetres
 * @throws CalibrationError if mmPerPixel is not positive
 */
export function convertPixelsToMm(pixelValue: number, mmPerPixel: number): number {
  if (!Number.isFinite(pixelValue) || !Number.isFinite(mmPerPixel)) {
    throw new CalibrationError('Invalid input: pixelValue and mmPerPixel must be finite numbers');
  }
  if (mmPerPixel <= 0) {
    throw new CalibrationError('Invalid calibration factor');
  }

  return pixelValue * mmPerPixel;
}

// ============================================================================
// FHIR Persistence — create/update of the per-study Basic carrier
// ============================================================================

/**
 * Persist (create or update) the calibration carrier `Basic` resource on the
 * FHIR server.
 *
 * If `basic.id` is set, the existing resource is updated via optimistic
 * locking (`If-Match` on `meta.versionId`). Otherwise a fresh resource is
 * created. Returns the persisted resource so callers can refresh their refs.
 */
export async function saveCalibration(fhir: LiverRaFhirClient, basic: Basic): Promise<Basic> {
  if (basic.id) {
    return updateWithIfMatch<Basic>(fhir, basic);
  }
  return fhir.createResource<Basic>(basic);
}
