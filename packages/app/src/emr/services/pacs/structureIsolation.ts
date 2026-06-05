// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Structure Isolation — two-actor "tissue suppression" rendering primitive
// ============================================================================
// Goal (the 3mensio "isolate & inspect" look): keep a selected structure opaque
// in the 3D VR pane while FADING everything else to translucent — without
// physically cropping. This is NOT the crop box (geometry) and NOT a labelmap
// overlay (Cornerstone labelmaps don't render in VOLUME_3D viewports).
//
// Technique — TWO volume actors in ONE VOLUME_3D viewport:
//   1. The full CT volume  → ghosted (low scalar opacity).
//   2. A "masked-intensity" volume → the SAME CT scalars but ONLY inside the
//      structure mask; everything outside is set to AIR (-1024) so it renders
//      as nothing. This actor stays opaque (a bold vessel/CT preset).
// The viewer composites both, so the structure "pops" out of a translucent body.
//
// Phase 1 (this file) proves the rendering with a simple HU-THRESHOLD mask built
// from the already-loaded CT — no segmentation/bridge call yet. Phase 2 swaps the
// threshold mask for a real region-grow segmentation mask (same render path).
//
// All Cornerstone3D APIs used here are confirmed present in @cornerstonejs/core
// 4.22.6: createAndCacheDerivedVolume, setVolumes(), getActors(), and
// viewport.setProperties({ preset }) — the masked-intensity volume is rendered with a
// real shaded CT preset (applyPreset under the hood), so the isolated structure reads
// anatomically rather than as a flat hand-rolled transfer function.
// ============================================================================

import { cache, volumeLoader, getRenderingEngine } from '@cornerstonejs/core';
import { getCachedVolume } from './cornerstoneCompat';

// ----------------------------------------------------------------------------
// Relaxed scalar reader
// ----------------------------------------------------------------------------
// labelmapBridge.readVolumeScalars gates strictly on loadStatus.loaded===true
// (correct for TAVI segmentation — never compute on holed data). For a VISUAL
// isolation we read the SAME vtk imageData the VR pane is already rendering from,
// WITHOUT that gate, so isolation works even when a few frames failed to fetch
// (the volume renders fine; the strict gate would otherwise block us entirely).
interface CachedVolumeLike {
  dimensions?: number[];
  spacing?: number[];
  scalarData?: ArrayLike<number>;
  voxelManager?: { getScalarData?: () => ArrayLike<number>; getCompleteScalarDataArray?: () => ArrayLike<number> };
  imageData?: { getPointData?: () => { getScalars?: () => { getData?: () => ArrayLike<number> } } };
}

function readVolumeScalarsRelaxed(
  volumeId: string
): { voxels: Int16Array; dims: { width: number; height: number; depth: number } } | null {
  const vol = getCachedVolume<CachedVolumeLike>(cache, volumeId);
  if (!vol?.dimensions || vol.dimensions.length < 3) return null;
  const trySource = (fn: () => ArrayLike<number> | undefined): ArrayLike<number> | undefined => {
    try {
      const v = fn();
      return v && v.length > 0 ? v : undefined;
    } catch (err) {
      console.warn('[structureIsolation] relaxed scalar source read failed:', err);
      return undefined;
    }
  };
  const scalar =
    trySource(() => vol.imageData?.getPointData?.()?.getScalars?.()?.getData?.()) ??
    trySource(() => vol.voxelManager?.getScalarData?.()) ??
    trySource(() => vol.scalarData) ??
    trySource(() => vol.voxelManager?.getCompleteScalarDataArray?.());
  if (!scalar || scalar.length === 0) return null;
  const d = vol.dimensions;
  const voxels = scalar instanceof Int16Array ? scalar : Int16Array.from(scalar);
  return { voxels, dims: { width: d[0], height: d[1], depth: d[2] } };
}

/**
 * Cheap readiness probe: true once the CT volume's scalar data is readable (the
 * volume has streamed enough to isolate). Lets the UI gate the Isolate tool and
 * show a "still loading" hint instead of blaming the click.
 */
export function isCtScalarsReady(volumeId: string): boolean {
  return readVolumeScalarsRelaxed(volumeId) != null;
}

/** HU value used for "outside the structure" voxels — radiodense air, renders as nothing. */
const AIR_HU = -1024;

/**
 * HU band that counts as "soft-tissue / contrast structure" when picking a seed —
 * above fat/muscle/lung, below cortical-bone brightness. A front-on ray crosses the
 * sternum (cortical bone, > the ceiling) first, then the contrast lumen near the
 * volume centre; seeding the in-band voxel nearest the focal plane steps past the
 * chest wall and lands in the blood pool the operator aimed at.
 */
const CONTRAST_BAND_LO = 150;
const CONTRAST_BAND_HI = 500;

/** Stable volumeId suffix so we can find/evict the masked actor deterministically. */
export const MASKED_VOLUME_SUFFIX = '_isolation_masked';

// Cornerstone3D assigns RANDOM GUID uids to VOLUME_3D actors — they are NOT the
// volumeId — so we can't map actor→volume by uid. Instead we remember the uid of
// the masked actor (the one ADDED by applyIsolation) per viewport, so re-applies
// (e.g. slider drags) ghost only the base CT actor and never the masked one.
const maskedActorUidByViewport = new Map<string, string>();

/**
 * Build (or rebuild) the masked-intensity volume for a CT volume + a boolean
 * keep-mask. Returns the masked volumeId, or null if the CT scalars aren't
 * readable yet (volume still streaming).
 *
 * @param ctVolumeId   the loaded CT volume backing the VR viewport
 * @param keep         predicate (hu, voxelIndex) → true to KEEP the voxel opaque.
 *                     Phase 1 passes a HU-threshold; Phase 2 will pass a
 *                     segmentation-mask lookup.
 */
export function buildMaskedIntensityVolume(
  ctVolumeId: string,
  keep: (hu: number, index: number) => boolean
): string | null {
  const ct = readVolumeScalarsRelaxed(ctVolumeId);
  if (!ct) return null; // CT not fully loaded — caller retries

  const maskedVolumeId = `${ctVolumeId}${MASKED_VOLUME_SUFFIX}`;

  // Derive a same-geometry Int16 volume from the CT (origin/spacing/direction/
  // FrameOfReferenceUID all inherited — no manual alignment, no FoR-clash throw).
  try {
    if (!cache.getVolume?.(maskedVolumeId)) {
      // NOTE(LiverRa port): MediMind passed `dataType: 'Int16'` here, but CS3D
      // 4.22.6's createAndCacheDerivedVolume ignores that key (it only reads
      // `targetBuffer`) — dropped for type-cleanliness; runtime-identical.
      volumeLoader.createAndCacheDerivedVolume(ctVolumeId, {
        volumeId: maskedVolumeId,
      });
    }
  } catch (err) {
    console.warn('[structureIsolation] derive masked volume failed:', err);
    return null;
  }

  const masked = cache.getVolume?.(maskedVolumeId) as
    | { voxelManager?: { setCompleteScalarDataArray?: (a: ArrayLike<number>) => void; getCompleteScalarDataArray?: () => ArrayLike<number> }; imageData?: { modified?: () => void } }
    | undefined;
  if (!masked) return null;

  // Fill: CT HU inside the structure, AIR everywhere else.
  const src = ct.voxels;
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = keep(src[i], i) ? src[i] : AIR_HU;
  }

  try {
    masked.voxelManager?.setCompleteScalarDataArray?.(out);
    masked.imageData?.modified?.();
  } catch (err) {
    console.warn('[structureIsolation] write masked scalars failed:', err);
    return null;
  }
  return maskedVolumeId;
}

