// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure viewport/volume guards extracted from PACSViewer.tsx
// (finding EMR-PACS-IMAGING-AUDIT-009). These never had test coverage while
// buried in the 4000-line component.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Per-test controllable imagePlaneModule store. Hoisted via `vi.hoisted` so the
// vi.mock factory may reference it despite hoisting (vitest equivalent of the
// jest `mock`-prefix convention).
const mockPlaneMap = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@cornerstonejs/core', () => ({
  cache: { removeImageLoadObject: vi.fn() },
  metaData: {
    get: (_module: string, id: string): unknown => mockPlaneMap.get(id),
  },
}));

import {
  isStackViewport,
  isCachedVolumeUsable,
  decimateImageIdsForVr,
  canFormVolume,
} from './PACSViewer.volumeGuards';

beforeEach(() => {
  mockPlaneMap.clear();
});

describe('isStackViewport', () => {
  it('accepts an object with setStack/resetCamera/render', () => {
    expect(isStackViewport({ setStack: () => {}, resetCamera: () => {}, render: () => {} })).toBe(true);
  });

  it('rejects an object missing render', () => {
    expect(isStackViewport({ setStack: () => {}, resetCamera: () => {} })).toBe(false);
  });

  it('rejects a non-viewport object (no stack methods)', () => {
    // Note: matches the extracted-verbatim behavior — the guard is only ever
    // called on real viewport objects, so it does not null-guard (null throws,
    // by original design). Primitives without the methods return false.
    expect(isStackViewport(42)).toBe(false);
    expect(isStackViewport({ foo: 'bar' })).toBe(false);
  });
});

describe('isCachedVolumeUsable', () => {
  it('treats unknown (no loadStatus) shapes as reusable', () => {
    expect(isCachedVolumeUsable({})).toBe(true);
    expect(isCachedVolumeUsable(null)).toBe(true);
  });

  it('reuses a volume that is still actively streaming', () => {
    expect(isCachedVolumeUsable({ loadStatus: { loading: true, cachedFrames: [] } })).toBe(true);
  });

  it('rejects a settled volume with zero cached frames (the black-panes bug)', () => {
    expect(isCachedVolumeUsable({ loadStatus: { loaded: true, loading: false, cachedFrames: [] } })).toBe(false);
  });

  it('rejects a settled volume below the 50% loaded threshold', () => {
    // 4 frames, 1 loaded = 25% < 0.5
    expect(isCachedVolumeUsable({ loadStatus: { loaded: true, loading: false, cachedFrames: [1, 0, 0, 0] } })).toBe(false);
  });

  it('reuses a settled volume at/above the 50% loaded threshold', () => {
    // 4 frames, 2 loaded = 50% >= 0.5
    expect(isCachedVolumeUsable({ loadStatus: { loaded: true, loading: false, cachedFrames: [1, 1, 0, 0] } })).toBe(true);
  });
});

describe('decimateImageIdsForVr', () => {
  it('returns the same ids when at or below target', () => {
    const ids = ['a', 'b', 'c'];
    expect(decimateImageIdsForVr(ids, 10)).toBe(ids);
  });

  it('decimates above target and always preserves the last slice', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `img-${i}`);
    const out = decimateImageIdsForVr(ids, 10);
    expect(out.length).toBeLessThanOrEqual(11); // target + retained last slice
    expect(out[out.length - 1]).toBe('img-99');
    expect(out[0]).toBe('img-0');
  });
});

describe('canFormVolume', () => {
  const axialPlane = (z: number): unknown => ({
    imagePositionPatient: [0, 0, z],
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    pixelSpacing: [1, 1],
    columns: 512,
    rows: 512,
  });

  const seedSeries = (count: number): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `slice-${i}`;
      ids.push(id);
      mockPlaneMap.set(id, axialPlane(i)); // each slice 1mm apart in Z
    }
    return ids;
  };

  it('accepts a well-formed axial CT series', () => {
    expect(canFormVolume(seedSeries(5))).toBe(true);
  });

  it('rejects a series with fewer than 2 slices', () => {
    expect(canFormVolume(seedSeries(1))).toBe(false);
    expect(canFormVolume([])).toBe(false);
  });

  it('rejects when slice 0 lacks valid pixelSpacing', () => {
    const ids = seedSeries(5);
    mockPlaneMap.set(ids[0], {
      imagePositionPatient: [0, 0, 0],
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
      columns: 512,
      rows: 512,
      // pixelSpacing missing
    });
    expect(canFormVolume(ids)).toBe(false);
  });

  it('rejects when a deeper slice is missing imageOrientationPatient', () => {
    const ids = seedSeries(5);
    mockPlaneMap.set(ids[4], {
      imagePositionPatient: [0, 0, 4],
      pixelSpacing: [1, 1],
      columns: 512,
      rows: 512,
      // imageOrientationPatient missing → crash-class slice
    });
    expect(canFormVolume(ids)).toBe(false);
  });

  it('accepts a series with dropped slices (gaps = integer multiples of the median)', () => {
    // Real cardiac CTA pattern: uniform 0.8mm grid with a few slices missing,
    // producing scattered 1.6 / 2.4 / 4.0mm gaps. Must still be volumetric.
    const zs = [0, 0.8, 1.6, 3.2 /* 2 dropped */, 4.0, 4.8, 8.0 /* 4 dropped */, 8.8, 9.6];
    const ids: string[] = [];
    zs.forEach((z, i) => {
      const id = `gap-${i}`;
      ids.push(id);
      mockPlaneMap.set(id, axialPlane(z));
    });
    expect(canFormVolume(ids)).toBe(true);
  });

  it('rejects a series whose gaps are NOT integer multiples (true non-volume)', () => {
    const zs = [0, 0.8, 1.6, 2.1, 5.3, 5.9]; // 2.1, 5.3 are arbitrary offsets
    const ids: string[] = [];
    zs.forEach((z, i) => {
      const id = `irreg-${i}`;
      ids.push(id);
      mockPlaneMap.set(id, axialPlane(z));
    });
    expect(canFormVolume(ids)).toBe(false);
  });

  it('rejects a degenerate single-plane series (duplicate positions, zero span)', () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `dup-${i}`;
      ids.push(id);
      mockPlaneMap.set(id, axialPlane(0)); // all at the same Z → span 0
    }
    expect(canFormVolume(ids)).toBe(false);
  });
});
