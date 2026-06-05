// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// DSA Service — CPU-based Digital Subtraction Angiography
// ============================================================================
// Digital Subtraction Angiography (DSA) highlights blood vessels by subtracting
// a "mask" frame (taken before contrast injection) from "live" frames (taken
// after contrast). The result shows only the contrast-filled vessels against
// a neutral background — like removing a room's wallpaper to see only what's
// painted underneath.
//
// Cornerstone3D has no built-in DSA, so we implement CPU pixel subtraction:
//   output[x,y] = live[x,y] - mask[x+shiftX, y+shiftY]
//
// The optional shift (shiftX, shiftY) compensates for patient motion between
// mask and live frames — a simple pixel-level registration correction.
// ============================================================================

// ============================================================================
// Types
// ============================================================================

/** Typed array types accepted for pixel data */
type PixelArray = Float32Array | Uint8Array | Uint16Array | Int16Array;

// ============================================================================
// Constants
// ============================================================================

export interface DsaPixelMetadata {
  bitsStored?: number;
  pixelRepresentation?: 0 | 1;
  rescaleSlope?: number;
  rescaleIntercept?: number;
}

function deriveStoredRange(pixelData: PixelArray, metadata?: DsaPixelMetadata): { min: number; max: number } {
  const slope = metadata?.rescaleSlope ?? 1;
  const intercept = metadata?.rescaleIntercept ?? 0;
  let storedMin: number;
  let storedMax: number;

  if (metadata?.bitsStored !== undefined) {
    if (metadata.bitsStored <= 0 || metadata.bitsStored > 32) {
      throw new Error('[dsaService] Invalid BitsStored metadata for DSA subtraction');
    }
    if (metadata.pixelRepresentation === undefined) {
      throw new Error('[dsaService] Missing PixelRepresentation metadata for DSA subtraction');
    }
    if (metadata.pixelRepresentation === 1) {
      storedMin = -(2 ** (metadata.bitsStored - 1));
      storedMax = 2 ** (metadata.bitsStored - 1) - 1;
    } else {
      storedMin = 0;
      storedMax = 2 ** metadata.bitsStored - 1;
    }
  } else if (pixelData instanceof Uint8Array) {
    storedMin = 0;
    storedMax = 255;
  } else if (pixelData instanceof Uint16Array) {
    storedMin = 0;
    storedMax = 65535;
  } else if (pixelData instanceof Int16Array) {
    storedMin = -32768;
    storedMax = 32767;
  } else {
    throw new Error('[dsaService] Missing DICOM pixel range metadata for DSA subtraction');
  }

  const min = storedMin * slope + intercept;
  const max = storedMax * slope + intercept;
  return min <= max ? { min, max } : { min: max, max: min };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Verify both frames match expected dimensions.
 *
 * @param mask - Pixel data from the mask (pre-contrast) frame
 * @param live - Pixel data from the live (post-contrast) frame
 * @param width - Expected image width in pixels
 * @param height - Expected image height in pixels
 * @returns true if both arrays have exactly width * height elements
 */
export function validateFrameDimensions(
  mask: PixelArray,
  live: PixelArray,
  width: number,
  height: number
): boolean {
  const expectedLength = width * height;

  if (width <= 0 || height <= 0) {
    return false;
  }

  return mask.length === expectedLength && live.length === expectedLength;
}

// ============================================================================
// Core subtraction
// ============================================================================

/**
 * Subtract a mask frame from a live frame, producing a DSA result.
 *
 * For each pixel the output is: live[x,y] - mask[x+shiftX, y+shiftY],
 * range-checked from DICOM/Cornerstone pixel metadata. If the shifted mask
 * coordinate falls outside the image, the output pixel is neutral.
 *
 * Optimised for performance (<5ms on 512x512):
 * - Single tight loop with pre-computed row offsets
 * - Row-major traversal for CPU cache locality
 * - No per-pixel function calls
 *
 * @param maskPixelData - Pixel data from the mask (pre-contrast) frame
 * @param livePixelData - Pixel data from the live (post-contrast) frame
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param shiftX - Horizontal pixel shift for motion correction (default 0)
 * @param shiftY - Vertical pixel shift for motion correction (default 0)
 * @param metadata - DICOM pixel range metadata used for range-aware subtraction
 * @returns Float32Array of subtracted pixel values before display windowing
 */
export function subtractFrames(
  maskPixelData: PixelArray,
  livePixelData: PixelArray,
  width: number,
  height: number,
  shiftX = 0,
  shiftY = 0,
  metadata?: DsaPixelMetadata
): Float32Array {
  const totalPixels = width * height;
  const output = new Float32Array(totalPixels);
  const maskRange = deriveStoredRange(maskPixelData, metadata);
  const liveRange = deriveStoredRange(livePixelData, metadata);
  const outputMin = liveRange.min - maskRange.max;
  const outputMax = liveRange.max - maskRange.min;

  // Process row-by-row for cache locality
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    const maskY = y + shiftY;

    // If the entire mask row is out of bounds, mark it neutral; do not copy
    // live pixels into an invalid subtraction area.
    if (maskY < 0 || maskY >= height) {
      for (let x = 0; x < width; x++) {
        output[rowOffset + x] = Math.max(outputMin, Math.min(outputMax, 0));
      }
      continue;
    }

    const maskRowOffset = maskY * width;

    for (let x = 0; x < width; x++) {
      const liveVal = livePixelData[rowOffset + x];
      const maskX = x + shiftX;

      let diff: number;
      if (maskX < 0 || maskX >= width) {
        // Mask pixel out of bounds — neutral invalid subtraction area.
        diff = 0;
      } else {
        diff = liveVal - maskPixelData[maskRowOffset + maskX];
      }

      output[rowOffset + x] = Math.max(outputMin, Math.min(outputMax, diff));
    }
  }

  return output;
}

// ============================================================================
// Display conversion
// ============================================================================

/**
 * Convert subtracted pixel data to display-ready 8-bit grayscale.
 *
 * Applies a standard window/level transform:
 *   - Pixels below (center - width/2) → 0 (black)
 *   - Pixels above (center + width/2) → 255 (white)
 *   - Pixels in between → linearly mapped to 0–255
 *
 * @param subtracted - DSA-subtracted pixel data (from subtractFrames)
 * @param windowCenter - Center of the display window (brightness)
 * @param windowWidth - Width of the display window (contrast)
 * @returns Uint8ClampedArray of 8-bit grayscale values (0–255)
 */
export function applyWindowLevel(
  subtracted: Float32Array | Int16Array,
  windowCenter: number,
  windowWidth: number
): Uint8ClampedArray {
  const length = subtracted.length;
  const display = new Uint8ClampedArray(length);

  // Guard: zero or negative width would produce Infinity, corrupting the display
  if (windowWidth <= 0) {
    display.fill(128);
    return display;
  }

  // Pre-compute window boundaries
  const halfWidth = windowWidth / 2;
  const lower = windowCenter - halfWidth;
  const upper = windowCenter + halfWidth;
  const scale = 255 / windowWidth;

  for (let i = 0; i < length; i++) {
    const val = subtracted[i];

    if (val <= lower) {
      display[i] = 0;
    } else if (val >= upper) {
      display[i] = 255;
    } else {
      display[i] = ((val - lower) * scale) | 0; // Bitwise OR for fast floor
    }
  }

  return display;
}