/**
 * Memory-safe masked-intensity build from a precomputed region MASK + its bounding
 * box. Unlike {@link buildMaskedIntensityVolume} (which loops the whole ~216M-voxel
 * grid AND allocates a second full Int16 buffer → main-thread freeze), this reuses
 * the derived volume's EXISTING scalar buffer: blank it to AIR once (fast native
 * fill), then write CT HU only inside the bbox. No second full allocation, no
 * whole-volume loop, no UI freeze.
 */
export function buildMaskedIntensityVolumeFromMask(
  ctVolumeId: string,
  mask: Uint8Array,
  bbox: BoundingBox,
  dims: { width: number; height: number; depth: number }
): string | null {
  const ct = readVolumeScalarsRelaxed(ctVolumeId);
  if (!ct) return null;

  const maskedVolumeId = `${ctVolumeId}${MASKED_VOLUME_SUFFIX}`;
  try {
    if (!cache.getVolume?.(maskedVolumeId)) {
      // NOTE(LiverRa port): MediMind passed `dataType: 'Int16'` here, but CS3D
      // 4.22.6's createAndCacheDerivedVolume ignores that key (it only reads
      // `targetBuffer`) — dropped for type-cleanliness; runtime-identical.
      volumeLoader.createAndCacheDerivedVolume(ctVolumeId, {
        volumeId: maskedVolumeId,
      });
    }
  } catch (err) {
    console.warn('[structureIsolation] derive masked volume failed:', err);
    return null;
  }

  const masked = cache.getVolume?.(maskedVolumeId) as
    | {
        voxelManager?: {
          getScalarData?: () => ArrayLike<number>;
          getCompleteScalarDataArray?: () => ArrayLike<number>;
          setCompleteScalarDataArray?: (a: ArrayLike<number>) => void;
        };
        imageData?: { modified?: () => void };
      }
    | undefined;
  if (!masked) return null;

  // Allocate one fresh same-size scalar buffer (one transient Int16; mirrors the proven
  // buildMaskedIntensityVolume path). We intentionally do NOT read the derived volume's
  // buffer via getScalarData() — in Cornerstone3D 4.22.6 that THROWS on a derived volume
  // ("No scalar data available"), and `?.()` optional-chaining does NOT catch a throw, so
  // it would propagate out of this function and break isolate entirely.
  const dst = new Int16Array(ct.voxels.length);

  const { width: W, height: H } = dims;
  const WH = W * H;
  const src = ct.voxels;

  // 1) blank everything to AIR (fast), 2) paint CT HU only inside the bounding box.
  dst.fill(AIR_HU);
  for (let z = bbox.z0; z <= bbox.z1; z++) {
    for (let y = bbox.y0; y <= bbox.y1; y++) {
      const row = z * WH + y * W;
      for (let x = bbox.x0; x <= bbox.x1; x++) {
        const idx = row + x;
        if (mask[idx] === 1) dst[idx] = src[idx];
      }
    }
  }

  try {
    masked.voxelManager?.setCompleteScalarDataArray?.(dst);
    masked.imageData?.modified?.();
  } catch (err) {
    console.warn('[structureIsolation] write masked scalars failed:', err);
    return null;
  }
  return maskedVolumeId;
}

interface ClipMapperLike {
  getClippingPlanes?: () => unknown[];
  addClippingPlane?: (plane: unknown) => void;
}
interface ActorLike {
  uid?: string;
  actor?: { getMapper?: () => ClipMapperLike | undefined };
}
interface VrViewportLike {
  addVolumes?: (v: Array<{ volumeId: string }>, immediate?: boolean) => Promise<void>;
  setVolumes?: (v: Array<{ volumeId: string }>, immediate?: boolean) => Promise<void>;
  getActors?: () => ActorLike[];
  getDefaultActor?: () => ActorLike | undefined;
  setProperties?: (props: { preset: string }, volumeId?: string) => void;
  render?: () => void;
}

function getVolume3DViewport(renderingEngineId: string, vrViewportId: string): VrViewportLike | undefined {
  const re = getRenderingEngine(renderingEngineId);
  const vp = re?.getViewport(vrViewportId) as unknown as VrViewportLike | undefined;
  return typeof vp?.setVolumes === 'function' ? vp : undefined;
}

// ----------------------------------------------------------------------------
// Crop preservation across a setVolumes swap
// ----------------------------------------------------------------------------
// setVolumes builds a NEW actor+mapper with ZERO clipping planes, so the
// VolumeCroppingTool's crop (clip planes on the OLD mapper) is otherwise lost on
// every isolate/remove/clear. We capture the world-space clip planes before the swap
// and re-add them to the new actor's mapper after — the derived/masked volume shares
// the CT's exact geometry (origin/spacing/direction/FoR), so the same planes clip
// identically. Best-effort + idempotent (skips if the new mapper already has planes).
function captureClippingPlanes(vp: VrViewportLike): unknown[] {
  try {
    const planes = vp.getActors?.()?.[0]?.actor?.getMapper?.()?.getClippingPlanes?.();
    return Array.isArray(planes) ? planes.slice() : [];
  } catch (err) {
    console.warn('[structureIsolation] capture clipping planes failed:', err);
    return [];
  }
}
function restoreClippingPlanes(vp: VrViewportLike, planes: unknown[]): void {
  if (!planes.length) return;
  try {
    const mapper = vp.getActors?.()?.[0]?.actor?.getMapper?.();
    if (!mapper?.addClippingPlane) return;
    if ((mapper.getClippingPlanes?.()?.length ?? 0) > 0) return; // already has planes — don't double up
    for (const plane of planes) mapper.addClippingPlane(plane);
  } catch (err) {
    console.warn('[structureIsolation] restore clipping planes failed:', err);
  }
}

/**
 * Apply isolation to the VR viewport. SINGLE-ACTOR approach: REPLACE the viewport's
 * volume with the masked-intensity volume, so only the kept structure renders and
 * everything outside the mask (AIR) is simply not there. We style the single actor
 * with an explicit opaque CT transfer function.
 *
 * Why not two actors (ghost CT + opaque structure)? Cornerstone3D's VOLUME_3D
 * viewport does not composite a second added volume actor in 4.22.6 — the masked
 * actor stays invisible no matter the TF. Replacing the single volume is the
 * reliable path and gives the cleaner "only the structure" inspection view.
 *
 * `ghostOpacity` is currently unused (kept in the signature for the future
 * translucent-context variant); the non-structure tissue is hidden, not ghosted.
 */
