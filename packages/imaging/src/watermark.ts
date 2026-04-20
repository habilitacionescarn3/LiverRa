// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas watermark utility (T179).
 *
 * Plain-English: stamps a diagonal, tiled "Research Use Only" phrase across
 * any `<canvas>` surface — viewer screenshots, report PDF pages, DICOM
 * export thumbnails. Think of it as a faint rubber-stamp pressed repeatedly
 * onto a sheet of paper so every clipped corner still carries the mark.
 *
 * Why it lives in `@liverra/imaging`:
 *   - Shared between the live 3D viewer (T175 `LiverViewer3D` overlay
 *     refresh hook) and the server-side PDF export worker (Phase 7 T259)
 *     so both paths render an identical watermark pattern.
 *   - Keeps the RUO regulatory obligation (FR-028a/b + plan §Claim Registry
 *     as feature-flag source) out of UI components — a viewer author can't
 *     accidentally forget to apply it, because `useViewerWatermark` consumes
 *     this util directly off the claim registry.
 *
 * Intentionally dependency-free: takes a `HTMLCanvasElement` + options and
 * mutates it in-place. Server-side callers (Node/workers) feed it an
 * OffscreenCanvas via the small `buildWatermarkCanvas` factory below, which
 * falls back to a plain `<canvas>` when `OffscreenCanvas` is unavailable.
 *
 * Spec refs: FR-028a/b (RUO scope-narrowing), plan.md §UI Conventions.
 */

export interface WatermarkOptions {
  /** Phrase painted on the canvas. Defaults to `'Research Use Only'`. */
  text?: string;
  /** Global alpha used for the composite (0-1). Defaults to `0.08`. */
  opacity?: number;
  /** Rotation of each tile, in degrees (negative = diagonal down-left). */
  angle?: number;
  /** Font size in CSS pixels. */
  fontSize?: number;
  /**
   * Fill colour. Supply a `rgba(...)` string if you want alpha baked in;
   * otherwise the `opacity` option controls transparency via `globalAlpha`.
   */
  color?: string;
  /** Horizontal spacing between tile centres (CSS px). */
  strideX?: number;
  /** Vertical spacing between tile centres (CSS px). */
  strideY?: number;
}

/**
 * Canvas 2D APIs (`ctx.font`, `ctx.fillStyle`) require raw numeric px values
 * and literal color strings — they cannot consume CSS custom properties at
 * runtime, and this package is import-isolated from `@liverra/app` where
 * `theme.css` lives. We therefore hold the tokens locally and keep them in
 * lock-step with `packages/app/src/emr/styles/theme.css` by convention.
 *
 * Source-of-truth mapping:
 *   WATERMARK_FONT_SIZE_PX → mirrors `--emr-font-5xl` (32px) in theme.css.
 *   WATERMARK_COLOR        → semantic "neutral watermark ink" — if a
 *                            `--emr-watermark-color` token is later added
 *                            to theme.css, update this constant to match.
 */
// Canvas `ctx.font` requires a numeric px value; mirrors `--emr-font-5xl` (32px) in theme.css.
const WATERMARK_FONT_SIZE_PX = 32;
// eslint-disable-next-line liverra/no-hardcoded-color -- canvas ctx.fillStyle cannot resolve CSS vars; keep in sync with theme.css neutral watermark ink
const WATERMARK_COLOR = 'rgba(128, 128, 128, 0.08)';

const DEFAULTS: Required<WatermarkOptions> = {
  text: 'Research Use Only',
  opacity: 0.08,
  angle: -30,
  fontSize: WATERMARK_FONT_SIZE_PX,
  color: WATERMARK_COLOR,
  strideX: 300,
  strideY: 200,
};

/**
 * Mutate `canvas` in-place to stamp a diagonal, tiled RUO watermark.
 *
 * Safe to call on an already-watermarked canvas — each call re-stamps over
 * whatever is there. The `save()/restore()` pair guarantees we never leak
 * transform state back to the caller's drawing pipeline.
 */
export function burnWatermark(canvas: HTMLCanvasElement, opts: WatermarkOptions = {}): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { text, opacity, angle, fontSize, color, strideX, strideY } = {
    ...DEFAULTS,
    ...opts,
  };

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  // Anchor rotation at the canvas centre so tiles span evenly in all
  // directions even after rotation clips the bounding box.
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((angle * Math.PI) / 180);

  // Use a diagonal of the canvas as the extent so rotated tiles cover every
  // corner — the negative-origin loop eliminates empty gutters.
  const extentX = canvas.width;
  const extentY = canvas.height;
  for (let y = -extentY; y <= extentY; y += strideY) {
    for (let x = -extentX; x <= extentX; x += strideX) {
      ctx.fillText(text, x, y);
    }
  }

  ctx.restore();
}

/**
 * Offscreen/server-side analog. Produces a fresh canvas already stamped
 * with the watermark — suitable for compositing into report PDFs.
 *
 * Falls back to a document-created canvas when run inside a browser, and
 * an `OffscreenCanvas` in workers / Node with the `canvas` polyfill.
 */
export function buildWatermarkCanvas(
  width: number,
  height: number,
  opts?: WatermarkOptions,
): HTMLCanvasElement {
  let canvas: HTMLCanvasElement;
  if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  } else if (typeof OffscreenCanvas !== 'undefined') {
    // OffscreenCanvas is structurally compatible with the subset of the
    // HTMLCanvasElement API we use (`width`, `height`, `getContext('2d')`).
    canvas = new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement;
  } else {
    throw new Error(
      'buildWatermarkCanvas: no HTMLCanvasElement or OffscreenCanvas available in this environment',
    );
  }
  burnWatermark(canvas, opts);
  return canvas;
}
