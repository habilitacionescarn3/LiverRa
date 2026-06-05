// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// PACSViewer — Cornerstone3D viewport type-guards + volume health/geometry helpers
// ============================================================================
// Behavior-preserving extraction from PACSViewer.tsx (audit finding
// EMR-PACS-IMAGING-AUDIT-009, D11 code-scale). These are PURE, module-level
// functions/type-guards that close over NO React state or refs — they were
// always defined outside the component body, so moving them here changes
// nothing at runtime. They are colocated-unit-testable in isolation, which the
// 4000-line viewer never was. PACSViewer.tsx imports them back verbatim.
// ============================================================================

import { cache, metaData } from '@cornerstonejs/core';

// ============================================================================
// Minimal types for Cornerstone3D StackViewport methods not in base IViewport
// ============================================================================

export interface CS3DStackViewport {
  setStack: (imageIds: string[]) => Promise<void>;
  setImageIdIndex: (index: number) => void;
  getCurrentImageId: () => string | undefined;
  getCurrentImageIdIndex: () => number;
  getImageIds: () => string[];
  getImageData: () => { scalarData: Float32Array | Int16Array; dimensions: number[] } | undefined;
  resetProperties: () => void;
  resetCamera: () => void;
  render: () => void;
}

export function isStackViewport(viewport: unknown): viewport is CS3DStackViewport {
  const candidate = viewport as Partial<CS3DStackViewport>;
  return (
    typeof candidate.setStack === 'function' &&
    typeof candidate.resetCamera === 'function' &&
    typeof candidate.render === 'function'
  );
}

export function hasImageIndexControl(viewport: unknown): viewport is Pick<CS3DStackViewport, 'setImageIdIndex' | 'render'> {
  const candidate = viewport as Partial<CS3DStackViewport>;
  return typeof candidate.setImageIdIndex === 'function' && typeof candidate.render === 'function';
}

export function hasResetProperties(viewport: unknown): viewport is Pick<CS3DStackViewport, 'resetProperties'> {
  const candidate = viewport as Partial<CS3DStackViewport>;
  return typeof candidate.resetProperties === 'function';
}

export function hasSetProperties(viewport: unknown): viewport is { setProperties: (properties: unknown) => void } {
  return typeof (viewport as { setProperties?: unknown })?.setProperties === 'function';
}

export interface VolumePresetViewport {
  setProperties: (properties: { preset: string }) => void;
  resetCamera?: () => void;
  render?: () => void;
}

export function isVolumePresetViewport(viewport: unknown): viewport is VolumePresetViewport {
  // Cornerstone's public viewport type omits volume preset methods, so keep
  // this private volume-viewport shape behind an explicit method guard.
  if (typeof viewport !== 'object' || viewport === null) {
    return false;
  }
  const candidate = viewport as Partial<VolumePresetViewport>;
  return (
    typeof candidate.setProperties === 'function' &&
    (candidate.resetCamera === undefined || typeof candidate.resetCamera === 'function') &&
    (candidate.render === undefined || typeof candidate.render === 'function')
  );
}

export function hasSetCamera(viewport: unknown): viewport is { setCamera: (camera: unknown) => void } {
  return typeof (viewport as { setCamera?: unknown })?.setCamera === 'function';
}

export function hasRenderableViewport(viewport: unknown): viewport is { render: () => void } {
  return typeof (viewport as { render?: unknown })?.render === 'function';
}

// ── Volume rebuild health helpers (PACS black-panes fix) ───────────────────
// A cached CS3D streaming volume is safe to REUSE across a layout toggle only
// while it is still actively streaming (loading===true) OR a substantial
// fraction of its frames actually landed in the cache. A volume whose load
// SETTLED with ~no cached frames has had its frame XHRs fail — e.g. a degraded
// WADO session aborted them during the first build. Because layout switches
// deliberately KEEP the volume cached (so MPR↔axial↔VR toggles are instant),
// such a broken volume would otherwise be reused forever: every pane shows full
// overlays (slice count, W/L, orientation) but NO pixels — the reported
// "black/gray panes after re-switch" bug. Treating it as unusable forces a
// clean rebuild, so the next layout toggle self-heals once WADO recovers.
// Unknown (non-streaming) shapes are left reusable.
export function isCachedVolumeUsable(vol: unknown): boolean {
  const loadStatus = (
    vol as
      | { loadStatus?: { loaded?: boolean; loading?: boolean; cachedFrames?: ArrayLike<number> } }
      | null
      | undefined
  )?.loadStatus;
  if (!loadStatus) {
    return true;
  }
  // Still actively streaming → reuse; it will finish on its own.
  if (loadStatus.loading === true) {
    return true;
  }
  // NOTE: do NOT trust `loadStatus.loaded` — Cornerstone3D sets it `true` once
  // the load PROCESS completes even when every frame XHR failed (verified: a
  // wholesale-aborted volume reports {loaded:true, loading:false,
  // cachedFrames:[]}). The reliable signal is how many frames actually landed
  // in the cache. A wholesale fetch failure (the black-panes bug) leaves
  // cachedFrames empty/sparse; a few missing frames still render fine.
  const frames = loadStatus.cachedFrames;
  if (!frames || frames.length === 0) {
    return false;
  }
  let loaded = 0;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]) {
      loaded++;
    }
  }
  return loaded / frames.length >= 0.5;
}