export async function applyIsolation(
  renderingEngineId: string,
  vrViewportId: string,
  _ctVolumeId: string,
  maskedVolumeId: string,
  _ghostOpacity: number,
  presetVtkName = 'CT-Coronary-Arteries-2'
): Promise<boolean> {
  const vp = getVolume3DViewport(renderingEngineId, vrViewportId);
  if (!vp) {
    console.warn('[structureIsolation] applyIsolation failed: VOLUME_3D viewport setVolumes unavailable');
    return false;
  }

  // Preserve any active crop across the actor swap (setVolumes drops clip planes).
  const savedPlanes = captureClippingPlanes(vp);
  // Swap the viewport onto the masked volume (drops the full-CT actor).
  try {
    await vp.setVolumes?.([{ volumeId: maskedVolumeId }], false);
    restoreClippingPlanes(vp, savedPlanes);
  } catch (err) {
    console.warn('[structureIsolation] applyIsolation setVolumes failed:', err);
    return false;
  }

  // Render the isolated structure with the operator's CURRENT preset so it reads as a
  // REAL, shaded CT volume render (the preset enables surface shading + gradient opacity),
  // NOT the flat hand-rolled TF. The masked volume holds only the structure's CT HU
  // (everything else = AIR), so the preset renders just that structure — anatomically.
  try {
    vp.setProperties?.({ preset: presetVtkName });
  } catch (err) {
    console.warn('[structureIsolation] applyIsolation preset failed:', err);
  }
  const actor = vp.getDefaultActor?.() ?? vp.getActors?.()[0];
  if (actor?.uid) maskedActorUidByViewport.set(vrViewportId, actor.uid);
  vp.render?.();
  return true;
}

/**
 * Remove isolation: drop the masked actor and restore the CT actor to full
 * opacity. Best-effort; safe to call when isolation was never applied.
 */
export async function clearIsolation(
  renderingEngineId: string,
  vrViewportId: string,
  ctVolumeId: string,
  restorePresetVtkName = 'CT-Coronary-Arteries-2'
): Promise<void> {
  const re = getRenderingEngine(renderingEngineId);
  const vp = re?.getViewport(vrViewportId) as unknown as VrViewportLike | undefined;
  if (!vp?.setVolumes) return;

  // Rebind to ONLY the CT volume — this drops the masked actor and re-creates a
  // fresh CT actor with a DEFAULT (invisible) transfer function, so we must
  // re-apply the VR preset or the pane goes black.
  const savedPlanes = captureClippingPlanes(vp);
  try {
    await vp.setVolumes?.([{ volumeId: ctVolumeId }], false);
    restoreClippingPlanes(vp, savedPlanes);
    vp.setProperties?.({ preset: restorePresetVtkName });
  } catch (err) {
    console.warn('[structureIsolation] clear isolation setVolumes failed:', err);
  }
  maskedActorUidByViewport.delete(vrViewportId);
  vp.render?.();

  // Evict the masked volume so it doesn't leak GPU/cache memory.
  try {
    cache.removeVolumeLoadObject?.(`${ctVolumeId}${MASKED_VOLUME_SUFFIX}`);
  } catch (err) {
    console.warn('[structureIsolation] clear isolation cache eviction failed:', err);
  }
}

/** Convenience: the HU-threshold keep-predicate used by Phase 1 (contrast + bone). */
export function huThresholdKeep(thresholdHu: number): (hu: number) => boolean {
  return (hu: number) => hu >= thresholdHu;
}

// ============================================================================
// Region grow — connected-threshold segmentation from a seed voxel
// ============================================================================
// Commodity 3D flood-fill: from a seed voxel, keep every 6-connected neighbour
// whose HU sits in a band around the seed. Clicking inside the contrast-filled
// aorta grows the connected lumen (and nothing disconnected, like ribs), so
// isolating the resulting mask shows ONLY that vessel — the 3mensio workflow.
//
// This runs in the browser (on-prem). The crown-jewel TAVI aorto-iliofemoral
// pipeline (auto seed detection, calcium-bridge severing, quality gates) stays
// on the on-prem bridge; this generic grow is the commodity "isolate anything"
// path. Because the render consumes a plain mask, the mask SOURCE can later be
// swapped to the bridge SEG with zero render changes.

export interface GrowOptions {
  /** HU band half-width around the seed value. */
  tolerance?: number;
  /** Hard floor/ceiling on kept HU (intersected with the seed band). */
  minHu?: number;
  maxHu?: number;
  /** Safety cap on region size (prevents a runaway grow eating the whole body). */
  maxVoxels?: number;
}

/** Inclusive voxel-index bounding box of a grown region. */
export interface BoundingBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface GrowResult {
  mask: Uint8Array;
  /** Number of voxels kept. */
  count: number;
  /** True if the grow hit the maxVoxels cap (region likely leaked). */
  capped: boolean;
  /** Inclusive voxel bounding box of the grown region (undefined when count===0). */
  bbox?: BoundingBox;
  /** Volume dimensions the mask is indexed against (echoes the grow input). */
  dims?: { width: number; height: number; depth: number };
}

/**
 * Connected-threshold region grow. Pure — no Cornerstone/DOM — so it unit-tests
 * directly. Returns a Uint8 mask (1 = inside the region) aligned 1:1 with `voxels`.
 */
export function growRegion(
  voxels: ArrayLike<number>,
  dims: { width: number; height: number; depth: number },
  seedIndex: number,
  opts: GrowOptions = {}
): GrowResult {
  const W = dims.width;
  const H = dims.height;
  const D = dims.depth;
  const n = W * H * D;
  const mask = new Uint8Array(n);
  const dimsOut = { width: W, height: H, depth: D };
  if (seedIndex < 0 || seedIndex >= n || n === 0) return { mask, count: 0, capped: false, dims: dimsOut };

  const seedHu = voxels[seedIndex];
  const tol = opts.tolerance ?? 100;
  const lo = Math.max(opts.minHu ?? -Infinity, seedHu - tol);
  const hi = Math.min(opts.maxHu ?? Infinity, seedHu + tol);
  if (seedHu < lo || seedHu > hi) return { mask, count: 0, capped: false, dims: dimsOut };

  const maxVoxels = opts.maxVoxels ?? 5_000_000;
  // Frontier stack of voxel indices. For a compact blob the live frontier is
  // far smaller than the region, so maxVoxels slots is ample headroom.
  const stack = new Int32Array(maxVoxels);
  let sp = 0;
  stack[sp++] = seedIndex;
  mask[seedIndex] = 1;
  let count = 0;
  let capped = false;
  const WH = W * H;
  // Track the inclusive bounding box of the grown region (feeds bbox-bounded
  // morphology + the memory-safe masked build).
  let minX = W, minY = H, minZ = D, maxX = -1, maxY = -1, maxZ = -1;

  while (sp > 0) {
    if (count >= maxVoxels) { capped = true; break; }
    const idx = stack[--sp];
    count++;
    const z = (idx / WH) | 0;
    const rem = idx - z * WH;
    const y = (rem / W) | 0;
    const x = rem - y * W;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    const push = (ni: number): void => {
      if (mask[ni] !== 0) return;
      const v = voxels[ni];
      if (v < lo || v > hi) return;
      mask[ni] = 1;
      if (sp < stack.length) stack[sp++] = ni;
      else capped = true; // frontier overflow — stop expanding this branch
    };
    if (x > 0) push(idx - 1);
    if (x < W - 1) push(idx + 1);
    if (y > 0) push(idx - W);
    if (y < H - 1) push(idx + W);
    if (z > 0) push(idx - WH);
    if (z < D - 1) push(idx + WH);
  }
  const bbox: BoundingBox | undefined =
    maxX >= 0 ? { x0: minX, y0: minY, z0: minZ, x1: maxX, y1: maxY, z1: maxZ } : undefined;
  return { mask, count, capped, bbox, dims: dimsOut };
}

