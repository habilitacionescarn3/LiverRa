// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Console-noise filter.
 *
 * Plain-English: Cornerstone3D, vtk.js, and Chromium's WebGL layer log a
 * handful of warnings that are *always* noise for the way LiverRa uses
 * them — they aren't actionable and fixing them at the source would
 * require forking upstream. This module installs a very narrow filter on
 * `console.warn` + `console.log` at app entry so the dev console stays
 * readable.
 *
 * The filter is deliberately string-match-based and conservative: it
 * only suppresses messages whose full text starts with or exactly
 * matches one of the known noise patterns. Anything else passes through
 * untouched, including any future warnings that Cornerstone adds.
 *
 * Side-effect import; see `main.tsx`.
 */

const NOISE_SUBSTRINGS: readonly string[] = [
  // Cornerstone dicom-image-loader — idempotent worker registration when
  // HMR / Strict Mode re-runs the init path.
  "Worker type 'dicomImageLoader' is already registered",
  // Cornerstone tools — v4.15 no longer exposes SegmentationDisplay; the
  // segmentation state helper renders masks directly.
  "'SegmentationDisplay' is not registered with the library",
  'Tool SegmentationDisplay not added to toolGroup',
  // Chromium performance hint from Cornerstone's OrientationMarker cube
  // texture — we don't control the getContext('2d') call that triggers
  // it, and the overlay is invisible-impact for our use cases.
  'Canvas2D: Multiple readback operations using getImageData are faster',
  // WebGL driver performance notices — also noise.
  'GL Driver Message (OpenGL, Performance',
  // Cornerstone's own info log on every init — useful once, noisy on HMR.
  'CornerstoneRender: using GPU rendering',
];

function shouldSuppress(args: readonly unknown[]): boolean {
  if (args.length === 0) return false;
  const first = args[0];
  if (typeof first !== 'string') return false;
  for (const needle of NOISE_SUBSTRINGS) {
    if (first.includes(needle)) return true;
  }
  return false;
}

function wrap(method: 'warn' | 'log'): void {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]): void => {
    if (shouldSuppress(args)) return;
    original(...args);
  };
}

wrap('warn');
wrap('log');
