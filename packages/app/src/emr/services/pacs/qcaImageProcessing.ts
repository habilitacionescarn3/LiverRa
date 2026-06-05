// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// QCA Image Processing — Low-level pixel math for coronary analysis
// ============================================================================
// Provides the image processing building blocks for Semi-Automatic QCA
// (Quantitative Coronary Analysis). Think of it as three steps:
//
//   1. Gaussian blur — smooths out pixel noise (like squinting at the image)
//   2. Sobel gradient — finds edges (where brightness changes sharply)
//   3. Cost image    — combines brightness and edges into a "path cost" map
//                      so Dijkstra can find the cheapest route along a vessel
//
// All functions use typed arrays and avoid per-pixel allocations for speed.
// ============================================================================

// ============================================================================
// Types
// ============================================================================

/** Pixel data types accepted by the processing functions */
export type PixelArray = Float32Array | Uint8Array | Int16Array | Uint16Array;

/** Result of Sobel gradient computation */
export interface GradientResult {
  /** Edge strength at each pixel — sqrt(gx² + gy²) */
  magnitude: Float32Array;
  /** Horizontal gradient component (positive = brighter to the right) */
  dx: Float32Array;
  /** Vertical gradient component (positive = brighter downward) */
  dy: Float32Array;
}

// ============================================================================
// Gaussian Blur
// ============================================================================

/**
 * Apply a 3×3 Gaussian blur to greyscale pixel data.
 *
 * The Gaussian kernel gives the most weight to the center pixel (4/16) and
 * less weight to neighbours — like averaging but keeping the original shape
 * better than a simple box blur.
 *
 * Kernel:  1/16  2/16  1/16
 *          2/16  4/16  2/16
 *          1/16  2/16  1/16
 *
 * Edge handling: nearest-neighbour padding (same as imageFilterService).
 */
export function gaussianBlur3x3(pixels: PixelArray, w: number, h: number): Float32Array {
  const len = w * h;
  const out = new Float32Array(len);

  // Kernel weights (row-major 3×3)
  const k0 = 1 / 16, k1 = 2 / 16, k2 = 1 / 16;
  const k3 = 2 / 16, k4 = 4 / 16, k5 = 2 / 16;
  const k6 = 1 / 16, k7 = 2 / 16, k8 = 1 / 16;

  const maxX = w - 1;
  const maxY = h - 1;

  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < maxY ? y + 1 : maxY;

    const rowY = y * w;
    const rowYm = ym * w;
    const rowYp = yp * w;

    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < maxX ? x + 1 : maxX;

      out[rowY + x] =
        k0 * pixels[rowYm + xm] + k1 * pixels[rowYm + x] + k2 * pixels[rowYm + xp] +
        k3 * pixels[rowY  + xm] + k4 * pixels[rowY  + x] + k5 * pixels[rowY  + xp] +
        k6 * pixels[rowYp + xm] + k7 * pixels[rowYp + x] + k8 * pixels[rowYp + xp];
    }
  }

  return out;
}

// ============================================================================
// Sobel Gradient
// ============================================================================

/**
 * Compute the Sobel gradient of greyscale pixel data.
 *
 * The Sobel operator detects edges by measuring how quickly brightness
 * changes in the horizontal (Gx) and vertical (Gy) directions — like
 * asking "is there a wall of contrast here?"
 *
 * Returns the magnitude (overall edge strength) plus the raw dx/dy
 * components, which are useful for finding edge direction.
 */
export function sobelGradient(pixels: PixelArray, w: number, h: number): GradientResult {
  const len = w * h;
  const magnitude = new Float32Array(len);
  const dx = new Float32Array(len);
  const dy = new Float32Array(len);

  const maxX = w - 1;
  const maxY = h - 1;

  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < maxY ? y + 1 : maxY;

    const rowY = y * w;
    const rowYm = ym * w;
    const rowYp = yp * w;

    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < maxX ? x + 1 : maxX;

      // Gx kernel: [-1, 0, 1, -2, 0, 2, -1, 0, 1]
      const gx =
        -1 * pixels[rowYm + xm] + 0 + 1 * pixels[rowYm + xp] +
        -2 * pixels[rowY  + xm] + 0 + 2 * pixels[rowY  + xp] +
        -1 * pixels[rowYp + xm] + 0 + 1 * pixels[rowYp + xp];

      // Gy kernel: [-1, -2, -1, 0, 0, 0, 1, 2, 1]
      const gy =
        -1 * pixels[rowYm + xm] + -2 * pixels[rowYm + x] + -1 * pixels[rowYm + xp] +
         0 +                        0 +                       0 +
         1 * pixels[rowYp + xm] +  2 * pixels[rowYp + x] +  1 * pixels[rowYp + xp];

      const idx = rowY + x;
      dx[idx] = gx;
      dy[idx] = gy;
      magnitude[idx] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  return { magnitude, dx, dy };
}