/** Read the loaded CT volume and grow a region from a seed voxel. Null if the CT isn't loaded yet. */
export function growMaskFromSeed(
  ctVolumeId: string,
  seedIndex: number,
  opts: GrowOptions = {}
): GrowResult | null {
  const ct = readVolumeScalarsRelaxed(ctVolumeId);
  if (!ct) return null;
  return growRegion(ct.voxels, ct.dims, seedIndex, opts);
}

/**
 * Morphological opening (erode→dilate, 6-connected) of a region mask, applied ONLY
 * within the region's bounding box (expanded by `iterations`) so it stays cheap and
 * allocation-light. Severs sub-voxel-thin bridges (e.g. a calcium spur joining the
 * aorta to a vertebra) so an isolate doesn't bleed into the neighbour. Mutates
 * `mask` in place within the working box and returns the surviving voxel count.
 * Pure w.r.t. Cornerstone/DOM (unit-testable on a small mask).
 */
export function morphologicalOpen(
  mask: Uint8Array,
  dims: { width: number; height: number; depth: number },
  bbox: BoundingBox,
  iterations = 1
): number {
  const it = Math.max(0, Math.floor(iterations));
  const { width: W, height: H, depth: D } = dims;
  const WH = W * H;
  const x0 = Math.max(0, bbox.x0 - it);
  const x1 = Math.min(W - 1, bbox.x1 + it);
  const y0 = Math.max(0, bbox.y0 - it);
  const y1 = Math.min(H - 1, bbox.y1 + it);
  const z0 = Math.max(0, bbox.z0 - it);
  const z1 = Math.min(D - 1, bbox.z1 + it);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;

  if (it > 0) {
    const scratch = new Uint8Array(bw * bh * (z1 - z0 + 1));
    const runPass = (erode: boolean): void => {
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          const rowFull = z * WH + y * W;
          const rowLocal = (z - z0) * bw * bh + (y - y0) * bw;
          for (let x = x0; x <= x1; x++) {
            const fi = rowFull + x;
            const self = mask[fi];
            const xl = x > 0 ? mask[fi - 1] : 0;
            const xr = x < W - 1 ? mask[fi + 1] : 0;
            const yl = y > 0 ? mask[fi - W] : 0;
            const yr = y < H - 1 ? mask[fi + W] : 0;
            const zl = z > 0 ? mask[fi - WH] : 0;
            const zr = z < D - 1 ? mask[fi + WH] : 0;
            const val = erode
              ? self && xl && xr && yl && yr && zl && zr
              : self || xl || xr || yl || yr || zl || zr;
            scratch[rowLocal + (x - x0)] = val ? 1 : 0;
          }
        }
      }
      // commit scratch back into the full mask within the working box
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          const rowFull = z * WH + y * W;
          const rowLocal = (z - z0) * bw * bh + (y - y0) * bw;
          for (let x = x0; x <= x1; x++) mask[rowFull + x] = scratch[rowLocal + (x - x0)];
        }
      }
    };
    for (let i = 0; i < it; i++) runPass(true);
    for (let i = 0; i < it; i++) runPass(false);
  }

  let count = 0;
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      const rowFull = z * WH + y * W;
      for (let x = x0; x <= x1; x++) if (mask[rowFull + x]) count++;
    }
  }
  return count;
}

/**
 * Find a seed voxel near the volume centre whose HU is closest to `targetHu`.
 * Stand-in for a real click-pick (the mediastinum/aorta sits centrally). Searches
 * only the central sub-box so it doesn't lock onto peripheral bone.
 */
export function findSeedNearCenter(ctVolumeId: string, targetHu: number): number | null {
  const ct = readVolumeScalarsRelaxed(ctVolumeId);
  if (!ct) return null;
  const { width: W, height: H, depth: D } = ct.dims;
  const v = ct.voxels;
  const WH = W * H;
  let best = -1;
  let bestDiff = Infinity;
  const x0 = (W * 0.35) | 0;
  const x1 = (W * 0.65) | 0;
  const y0 = (H * 0.3) | 0;
  const y1 = (H * 0.7) | 0;
  const z0 = (D * 0.2) | 0;
  const z1 = (D * 0.8) | 0;
  for (let z = z0; z < z1; z += 2) {
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = z * WH + y * W + x;
        const c = v[i];
        if (Math.abs(c - targetHu) > 60) continue;
        // Require a COHERENT interior: all 6 neighbours also near target. This
        // avoids seeding on a lone noisy/edge voxel (or a hole in a partially
        // loaded volume) that would grow nothing.
        if (
          Math.abs(v[i - 1] - targetHu) > 110 ||
          Math.abs(v[i + 1] - targetHu) > 110 ||
          Math.abs(v[i - W] - targetHu) > 110 ||
          Math.abs(v[i + W] - targetHu) > 110 ||
          Math.abs(v[i - WH] - targetHu) > 110 ||
          Math.abs(v[i + WH] - targetHu) > 110
        ) {
          continue;
        }
        const diff = Math.abs(c - targetHu);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
          if (diff === 0) return best;
        }
      }
    }
  }
  return best;
}

/** keep-predicate for buildMaskedIntensityVolume backed by a region-grow mask. */
export function maskKeep(mask: Uint8Array): (hu: number, index: number) => boolean {
  return (_hu: number, index: number) => mask[index] === 1;
}

// ============================================================================
// VR ray-pick — click on the 3D render → seed voxel
// ============================================================================
// A VOLUME_3D viewport can't surface-pick directly, so we software-ray-march:
// build the camera ray through the clicked canvas point and walk it through the
// volume, returning the FIRST voxel whose HU is dense enough to be "the surface
// the operator clicked on". That voxel seeds the region grow.

