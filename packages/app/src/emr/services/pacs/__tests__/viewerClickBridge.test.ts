// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * viewerClickBridge unit tests (Phase H7).
 *
 * The module under test is intentionally Cornerstone3D-state-free, so we
 * can fake the entire viewport surface with a plain object. The goal of
 * these tests is to verify the *math* — canvas → world → voxel + the
 * Couinaud labelmap sampling — without booting vtk.js.
 */

import { describe, expect, it } from 'vitest';

import {
  orientationFromViewportId,
  resolveCanvasClick,
  resolveSegmentationId,
  VIEWPORT_IDS,
  __test,
} from '../viewerClickBridge';
import type { NiftiMask } from '../niftiLoader';

const { sampleNiftiAt } = __test;

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

/**
 * Build a viewport stub that returns a configurable world coord on
 * `canvasToWorld` and a fixed-dims volume on `getImageData`. Keeps the
 * tests focused on the bridge logic, not on Cornerstone3D internals.
 */
function makeViewport(opts: {
  id: string;
  world: [number, number, number];
  dims?: [number, number, number];
  /** Maps the world coord to an index. Defaults to identity (= 1mm spacing,
   *  identity direction cosines, origin at 0). */
  indexFromWorld?: (w: [number, number, number]) => [number, number, number];
  /** When true, throw from canvasToWorld to simulate the missing-actor
   *  crash that motivated the try/catch in resolveCanvasClick. */
  throwOnCanvas?: boolean;
  /** When true, return an undefined imageData so the null-guard fires. */
  missingImageData?: boolean;
}) {
  const dims = opts.dims ?? [256, 256, 100];
  return {
    id: opts.id,
    canvasToWorld: (_canvas: [number, number]) => {
      if (opts.throwOnCanvas) throw new Error('getDefaultActor');
      return opts.world;
    },
    getImageData: () => {
      if (opts.missingImageData) return undefined;
      return {
        imageData: {
          worldToIndex: opts.indexFromWorld ?? ((w) => w),
          getDimensions: () => dims,
        },
      };
    },
  };
}

/** Build a NiftiMask stub with a single non-zero voxel for sampling tests. */
function makeNiftiMask(
  dims: [number, number, number],
  hitAt: [number, number, number],
  hitValue = 1,
): NiftiMask {
  const total = dims[0] * dims[1] * dims[2];
  const voxels = new Uint8Array(total);
  const [hi, hj, hk] = hitAt;
  voxels[hi + dims[0] * (hj + dims[1] * hk)] = hitValue;
  return {
    dims,
    voxels,
    // NiftiMask carries more fields in production but the bridge module
    // only reads `dims` and `voxels`. Cast through unknown to keep the
    // surface area of the test minimal.
  } as unknown as NiftiMask;
}

// ---------------------------------------------------------------------------
// orientationFromViewportId
// ---------------------------------------------------------------------------