// Drop any cached image-load-objects for these frames so the NEXT volume build
// issues genuinely-fresh XHRs instead of binding against poisoned/aborted
// promises left in the CS3D image cache by a degraded WADO session. Without
// this, a rebuild reuses the rejected cached promise and the frame "fails" with
// `Error caching image wadors:.../frames/N: XMLHttpRequest` — even though the
// server is now healthy. Best-effort: a missing/already-evicted entry is fine.
export function evictFramesForRebuild(imageIds: string[]): void {
  for (const id of imageIds) {
    try {
      cache.removeImageLoadObject(id);
    } catch (err) {
      console.warn('[PACSViewer] failed to evict cached frame before rebuild:', err);
    }
  }
}

// PACS-VR-LOD: the SOLO 3D overview doesn't need full through-plane resolution.
// Build it from a slice-subset (~VR_TARGET_SLICES) so the 3D texture is smaller and
// every rotate/crop frame ray-marches fewer voxels. MPR + measurements are NOT
// affected — they use the full-resolution volume; this subset feeds ONLY the solo
// VR pane. In-plane (XY) detail is untouched (whole slices are kept or dropped).
const VR_TARGET_SLICES = 280;
export function decimateImageIdsForVr(ids: string[], target = VR_TARGET_SLICES): string[] {
  if (ids.length <= target) return ids;
  const stride = Math.ceil(ids.length / target);
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += stride) out.push(ids[i]);
  // Always retain the last slice so the volume's Z extent is preserved.
  const last = ids[ids.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// PACS-VR-STATE: a series can only form a volume if EVERY slice carries
// consistent spatial geometry — Cornerstone's generateVolumePropsFromImageIds
// walks all imageIds reading imagePositionPatient + imageOrientationPatient to
// compute the volume axis/spacing, and throws "Cannot read properties of
// undefined (reading '1')" (uncaught) the moment ANY slice is missing that
// metadata, the orientation is inconsistent (mixed acquisitions / localizer
// interleaved), or the spacing is degenerate (duplicate positions). The old
// guard only inspected ids[0]/ids[1], so a bad slice deeper in the series — or a
// missing imageOrientationPatient — slipped through and crashed the build. This
// validates the whole series (sampled for large stacks) so every volume build is
// safe. Guard every createAndCacheVolume call with this.
export function canFormVolume(ids: string[]): boolean {
  if (!ids || ids.length < 2) return false;
  const plane = (id: string): { imagePositionPatient?: number[]; imageOrientationPatient?: number[]; pixelSpacing?: number[]; columns?: number; rows?: number; frameOfReferenceUID?: string } | undefined =>
    metaData.get('imagePlaneModule', id) as
      | { imagePositionPatient?: number[]; imageOrientationPatient?: number[]; pixelSpacing?: number[]; columns?: number; rows?: number; frameOfReferenceUID?: string }
      | undefined;

  // Cornerstone's makeVolumeMetadata reads imageIds[0]'s imagePlaneModule for
  // orientation + pixelSpacing + columns/rows, then generateVolumePropsFromImageIds
  // does PixelSpacing[1] / ImageOrientationPatient[1] — undefined there is the exact
  // "Cannot read properties of undefined (reading '1')" crash. So slice 0 MUST carry
  // all of those, and every slice needs a position for the z-spacing pass.
  const sliceZero = plane(ids[0]);
  const ps0 = sliceZero?.pixelSpacing;
  if (!Array.isArray(ps0) || ps0.length < 2 || ps0.some((n) => !Number.isFinite(n) || n <= 0)) {
    return false;
  }
  if (!Number.isFinite(sliceZero?.columns) || !Number.isFinite(sliceZero?.rows)) {
    return false;
  }
  const columns0 = sliceZero?.columns;
  const rows0 = sliceZero?.rows;
  const frameOfReferenceUID0 = sliceZero?.frameOfReferenceUID;

  const ORIENTATION_TOLERANCE = 1e-3;
  const PIXEL_SPACING_TOLERANCE = 1e-4;
  const POSITION_TOLERANCE = 1e-4;
  const SPACING_VARIANCE_RATIO = 0.25;
  let baseRow: [number, number, number] | null = null;
  let baseColumn: [number, number, number] | null = null;
  let normal: [number, number, number] | null = null;
  const positions: number[] = []; // projection of each slice onto the normal
  for (const id of ids) {
    const p = plane(id);
    const ipp = p?.imagePositionPatient;
    const iop = p?.imageOrientationPatient;
    const ps = p?.pixelSpacing;
    if (p?.columns !== columns0 || p?.rows !== rows0) {
      return false;
    }
    if ((frameOfReferenceUID0 || p?.frameOfReferenceUID) && p?.frameOfReferenceUID !== frameOfReferenceUID0) {
      return false;
    }
    if (
      !Array.isArray(ps) ||
      ps.length < 2 ||
      ps.some((n) => !Number.isFinite(n) || n <= 0) ||
      Math.abs(ps[0] - ps0[0]) > PIXEL_SPACING_TOLERANCE ||
      Math.abs(ps[1] - ps0[1]) > PIXEL_SPACING_TOLERANCE
    ) {
      return false;
    }
    // Every slice MUST have a 3-vector position and a matching 6-vector orientation.
    if (!Array.isArray(ipp) || ipp.length < 3 || ipp.some((n) => !Number.isFinite(n))) {
      return false;
    }
    if (!Array.isArray(iop) || iop.length < 6 || iop.some((n) => !Number.isFinite(n))) {
      return false;
    }
    if (!normal) {
      const [rx, ry, rz, cx, cy, cz] = iop;
      baseRow = [rx, ry, rz];
      baseColumn = [cx, cy, cz];
      normal = [ry * cz - rz * cy, rz * cx - rx * cz, rx * cy - ry * cx];
      const len = Math.hypot(normal[0], normal[1], normal[2]);
      if (!Number.isFinite(len) || len < 1e-6) {
        return false;
      }
      normal = [normal[0] / len, normal[1] / len, normal[2] / len];
    } else if (
      !baseRow ||
      !baseColumn ||
      Math.abs(iop[0] - baseRow[0]) > ORIENTATION_TOLERANCE ||
      Math.abs(iop[1] - baseRow[1]) > ORIENTATION_TOLERANCE ||
      Math.abs(iop[2] - baseRow[2]) > ORIENTATION_TOLERANCE ||
      Math.abs(iop[3] - baseColumn[0]) > ORIENTATION_TOLERANCE ||
      Math.abs(iop[4] - baseColumn[1]) > ORIENTATION_TOLERANCE ||
      Math.abs(iop[5] - baseColumn[2]) > ORIENTATION_TOLERANCE
    ) {
      return false;
    }
    positions.push(ipp[0] * normal[0] + ipp[1] * normal[1] + ipp[2] * normal[2]);
  }
  if (!normal) {
    return false;
  }
  // Spacing must be non-degenerate: the through-plane extent across the sampled
  // slices has to be > 0 (duplicate-position / single-plane series → 0 → NaN axis).
  const sortedPositions = [...positions].sort((a, b) => a - b);
  const spacings: number[] = [];
  for (let i = 1; i < sortedPositions.length; i++) {
    const spacing = sortedPositions[i] - sortedPositions[i - 1];
    if (!Number.isFinite(spacing) || spacing <= POSITION_TOLERANCE) {
      return false;
    }
    spacings.push(spacing);
  }
  const sortedSpacings = [...spacings].sort((a, b) => a - b);
  const medianSpacing = sortedSpacings[Math.floor(sortedSpacings.length / 2)];
  if (!Number.isFinite(medianSpacing) || medianSpacing <= POSITION_TOLERANCE) {
    return false;
  }
  // Slice-spacing regularity check — tolerant of DROPPED SLICES.
  //
  // Real-world CT (esp. cardiac-gated / dose-modulated CTA) frequently ships a
  // series with the occasional slice missing: the true grid is uniform at the
  // MEDIAN spacing, but a handful of gaps are exact INTEGER MULTIPLES of it
  // (e.g. median 0.8mm with scattered 1.6 / 2.4 / 4.0mm gaps where 1, 2, or 4
  // slices were dropped). Cornerstone's streaming volume loader builds these
  // fine — it grids on the median spacing and the gaps just interpolate. The
  // earlier `spacings.every(within±25% of median)` rejected ANY such gap, so
  // a 676-slice CTA with ~11% dropped slices fell back to a flat 2D stack
  // (the user-reported "MPR does nothing" bug).
  //
  // We now accept the series when BOTH hold:
  //   1. the MAJORITY of gaps (≥50%) are within ±25% of the median (so the
  //      grid is genuinely uniform, not an arbitrary hanging-protocol mash),
  //   2. EVERY off-median gap is explainable as k missing slices — i.e. it is
  //      within tolerance of an integer multiple of the median.
  // A true non-volume (mixed series / random offsets) fails (2); the
  // degenerate / duplicate-position case is already rejected above. The
  // crash-class guards (missing pixelSpacing / IOP / IPP) are untouched.
  const tol = Math.max(POSITION_TOLERANCE, medianSpacing * SPACING_VARIANCE_RATIO);
  let regularCount = 0;
  for (const spacing of spacings) {
    if (Math.abs(spacing - medianSpacing) <= tol) {
      regularCount += 1;
      continue;
    }
    // Off-median: only OK if it's ≈ k × median for some integer k ≥ 1.
    const k = Math.round(spacing / medianSpacing);
    if (k < 1 || Math.abs(spacing - k * medianSpacing) > tol) {
      return false;
    }
  }
  return regularCount / spacings.length >= 0.5;
}
