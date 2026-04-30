// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Image Filter Service — CPU-based convolution for sharpening and smoothing
// ============================================================================
// Applies 3×3 convolution kernels to medical image pixel data. A convolution
// kernel is a 3×3 grid of weights — it slides over each pixel, multiplies the
// pixel and its 8 neighbours by the kernel weights, sums the results, and
// writes the output to a new array. Different weight patterns create different
// effects:
//
//   Sharpen: Boosts the center pixel and subtracts neighbours → edges pop out
//   Smooth:  Averages the pixel with its neighbours → noise is reduced
//
// Edge pixels use nearest-neighbour padding (repeat the edge value) instead
// of zero-padding, which prevents dark borders around the image.
//
// Performance target: under 5ms for a 512×512 image. Achieved by using typed
// arrays and avoiding any per-pixel object allocations in the inner loop.
//
// Ported from MediMind (services/pacs/imageFilterService.ts). No Medplum.
// ============================================================================

// ============================================================================
// Types
// ============================================================================

/** Pixel data types accepted by the filter functions */
type PixelArray = Float32Array | Uint8Array | Int16Array | Uint16Array;

/** Built-in filter types */
export type FilterType = 'sharpen' | 'smooth';

/** Strength levels for filters */
export type FilterStrength = 'light' | 'medium' | 'strong';

/** A filter configuration combining type and strength */
export interface FilterConfig {
  type: FilterType;
  strength: FilterStrength;
}

// ============================================================================
// Kernels
// ============================================================================

/**
 * Get a 3×3 sharpen kernel with the given strength.
 *
 * The sharpen kernel subtracts surrounding pixel values from an amplified
 * center value — like turning up the contrast around every edge.
 *
 * Light:  center=3, edges=-0.5  (subtle)
 * Medium: center=5, edges=-1    (standard)
 * Strong: center=7, edges=-1.5  (aggressive)
 */
export function getSharpenKernel(strength: FilterStrength): number[] {
  switch (strength) {
    case 'light':
      return [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0];
    case 'medium':
      return [0, -1, 0, -1, 5, -1, 0, -1, 0];
    case 'strong':
      return [0, -1.5, 0, -1.5, 7, -1.5, 0, -1.5, 0];
  }
}

/**
 * Get a 3×3 smooth (box blur) kernel.
 *
 * All weights are equal (1/9) — each pixel becomes the average of itself and
 * its 8 neighbours. This acts like looking through frosted glass.
 *
 * Strength is controlled by the number of passes:
 *   Light:  1 pass
 *   Medium: 2 passes (smooth the smooth)
 *   Strong: 3 passes (very blurred)
 */
export function getSmoothKernel(): number[] {
  const v = 1 / 9;
  return [v, v, v, v, v, v, v, v, v];
}

/**
 * Get the number of convolution passes for a smooth filter at the given strength.
 */
export function getSmoothPasses(strength: FilterStrength): number {
  switch (strength) {
    case 'light':
      return 1;
    case 'medium':
      return 2;
    case 'strong':
      return 3;
  }
}

// ============================================================================
// Core Convolution
// ============================================================================

/**
 * Apply a 3×3 convolution kernel to greyscale pixel data.
 *
 * @param pixelData - Input pixel values (1D array, row-major)
 * @param width     - Image width in pixels
 * @param height    - Image height in pixels
 * @param kernel    - 9-element array of kernel weights (row-major 3×3)
 * @returns New Float32Array with the filtered pixel values
 *
 * Edge handling: Nearest-neighbour padding — pixels at the border repeat
 * the edge value rather than using zero, so the image edges don't darken.
 *
 * Performance: Uses typed arrays, inline index clamping, and no per-pixel
 * allocations. Targets under 5ms for 512×512.
 */
export function applyConvolution(
  pixelData: PixelArray,
  width: number,
  height: number,
  kernel: number[]
): Float32Array {
  const len = width * height;
  const out = new Float32Array(len);

  // Kernel weights — extracted into locals to avoid repeated array lookups
  const k0 = kernel[0], k1 = kernel[1], k2 = kernel[2];
  const k3 = kernel[3], k4 = kernel[4], k5 = kernel[5];
  const k6 = kernel[6], k7 = kernel[7], k8 = kernel[8];

  const maxX = width - 1;
  const maxY = height - 1;

  for (let y = 0; y < height; y++) {
    // Clamp y neighbours to image bounds (nearest-neighbour padding)
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < maxY ? y + 1 : maxY;

    const rowY = y * width;
    const rowYm = ym * width;
    const rowYp = yp * width;

    for (let x = 0; x < width; x++) {
      // Clamp x neighbours to image bounds
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < maxX ? x + 1 : maxX;

      // Sum the 3×3 neighbourhood weighted by the kernel
      out[rowY + x] =
        k0 * pixelData[rowYm + xm] + k1 * pixelData[rowYm + x] + k2 * pixelData[rowYm + xp] +
        k3 * pixelData[rowY  + xm] + k4 * pixelData[rowY  + x] + k5 * pixelData[rowY  + xp] +
        k6 * pixelData[rowYp + xm] + k7 * pixelData[rowYp + x] + k8 * pixelData[rowYp + xp];
    }
  }

  return out;
}

// ============================================================================
// High-Level Filter API
// ============================================================================

/**
 * Apply a named filter (sharpen or smooth) at the specified strength.
 *
 * For sharpen: applies one pass with a strength-scaled kernel.
 * For smooth: applies multiple passes of a box blur kernel.
 *
 * @param pixelData - Input pixel values
 * @param width     - Image width
 * @param height    - Image height
 * @param config    - Which filter type and strength to apply
 * @returns New Float32Array with filtered values
 */
export function applyFilter(
  pixelData: PixelArray,
  width: number,
  height: number,
  config: FilterConfig
): Float32Array {
  if (config.type === 'sharpen') {
    const kernel = getSharpenKernel(config.strength);
    return applyConvolution(pixelData, width, height, kernel);
  }

  // Smooth — multiple passes
  const kernel = getSmoothKernel();
  const passes = getSmoothPasses(config.strength);

  let current: PixelArray = pixelData;
  let result: Float32Array = new Float32Array(0);

  for (let i = 0; i < passes; i++) {
    result = applyConvolution(current, width, height, kernel);
    current = result;
  }

  return result;
}