describe('orientationFromViewportId', () => {
  it('maps every canonical id to its orientation', () => {
    expect(orientationFromViewportId(VIEWPORT_IDS.stack)).toBe('stack');
    expect(orientationFromViewportId(VIEWPORT_IDS.axial)).toBe('axial');
    expect(orientationFromViewportId(VIEWPORT_IDS.sagittal)).toBe('sagittal');
    expect(orientationFromViewportId(VIEWPORT_IDS.coronal)).toBe('coronal');
  });

  it('returns null for unknown ids', () => {
    expect(orientationFromViewportId('liverra-something-else')).toBeNull();
    expect(orientationFromViewportId('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveCanvasClick — happy path + edge cases
// ---------------------------------------------------------------------------

describe('resolveCanvasClick', () => {
  it('returns integer voxel + world for an in-bounds click', () => {
    const vp = makeViewport({
      id: VIEWPORT_IDS.axial,
      world: [100, 100, 50],
      dims: [256, 256, 100],
    });
    const click = resolveCanvasClick(vp as never, [200, 200]);
    expect(click).not.toBeNull();
    expect(click!.voxel).toEqual([100, 100, 50]);
    expect(click!.world).toEqual([100, 100, 50]);
    expect(click!.orientation).toBe('axial');
    expect(click!.viewportId).toBe(VIEWPORT_IDS.axial);
  });

  it('rounds fractional world→index results to integer voxels', () => {
    const vp = makeViewport({
      id: VIEWPORT_IDS.axial,
      world: [100.4, 100.6, 50.5],
    });
    const click = resolveCanvasClick(vp as never, [0, 0]);
    // Math.round breaks halves toward +∞: 50.5 → 51, 100.4 → 100, 100.6 → 101.
    expect(click!.voxel).toEqual([100, 101, 51]);
  });

  it('clamps voxels outside the volume into the volume', () => {
    // A click that lands well outside the volume (MPR letterbox / out of
    // FOV) should not return null — instead it clamps to the volume
    // boundary. The earlier strict-tolerance gate broke many real clicks;
    // see commit history.
    const vp = makeViewport({
      id: VIEWPORT_IDS.axial,
      world: [-490, 999, -10],
      dims: [256, 256, 100],
    });
    const click = resolveCanvasClick(vp as never, [0, 0]);
    expect(click).not.toBeNull();
    expect(click!.voxel).toEqual([0, 255, 0]);
  });

  it('returns null when the viewport id is not one we know', () => {
    const vp = makeViewport({ id: 'rando-viewport', world: [0, 0, 0] });
    expect(resolveCanvasClick(vp as never, [0, 0])).toBeNull();
  });

  it('returns null when canvasToWorld throws (no actor yet)', () => {
    const vp = makeViewport({
      id: VIEWPORT_IDS.axial,
      world: [0, 0, 0],
      throwOnCanvas: true,
    });
    expect(resolveCanvasClick(vp as never, [0, 0])).toBeNull();
  });

  it('returns null when getImageData returns no imageData', () => {
    const vp = makeViewport({
      id: VIEWPORT_IDS.axial,
      world: [0, 0, 0],
      missingImageData: true,
    });
    expect(resolveCanvasClick(vp as never, [0, 0])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveSegmentationId — labelmap sampling
// ---------------------------------------------------------------------------

describe('resolveSegmentationId', () => {
  it('returns the matching Couinaud segment when a labelmap hits', () => {
    const dims: [number, number, number] = [10, 10, 10];
    const labelmaps = new Map<string, NiftiMask>([
      ['couinaud-vii', makeNiftiMask(dims, [5, 5, 5])],
    ]);
    const result = resolveSegmentationId([5, 5, 5], labelmaps);
    expect(result.segmentationId).toBe('couinaud-vii');
    expect(result.couinaudSegment).toBe('VII');
  });

  it('falls back to parenchyma when no Couinaud labelmap matches', () => {
    const dims: [number, number, number] = [10, 10, 10];
    const labelmaps = new Map<string, NiftiMask>([
      ['liver', makeNiftiMask(dims, [3, 3, 3])],
    ]);
    const result = resolveSegmentationId([3, 3, 3], labelmaps);
    expect(result.segmentationId).toBe('parenchyma');
    expect(result.couinaudSegment).toBeUndefined();
  });

  it('returns parenchyma as a sentinel when no labelmaps are loaded', () => {
    const result = resolveSegmentationId([5, 5, 5], new Map());
    expect(result.segmentationId).toBe('parenchyma');
  });

  it('Couinaud wins over parenchyma when both labelmaps cover the voxel', () => {
    const dims: [number, number, number] = [10, 10, 10];
    const labelmaps = new Map<string, NiftiMask>([
      ['couinaud-iv', makeNiftiMask(dims, [4, 4, 4])],
      ['liver', makeNiftiMask(dims, [4, 4, 4])],
    ]);
    const result = resolveSegmentationId([4, 4, 4], labelmaps);
    expect(result.segmentationId).toBe('couinaud-iv');
    expect(result.couinaudSegment).toBe('IV');
  });
});

// ---------------------------------------------------------------------------
// sampleNiftiAt — pure index math
// ---------------------------------------------------------------------------

describe('sampleNiftiAt', () => {
  it('reads the right voxel from the flat array (i + dx*(j + dy*k))', () => {
    const mask = makeNiftiMask([4, 4, 4], [1, 2, 3], 7);
    expect(sampleNiftiAt(mask, [1, 2, 3])).toBe(7);
    expect(sampleNiftiAt(mask, [0, 0, 0])).toBe(0);
  });

  it('returns 0 for out-of-bounds requests instead of throwing', () => {
    const mask = makeNiftiMask([4, 4, 4], [1, 2, 3]);
    expect(sampleNiftiAt(mask, [-1, 0, 0])).toBe(0);
    expect(sampleNiftiAt(mask, [0, -1, 0])).toBe(0);
    expect(sampleNiftiAt(mask, [10, 0, 0])).toBe(0);
    expect(sampleNiftiAt(mask, [0, 0, 99])).toBe(0);
  });
});