type Vec3 = [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

interface PickViewportLike {
  getCamera?: () => { position?: number[]; focalPoint?: number[] };
  canvasToWorld?: (canvas: [number, number]) => number[];
}

/**
 * Ray-march from the camera through the clicked canvas point and return the first
 * voxel index with HU ≥ surfaceThreshold (the clicked structure's near surface),
 * or null if the ray misses anything dense. `canvasX/Y` are viewport-relative CSS
 * pixels.
 */
export function pickSeedVoxel(
  renderingEngineId: string,
  vrViewportId: string,
  ctVolumeId: string,
  canvasX: number,
  canvasY: number,
  surfaceThreshold = 150,
  preferContrast = true
): number | null {
  const re = getRenderingEngine(renderingEngineId);
  const vp = re?.getViewport(vrViewportId) as unknown as PickViewportLike | undefined;
  if (!vp?.getCamera || !vp.canvasToWorld) return null;

  const cam = vp.getCamera();
  const pos = (cam.position ?? []) as Vec3;
  const focal = (cam.focalPoint ?? []) as Vec3;
  const world = vp.canvasToWorld([canvasX, canvasY]) as Vec3;
  if (pos.length < 3 || world.length < 3) return null;

  const dirRaw = sub(world, pos);
  const dl = norm(dirRaw);
  if (dl === 0) return null;
  const dir: Vec3 = [dirRaw[0] / dl, dirRaw[1] / dl, dirRaw[2] / dl];

  const ct = readVolumeScalarsRelaxed(ctVolumeId);
  if (!ct) return null;
  const vol = getCachedVolume<{ imageData?: { worldToIndex?: (p: number[]) => number[] } }>(cache, ctVolumeId);
  const imageData = vol?.imageData;
  if (!imageData?.worldToIndex) return null;

  const W = ct.dims.width;
  const H = ct.dims.height;
  const D = ct.dims.depth;
  const WH = W * H;
  const v = ct.voxels;

  // March a window centred on the focal plane (≈ volume centre) outward both ways.
  const dFocal = norm(sub(focal, pos));
  const step = 0.5; // mm
  const startT = Math.max(0, dFocal - 300);
  const endT = dFocal + 300;

  // Collect two candidates while walking the ray:
  //   firstDenseIdx — first voxel ≥ surfaceThreshold (fallback; e.g. a direct bone click).
  //   bestBandIdx   — the voxel in the contrast/structure band whose depth is CLOSEST to
  //                   the focal plane. A front-on ray crosses the sternum (cortical bone,
  //                   above the band ceiling) first, then the contrast lumen near the
  //                   centre — so "nearest focal" steps past the chest wall and lands in
  //                   the blood pool the operator aimed at, instead of seeding bone.
  let firstDenseIdx = -1;
  let bestBandIdx = -1;
  let bestBandDist = Infinity;
  for (let t = startT; t <= endT; t += step) {
    const p: number[] = [pos[0] + dir[0] * t, pos[1] + dir[1] * t, pos[2] + dir[2] * t];
    let ijk: number[];
    try {
      ijk = imageData.worldToIndex(p);
    } catch (err) {
      console.warn('[structureIsolation] ray worldToIndex probe failed:', err);
      continue;
    }
    const i = Math.round(ijk[0]);
    const j = Math.round(ijk[1]);
    const k = Math.round(ijk[2]);
    if (i < 0 || i >= W || j < 0 || j >= H || k < 0 || k >= D) continue;
    const idx = k * WH + j * W + i;
    const hu = v[idx];
    if (hu >= surfaceThreshold && firstDenseIdx < 0) firstDenseIdx = idx;
    if (hu >= CONTRAST_BAND_LO && hu <= CONTRAST_BAND_HI) {
      const dist = Math.abs(t - dFocal);
      if (dist < bestBandDist) {
        bestBandDist = dist;
        bestBandIdx = idx;
      }
    }
  }
  // Isolate (preferContrast) steps PAST bone into the contrast lumen; Remove wants the
  // FIRST dense surface the ray hits (the bone in front) so "click the sternum → remove
  // the sternum", not the aorta behind it.
  if (preferContrast && bestBandIdx >= 0) return bestBandIdx;
  if (firstDenseIdx >= 0) return firstDenseIdx;
  return bestBandIdx >= 0 ? bestBandIdx : null;
}

// ----------------------------------------------------------------------------
// Click-to-isolate (production entry point)
// ----------------------------------------------------------------------------

/** Result of {@link isolateStructureAtPoint}. */
export interface IsolateAtPointResult {
  /**
   * - `ok`        → a structure was isolated; `seed`/`count`/`capped` are set.
   * - `no-hit`    → the click ray missed any dense surface (e.g. clicked empty air).
   * - `no-data`   → the CT volume scalars were not readable (still streaming / evicted).
   * - `capped`    → the grow hit the safety cap; VR left untouched because the
   *                 isolated structure may be clipped.
   * - `no-mask`   → the masked-intensity volume could not be built.
   * - `no-viewport` → the VR viewport could not accept the masked volume.
   * - `empty`     → the grow produced ZERO voxels (seed out of band) — VR left untouched.
   * - `too-small` → the grown region was below `minKeepVoxels` (likely a mis-click on a
   *                 noise fleck) — VR left untouched so the pane never blanks.
   */
  status: 'ok' | 'no-hit' | 'no-data' | 'no-mask' | 'no-viewport' | 'empty' | 'too-small' | 'capped';
  /** Seed voxel index the ray landed on (status==='ok'). */
  seed?: number;
  /** Number of connected voxels kept in the isolated structure. */
  count?: number;
  /** True if the grow hit the `maxVoxels` safety cap (structure may be clipped). */
  capped?: boolean;
}

/**
 * Click-to-isolate: ray-pick the structure under a viewport-relative canvas
 * point, region-grow the connected lumen/structure from that seed, and render
 * ONLY it (everything else fades to air). This is the single shared
 * implementation behind both the production "Isolate" toolbar control and the
 * DEV `window.__isolation.clickIsolate` harness.
 *
 * @param renderingEngineId  Cornerstone3D rendering engine id.
 * @param vrViewportId       the VOLUME_3D (VR) viewport id to isolate within.
 * @param ctVolumeId         the loaded CT volume backing that VR viewport.
 * @param canvasX            click X in VIEWPORT-RELATIVE CSS pixels.
 * @param canvasY            click Y in VIEWPORT-RELATIVE CSS pixels.
 * @param opts.tolerance        HU band half-width for the region grow (default 80).
 * @param opts.surfaceThreshold HU floor that counts as a "surface" hit (default 150).
 * @param opts.ghostOpacity     opacity for the faded background (default 0 = hidden).
 * @param opts.minKeepVoxels    minimum grown-region size to render; below this we return
 *                              `too-small` and leave the VR untouched (default 200).
 * @param opts.openIterations   morphological-opening passes to sever bone bridges on
 *                              thick regions (default 1; 0 disables).
 */
export async function isolateStructureAtPoint(
  renderingEngineId: string,
  vrViewportId: string,
  ctVolumeId: string,
  canvasX: number,
  canvasY: number,
  opts: {
    tolerance?: number;
    surfaceThreshold?: number;
    ghostOpacity?: number;
    minKeepVoxels?: number;
    openIterations?: number;
    presetVtkName?: string;
  } = {}
): Promise<IsolateAtPointResult> {
  const {
    tolerance = 80,
    surfaceThreshold = 150,
    ghostOpacity = 0,
    minKeepVoxels = 200,
    openIterations = 1,
    presetVtkName = 'CT-Coronary-Arteries-2',
  } = opts;
  const seed = pickSeedVoxel(renderingEngineId, vrViewportId, ctVolumeId, canvasX, canvasY, surfaceThreshold);
  if (seed == null) {
    return { status: 'no-hit' };
  }
  const grow = growMaskFromSeed(ctVolumeId, seed, { tolerance, minHu: 120, maxVoxels: 4_000_000 });
  if (!grow) {
    return { status: 'no-data' };
  }
  // Empty grow → never render (would blank the VR). Leave the prior view intact.
  if (grow.count === 0) {
    return { status: 'empty' };
  }
  if (grow.capped) {
    return { status: 'capped', count: grow.count, capped: true };
  }
  // Sever sub-voxel-thin bone bridges, but only on regions thick enough to survive a
  // 1-voxel erosion (skips thin vessels the opening would erase).
  let keepCount = grow.count;
  if (openIterations > 0 && grow.bbox && grow.dims && grow.count >= minKeepVoxels * 4) {
    keepCount = morphologicalOpen(grow.mask, grow.dims, grow.bbox, openIterations);
  }
  if (keepCount < minKeepVoxels) {
    return { status: 'too-small', count: keepCount };
  }
  const maskedVolumeId =
    grow.bbox && grow.dims
      ? buildMaskedIntensityVolumeFromMask(ctVolumeId, grow.mask, grow.bbox, grow.dims)
      : buildMaskedIntensityVolume(ctVolumeId, maskKeep(grow.mask));
  if (!maskedVolumeId) {
    return { status: 'no-mask' };
  }
  const applied = await applyIsolation(renderingEngineId, vrViewportId, ctVolumeId, maskedVolumeId, ghostOpacity, presetVtkName);
  if (!applied) {
    return { status: 'no-viewport' };
  }
  return { status: 'ok', seed, count: keepCount, capped: grow.capped };
}

// ============================================================================
// Structure REMOVAL — the inverse of isolate ("cut away" / sculpt)
// ============================================================================
// Isolate KEEPS the clicked structure and discards everything else. Removal does
// the opposite: it discards the clicked structure (or a dragged screen region) and
// KEEPS everything else — the clinical "peel the sternum/ribs off so I can see the
// heart behind it" workflow. Two entry points share ONE cumulative accumulator so
// click-cuts and scalpel-cuts combine and reset together:
//   • removeStructureAtPoint  — click a structure → region-grow → AIR it out.
//   • removeFrustumByRect     — drag a screen rectangle → AIR the projected frustum.
// Both write a "CT-minus-removals" intensity volume and re-apply the operator's
// CURRENT preset (NOT the bold isolate TF) so the volume looks normal, just minus
// the cut.

/** Default VR preset used when the caller doesn't pass the live one (mirrors clearIsolation). */
const DEFAULT_VR_PRESET = 'CT-Coronary-Arteries-2';

/** Per-CT accumulator: the working "CT with removed voxels set to AIR" buffer + a cut count. */
interface RemovalState {
  dst: Int16Array;
  cuts: number;
}
const removalStateByVolume = new Map<string, RemovalState>();

/**
 * Get-or-create the cumulative removal buffer for a CT volume. We only ever cut the
 * ONE active VR volume, so any accumulator for a DIFFERENT (prior) volume id is stale
 * → drop it to bound memory (each buffer is a full Int16 CT copy ~146 MB decimated).
 */
function getOrInitRemovalState(ctVolumeId: string, voxels: Int16Array): RemovalState {
  let state = removalStateByVolume.get(ctVolumeId);
  if (!state || state.dst.length !== voxels.length) {
    for (const key of removalStateByVolume.keys()) {
      if (key !== ctVolumeId) removalStateByVolume.delete(key);
    }
    state = { dst: Int16Array.from(voxels), cuts: 0 };
    removalStateByVolume.set(ctVolumeId, state);
  }
  return state;
}

/** Number of cut operations currently applied to a CT volume (for the "Cuts: N" indicator). */
export function getRemovalCutCount(ctVolumeId: string): number {
  return removalStateByVolume.get(ctVolumeId)?.cuts ?? 0;
}

export interface RemoveAtPointResult {
  /**
   * Same semantics as IsolateAtPointResult, plus removal-specific `no-projection`
   * (the scalpel could not resolve a reliable screen→voxel projection).
   */
  status: 'ok' | 'no-hit' | 'no-data' | 'no-mask' | 'no-viewport' | 'empty' | 'too-small' | 'capped' | 'no-projection';
  /** Voxels removed by THIS operation. */
  count?: number;
  /** True if region growth hit the max-voxel safety cap and no removal was applied. */
  capped?: boolean;
  /** Total cut operations applied so far (status==='ok'). */
  cuts?: number;
}

/** Viewport-relative screen rectangle (CSS px), as captured from a scalpel drag. */
export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Ensure the derived masked volume exists and write `dst` into it. Reuses the SAME
 * `${ctVolumeId}${MASKED_VOLUME_SUFFIX}` sibling isolate uses (modes are mutually
 * exclusive; switching modes clears state). Never calls getScalarData (throws on
 * derived volumes in CS3D 4.22.6) — only setCompleteScalarDataArray.
 */
function commitMaskedVolume(ctVolumeId: string, dst: Int16Array): string | null {
  const maskedVolumeId = `${ctVolumeId}${MASKED_VOLUME_SUFFIX}`;
  try {
    if (!cache.getVolume?.(maskedVolumeId)) {
      volumeLoader.createAndCacheDerivedVolume(ctVolumeId, { volumeId: maskedVolumeId });
    }
  } catch (err) {
    console.warn('[structureIsolation] derive removal volume failed:', err);
    return null;
  }
  const masked = cache.getVolume?.(maskedVolumeId) as
    | { voxelManager?: { setCompleteScalarDataArray?: (a: ArrayLike<number>) => void }; imageData?: { modified?: () => void } }
    | undefined;
  if (!masked) return null;
  try {
    masked.voxelManager?.setCompleteScalarDataArray?.(dst);
    masked.imageData?.modified?.();
  } catch (err) {
    console.warn('[structureIsolation] write removal scalars failed:', err);
    return null;
  }
  return maskedVolumeId;
}

/**
 * Apply a removal: swap the VR viewport onto the masked ("CT-minus-removals") volume
 * and RE-APPLY the operator's current preset, so the render looks normal minus the cut
 * (unlike applyIsolation, which styles a bold opaque "pop" TF).
 */
export async function applyRemoval(
  renderingEngineId: string,
  vrViewportId: string,
  maskedVolumeId: string,
  presetVtkName: string
): Promise<boolean> {
  const vp = getVolume3DViewport(renderingEngineId, vrViewportId);
  if (!vp) {
    console.warn('[structureIsolation] applyRemoval failed: VOLUME_3D viewport setVolumes unavailable');
    return false;
  }
  const savedPlanes = captureClippingPlanes(vp);
  try {
    await vp.setVolumes?.([{ volumeId: maskedVolumeId }], false);
    restoreClippingPlanes(vp, savedPlanes);
  } catch (err) {
    console.warn('[structureIsolation] applyRemoval setVolumes failed:', err);
    return false;
  }
  try {
    vp.setProperties?.({ preset: presetVtkName });
  } catch (err) {
    console.warn('[structureIsolation] applyRemoval preset failed:', err);
  }
  vp.render?.();
  return true;
}

/**
 * Clear ALL removals: drop the accumulator, rebind the VR pane to the pristine CT
 * volume, re-apply the preset, and evict the masked sibling. Safe to call when no
 * removal was ever applied.
 */
export async function clearRemovals(
  renderingEngineId: string,
  vrViewportId: string,
  ctVolumeId: string,
  restorePresetVtkName = DEFAULT_VR_PRESET
): Promise<void> {
  removalStateByVolume.delete(ctVolumeId);
  const re = getRenderingEngine(renderingEngineId);
  const vp = re?.getViewport(vrViewportId) as unknown as VrViewportLike | undefined;
  if (vp?.setVolumes) {
    const savedPlanes = captureClippingPlanes(vp);
    try {
      await vp.setVolumes?.([{ volumeId: ctVolumeId }], false);
      restoreClippingPlanes(vp, savedPlanes);
      vp.setProperties?.({ preset: restorePresetVtkName });
    } catch (err) {
      console.warn('[structureIsolation] clearRemovals setVolumes failed:', err);
    }
    vp.render?.();
  }
  try {
    cache.removeVolumeLoadObject?.(`${ctVolumeId}${MASKED_VOLUME_SUFFIX}`);
  } catch (err) {
    console.warn('[structureIsolation] clear removals cache eviction failed:', err);
  }
}

/**
 * CLICK-TO-REMOVE (cumulative). Region-grow the structure under the click and set it
 * to AIR in the accumulator, leaving everything else intact. Re-clickable to peel
 * away more (sternum → ribs → spine). Guards exactly like isolateStructureAtPoint so
 * an empty / too-small / mis-click leaves the view untouched.
 */
export async function removeStructureAtPoint(
  renderingEngineId: string,
  vrViewportId: string,
  ctVolumeId: string,
  canvasX: number,
  canvasY: number,
  opts: {
    tolerance?: number;
    surfaceThreshold?: number;
    minKeepVoxels?: number;
    openIterations?: number;
    presetVtkName?: string;
  } = {}
): Promise<RemoveAtPointResult> {
  const {
    tolerance = 80,
    surfaceThreshold = 150,
    minKeepVoxels = 200,
    openIterations = 1,
    presetVtkName = DEFAULT_VR_PRESET,
  } = opts;
  const ct = readVolumeScalarsRelaxed(ctVolumeId);
  if (!ct) return { status: 'no-data' };
  // Remove uses a FIRST-HIT pick (preferContrast=false) so clicking a bone removes that
  // bone, not the contrast lumen behind it.
  const seed = pickSeedVoxel(renderingEngineId, vrViewportId, ctVolumeId, canvasX, canvasY, surfaceThreshold, false);
  if (seed == null) return { status: 'no-hit' };
  const grow = growMaskFromSeed(ctVolumeId, seed, { tolerance, minHu: 120, maxVoxels: 4_000_000 });
  if (!grow) return { status: 'no-data' };
  if (grow.count === 0) return { status: 'empty' };
  if (grow.capped) return { status: 'capped', count: grow.count, capped: true };
  let keepCount = grow.count;
  if (openIterations > 0 && grow.bbox && grow.dims && grow.count >= minKeepVoxels * 4) {
    keepCount = morphologicalOpen(grow.mask, grow.dims, grow.bbox, openIterations);
  }
  if (keepCount < minKeepVoxels) return { status: 'too-small', count: keepCount };
  if (!grow.bbox || !grow.dims) return { status: 'no-mask' };

  // Get-or-init the cumulative buffer (a full CT copy on the first cut).
  const state = getOrInitRemovalState(ctVolumeId, ct.voxels);
  // AIR the grown region within its bbox — the INVERSE of isolate's keep.
  const { width: W, height: H } = grow.dims;
  const WH = W * H;
  const { bbox, mask } = grow;
  for (let z = bbox.z0; z <= bbox.z1; z++) {
    for (let y = bbox.y0; y <= bbox.y1; y++) {
      const row = z * WH + y * W;
      for (let x = bbox.x0; x <= bbox.x1; x++) {
        const idx = row + x;
        if (mask[idx] === 1) state.dst[idx] = AIR_HU;
      }
    }
  }
  const maskedVolumeId = commitMaskedVolume(ctVolumeId, state.dst);
  if (!maskedVolumeId) return { status: 'no-mask' };
  const applied = await applyRemoval(renderingEngineId, vrViewportId, maskedVolumeId, presetVtkName);
  if (!applied) return { status: 'no-viewport' };
  state.cuts++;
  return { status: 'ok', count: keepCount, cuts: state.cuts };
}

// --- Scalpel projection plumbing ---------------------------------------------
interface ProjViewportLike extends VrViewportLike {
  worldToCanvas?: (world: [number, number, number]) => [number, number] | undefined;
  getRenderer?: () =>
    | {
        getActiveCamera?: () =>
          | { getCompositeProjectionMatrix?: (aspect: number, nearz: number, farz: number) => number[] }
          | undefined;
      }
    | undefined;
  getCanvas?: () => { width: number; height: number } | undefined;
}
interface ImageDataIndexToWorld {
  indexToWorld?: (index: [number, number, number], out?: [number, number, number]) => [number, number, number];
}

/**
 * Build a fast world→canvas projector for the current camera, CALIBRATED against the
 * viewport's own `worldToCanvas` at the 8 volume corners. We do the perspective math
 * via the composite matrix (cheap per voxel) but fit `ndc→canvas` linearly so any
 * display/offset/DPR convention is absorbed. Returns null (→ caller reports
 * `no-projection`) if the matrix convention doesn't fit (>6px residual) — never cut
 * garbage.
 */
function buildVoxelProjector(
  vp: ProjViewportLike,
  dims: { width: number; height: number; depth: number },
  imageData: ImageDataIndexToWorld
): ((wx: number, wy: number, wz: number) => [number, number] | null) | null {
  const camera = vp.getRenderer?.()?.getActiveCamera?.();
  const canvas = vp.getCanvas?.();
  if (!camera?.getCompositeProjectionMatrix || !vp.worldToCanvas || !canvas || !imageData.indexToWorld) {
    return null;
  }
  const aspect = canvas.width / Math.max(1, canvas.height);
  const M = camera.getCompositeProjectionMatrix(aspect, -1, 1);
  if (!M || M.length < 16) return null;

  // vtk.js returns getCompositeProjectionMatrix in a layout it `mat4.transpose`s before
  // use (see vtk.js PixelSpaceCallbackMapper). Rather than hardcode a convention, try
  // BOTH the column-major and row-major (transposed) reads, calibrate each against
  // worldToCanvas at the 8 corners, and keep whichever fits — version-proof.
  const { width: W, height: H, depth: D } = dims;
  const worlds: Array<[number, number, number]> = [];
  const canv: Array<[number, number]> = [];
  for (const i of [0, W - 1]) {
    for (const j of [0, H - 1]) {
      for (const k of [0, D - 1]) {
        const w = imageData.indexToWorld([i, j, k]);
        const cnv = vp.worldToCanvas?.([w[0], w[1], w[2]]);
        if (w && cnv) {
          worlds.push([w[0], w[1], w[2]]);
          canv.push(cnv);
        }
      }
    }
  }
  if (worlds.length < 2) return null;

  const colMajor = (wx: number, wy: number, wz: number): [number, number] | null => {
    const cw = M[3] * wx + M[7] * wy + M[11] * wz + M[15];
    if (!cw) return null;
    return [(M[0] * wx + M[4] * wy + M[8] * wz + M[12]) / cw, (M[1] * wx + M[5] * wy + M[9] * wz + M[13]) / cw];
  };
  const rowMajor = (wx: number, wy: number, wz: number): [number, number] | null => {
    const cw = M[12] * wx + M[13] * wy + M[14] * wz + M[15];
    if (!cw) return null;
    return [(M[0] * wx + M[1] * wy + M[2] * wz + M[3]) / cw, (M[4] * wx + M[5] * wy + M[6] * wz + M[7]) / cw];
  };

  // Fit canvasX=a*ndcX+b, canvasY=c*ndcY+d for a candidate projection; return {fn,resid}.
  const calibrate = (
    toNdc: (wx: number, wy: number, wz: number) => [number, number] | null,
  ): { fn: (wx: number, wy: number, wz: number) => [number, number] | null; resid: number } | null => {
    let n = 0, sxn = 0, sx = 0, sxx = 0, sxc = 0, syn = 0, sy = 0, syy = 0, syc = 0;
    const nd: Array<[number, number] | null> = [];
    for (let i = 0; i < worlds.length; i++) {
      const ndc = toNdc(worlds[i][0], worlds[i][1], worlds[i][2]);
      nd.push(ndc);
      if (!ndc) continue;
      const cnv = canv[i];
      sxn += ndc[0]; sx += cnv[0]; sxx += ndc[0] * ndc[0]; sxc += ndc[0] * cnv[0];
      syn += ndc[1]; sy += cnv[1]; syy += ndc[1] * ndc[1]; syc += ndc[1] * cnv[1];
      n++;
    }
    if (n < 2) return null;
    const denomX = n * sxx - sxn * sxn;
    const denomY = n * syy - syn * syn;
    if (!denomX || !denomY) return null;
    const a = (n * sxc - sxn * sx) / denomX;
    const b = (sx - a * sxn) / n;
    const c = (n * syc - syn * sy) / denomY;
    const d = (sy - c * syn) / n;
    let resid = 0;
    for (let i = 0; i < nd.length; i++) {
      const ndc = nd[i];
      if (!ndc) continue;
      resid = Math.max(resid, Math.abs(a * ndc[0] + b - canv[i][0]), Math.abs(c * ndc[1] + d - canv[i][1]));
    }
    return {
      fn: (wx, wy, wz) => {
        const ndc = toNdc(wx, wy, wz);
        return ndc ? [a * ndc[0] + b, c * ndc[1] + d] : null;
      },
      resid,
    };
  };

  const col = calibrate(colMajor);
  const row = calibrate(rowMajor);
  const best = !col ? row : !row ? col : col.resid <= row.resid ? col : row;
  if (!best || best.resid > 6) return null; // neither convention fits — bail rather than mis-cut
  return best.fn;
}

/**
 * SCALPEL-DRAG. Remove every voxel whose projected screen position falls inside the
 * dragged rectangle (a view-aligned frustum — it cuts the full depth behind the box,
 * by design, for bulk edge clutter like the scanner table or an arm). Shares the
 * cumulative accumulator with click-remove, and rAF-chunks the voxel sweep so the UI
 * never freezes.
 */
export async function removeFrustumByRect(
  renderingEngineId: string,
  vrViewportId: string,
  ctVolumeId: string,
  rect: ScreenRect,
  presetVtkName = DEFAULT_VR_PRESET
): Promise<RemoveAtPointResult> {
  const ct = readVolumeScalarsRelaxed(ctVolumeId);
  if (!ct) return { status: 'no-data' };
  const re = getRenderingEngine(renderingEngineId);
  const vp = re?.getViewport(vrViewportId) as unknown as ProjViewportLike | undefined;
  const imageData = getCachedVolume<{ imageData?: ImageDataIndexToWorld }>(cache, ctVolumeId)?.imageData;
  if (!vp || !imageData?.indexToWorld) return { status: 'no-projection' };

  const project = buildVoxelProjector(vp, ct.dims, imageData);
  if (!project) return { status: 'no-projection' };

  const xMin = Math.min(rect.x0, rect.x1), xMax = Math.max(rect.x0, rect.x1);
  const yMin = Math.min(rect.y0, rect.y1), yMax = Math.max(rect.y0, rect.y1);
  if (xMax - xMin < 3 || yMax - yMin < 3) return { status: 'too-small' };

  const state = getOrInitRemovalState(ctVolumeId, ct.voxels);
  const { width: W, height: H, depth: D } = ct.dims;
  const WH = W * H;

  // World step vectors from the volume's OWN indexToWorld — exact, convention-free.
  const w000 = imageData.indexToWorld([0, 0, 0]);
  const wI = imageData.indexToWorld([1, 0, 0]);
  const wJ = imageData.indexToWorld([0, 1, 0]);
  const wK = imageData.indexToWorld([0, 0, 1]);
  const ix = wI[0] - w000[0], iy = wI[1] - w000[1], iz = wI[2] - w000[2];
  const jx = wJ[0] - w000[0], jy = wJ[1] - w000[1], jz = wJ[2] - w000[2];
  const kx = wK[0] - w000[0], ky = wK[1] - w000[1], kz = wK[2] - w000[2];
  const dst = state.dst;

  let removed = 0;
  await new Promise<void>((resolve) => {
    let z = 0;
    const slicesPerFrame = Math.max(4, Math.floor((24 * 280) / Math.max(1, D)));
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 0);
    const step = (): void => {
      const zEnd = Math.min(D, z + slicesPerFrame);
      for (; z < zEnd; z++) {
        const bzx = w000[0] + z * kx, bzy = w000[1] + z * ky, bzz = w000[2] + z * kz;
        for (let y = 0; y < H; y++) {
          const byx = bzx + y * jx, byy = bzy + y * jy, byz = bzz + y * jz;
          const row = z * WH + y * W;
          for (let x = 0; x < W; x++) {
            const idx = row + x;
            if (dst[idx] === AIR_HU) continue; // already cut / air
            const cnv = project(byx + x * ix, byy + x * iy, byz + x * iz);
            if (cnv && cnv[0] >= xMin && cnv[0] <= xMax && cnv[1] >= yMin && cnv[1] <= yMax) {
              dst[idx] = AIR_HU;
              removed++;
            }
          }
        }
      }
      if (z < D) raf(step);
      else resolve();
    };
    step();
  });

  if (removed === 0) return { status: 'empty' };
  const maskedVolumeId = commitMaskedVolume(ctVolumeId, dst);
  if (!maskedVolumeId) return { status: 'no-mask' };
  const applied = await applyRemoval(renderingEngineId, vrViewportId, maskedVolumeId, presetVtkName);
  if (!applied) return { status: 'no-viewport' };
  state.cuts++;
  return { status: 'ok', count: removed, cuts: state.cuts };
}