// ============================================================================
// Cost Image
// ============================================================================

/**
 * Build a cost image for Dijkstra-based vessel pathfinding.
 *
 * In coronary angiography (XA) the contrast agent makes vessels DARK on the
 * displayed image (low intensity), while vessel walls have HIGH gradient.
 * Centerline tracing should prefer the dark lumen's medial axis, so the lumen
 * intensity lowers cost while edge gradient raises it.
 *
 * Polarity is NOT fixed, though: a study stored MONOCHROME1, or one the user
 * has inverted in the viewport, presents vessels BRIGHT. The caller derives
 * `vesselsAreBright` from DICOM PhotometricInterpretation + viewport invert
 * state and passes it here. Default (`false`) matches standard XA — vessels
 * dark — so the safe path rewards dark pixels.
 */
export function buildCostImage(
  pixels: PixelArray,
  gradient: Float32Array,
  w: number,
  h: number,
  vesselsAreBright = false
): Float32Array {
  const len = w * h;
  const cost = new Float32Array(len);

  // Find intensity and gradient ranges for normalization
  let minIntensity = Infinity;
  let maxIntensity = -Infinity;
  let maxGradient = -Infinity;
  for (let i = 0; i < len; i++) {
    if (pixels[i] < minIntensity) { minIntensity = pixels[i]; }
    if (pixels[i] > maxIntensity) { maxIntensity = pixels[i]; }
    if (gradient[i] > maxGradient) { maxGradient = gradient[i]; }
  }

  const intensityRange = Math.max(1, maxIntensity - minIntensity);
  const gradientRange = Math.max(1, maxGradient);
  // The lumen is the brightest 55% when vessels are bright, else the darkest 55%.
  const maskThreshold = vesselsAreBright
    ? minIntensity + intensityRange * 0.45
    : minIntensity + intensityRange * 0.55;
  const isLumen = (value: number): boolean =>
    vesselsAreBright ? value >= maskThreshold : value <= maskThreshold;
  const dist = new Float32Array(len);
  const inf = w + h;
  let maskCount = 0;

  for (let i = 0; i < len; i++) {
    const inVessel = isLumen(pixels[i]);
    dist[i] = inVessel ? inf : 0;
    if (inVessel) {
      maskCount++;
    }
  }

  const useMask = maskCount > 0 && maskCount < len;
  if (useMask) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let best = dist[i];
        if (x > 0) { best = Math.min(best, dist[i - 1] + 1); }
        if (y > 0) { best = Math.min(best, dist[i - w] + 1); }
        if (x > 0 && y > 0) { best = Math.min(best, dist[i - w - 1] + 1.414); }
        if (x < w - 1 && y > 0) { best = Math.min(best, dist[i - w + 1] + 1.414); }
        dist[i] = best;
      }
    }

    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let best = dist[i];
        if (x < w - 1) { best = Math.min(best, dist[i + 1] + 1); }
        if (y < h - 1) { best = Math.min(best, dist[i + w] + 1); }
        if (x < w - 1 && y < h - 1) { best = Math.min(best, dist[i + w + 1] + 1.414); }
        if (x > 0 && y < h - 1) { best = Math.min(best, dist[i + w - 1] + 1.414); }
        dist[i] = best;
      }
    }
  }

  let maxDistance = 0;
  if (useMask) {
    for (let i = 0; i < len; i++) {
      if (dist[i] < inf && dist[i] > maxDistance) {
        maxDistance = dist[i];
      }
    }
  }

  for (let i = 0; i < len; i++) {
    // Reward lumen intensity: when vessels are bright, brighter = cheaper;
    // when vessels are dark (standard XA), darker = cheaper.
    const intensityCost = vesselsAreBright
      ? (maxIntensity - pixels[i]) / intensityRange
      : (pixels[i] - minIntensity) / intensityRange;
    const edgePenalty = gradient[i] / gradientRange;
    const inVessel = useMask && isLumen(pixels[i]);
    const medialPenalty = inVessel && maxDistance > 0 ? 1 - dist[i] / maxDistance : 1;
    const backgroundPenalty = inVessel || !useMask ? 0 : 2;
    cost[i] = 1 + 5 * intensityCost + 6 * medialPenalty + 4 * edgePenalty + 20 * backgroundPenalty;
  }

  return cost;
}
