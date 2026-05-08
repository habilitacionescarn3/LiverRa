// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FlrPlaneOverlay — Pass C3
 *
 * Plain-English: the cascade picks a "cutting plane" — the surgical plane
 * separating the part of the liver that will be removed (resected) from
 * the part that will remain (the future-liver remnant, FLR). This
 * component visualises that plane as a translucent purple line on each
 * orthogonal viewport. On the slice containing the plane, the marker is
 * solid; on adjacent slices it dims; far away, it disappears.
 *
 * Three input modes (in priority order):
 *   1. `plane_normal` + `plane_offset_mm` (preferred, exact 3D plane).
 *   2. `plane_pose` legacy heuristic with `axis: "axial"` + `z_index`.
 *   3. None of the above → component renders nothing.
 *
 * Today's MVP analyses all use mode (2) because the heuristic-axial-midpoint
 * stage emits `plane_pose` only. Mode (1) is wired for future work.
 *
 * Composition with the viewer:
 *   - The overlay is positioned absolutely over each viewport.
 *   - It does NOT block pointer events — scroll / pan / zoom still flow
 *     through to the Cornerstone canvas underneath.
 */

import { useMemo } from 'react';
import { Box } from '@mantine/core';
import type { ViewOrientation } from './LesionOverlay';

export interface FlrPlaneInput {
  plane_normal?: { x: number; y: number; z: number } | null;
  plane_offset_mm?: string | number | null;
  plane_pose?: {
    axis?: string;
    z_index?: number;
    bbox_z?: [number, number];
    heuristic?: string;
  } | null;
}

export interface FlrPlaneOverlayProps {
  flr: FlrPlaneInput | null;
  /** Which orientation this overlay sits on. */
  orientation: ViewOrientation;
  /** Current slice index in this viewport. */
  sliceIndex: number;
  /** Total slices in this viewport. */
  totalSlices: number;
  /** Voxel-space dims of the reference volume (matches mask + bbox grid). */
  volumeDims: [number, number, number];
  visible: boolean;
  'data-testid'?: string;
}

/** Resolve which voxel slice the plane lives on, per orientation. Returns
 *  null if the plane has no representation in this orientation. */
function planeVoxelSliceFor(
  flr: FlrPlaneInput,
  orientation: ViewOrientation,
  volumeDims: [number, number, number],
): number | null {
  // Mode 1: plane_normal + plane_offset_mm. We approximate by taking the
  // dominant component of the normal and converting offset → voxel index.
  if (flr.plane_normal && flr.plane_offset_mm !== null && flr.plane_offset_mm !== undefined) {
    const n = flr.plane_normal;
    const offsetMm = Number(flr.plane_offset_mm);
    if (Number.isFinite(offsetMm)) {
      const ax = Math.abs(n.x);
      const ay = Math.abs(n.y);
      const az = Math.abs(n.z);
      // Pick the dominant axis and assume 1mm voxel spacing as a fallback;
      // the cascade currently doesn't store voxel spacing alongside the
      // plane, so this is a 1:1 approximation that is acceptable for
      // visualisation. Pass C5/D will swap in real voxel→mm geometry.
      if (ax >= ay && ax >= az && orientation === 'sagittal') {
        return Math.max(0, Math.min(volumeDims[0] - 1, Math.round(offsetMm)));
      }
      if (ay >= ax && ay >= az && orientation === 'coronal') {
        return Math.max(0, Math.min(volumeDims[1] - 1, Math.round(offsetMm)));
      }
      if (az >= ax && az >= ay && orientation === 'axial') {
        return Math.max(0, Math.min(volumeDims[2] - 1, Math.round(offsetMm)));
      }
    }
  }

  // Mode 2: legacy plane_pose heuristic — `axis: "axial", z_index: N`.
  const pose = flr.plane_pose;
  if (pose && pose.axis && typeof pose.z_index === 'number') {
    if (pose.axis === 'axial' && orientation === 'axial') {
      return Math.max(0, Math.min(volumeDims[2] - 1, pose.z_index));
    }
    // Other orientations share the cutting depth — show at the same z if
    // they have it as a coordinate; otherwise centre the line and let
    // colour intensity explain it's a cross-section.
    if (pose.axis === 'axial' && orientation !== 'axial') {
      return Math.floor((volumeDims[2] - 1) / 2); // crude midline
    }
  }

  return null;
}

export function FlrPlaneOverlay({
  flr,
  orientation,
  sliceIndex,
  totalSlices,
  volumeDims,
  visible,
  'data-testid': testId = 'flr-plane-overlay',
}: FlrPlaneOverlayProps): React.ReactElement | null {
  // Voxel index of the plane in this orientation, if the plane has one.
  const planeVoxel = useMemo(
    () => (flr ? planeVoxelSliceFor(flr, orientation, volumeDims) : null),
    [flr, orientation, volumeDims],
  );

  // Map current viewport slice to voxel space, mirroring the parenchyma
  // overlay's proportional rule. This keeps MVP slices aligned even when
  // the viewport slice count differs from the mask volume's depth.
  const currentVoxelSlice = useMemo(() => {
    const axisLen =
      orientation === 'axial' ? volumeDims[2] :
      orientation === 'sagittal' ? volumeDims[0] :
      volumeDims[1];
    if (totalSlices <= 1 || axisLen <= 0) return sliceIndex;
    return Math.floor((sliceIndex / Math.max(totalSlices - 1, 1)) * (axisLen - 1));
  }, [sliceIndex, totalSlices, volumeDims, orientation]);

  if (!visible || !flr || planeVoxel === null) return null;

  // Render the plane as a horizontal full-width band when the current
  // slice is on the cutting plane. Adjacent slices show a dimmed indicator
  // so the surgeon retains context when scrolling.
  const distance = Math.abs(currentVoxelSlice - planeVoxel);
  const onPlane = distance === 0;
  const nearPlane = distance > 0 && distance <= 2;
  if (!onPlane && !nearPlane) return null;

  // For axial: the cutting "line" is a horizontal band across the viewport
  // at the planeVoxel z-position — but on a 2D axial slice there is no
  // such z-position; the entire slice IS the plane. So we render a
  // perimeter highlight instead of a single line.
  // For sagittal/coronal: the plane crosses the slice as a horizontal
  // line at the corresponding y-position.

  const opacity = onPlane ? 0.55 : 0.22;

  if (orientation === 'axial') {
    return (
      <Box
        data-testid={testId}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 3,
          // A subtle purple inner glow indicates "this slice is the
          // cutting plane" without obscuring anatomy.
          boxShadow: `inset 0 0 0 3px rgba(139, 92, 246, ${opacity})`,
          background: onPlane ? 'rgba(139, 92, 246, 0.08)' : 'transparent',
        }}
      />
    );
  }

  // sagittal / coronal — horizontal line at the cutting depth (z).
  // We map the planeVoxel (z in volume) to a normalised Y on screen:
  //   sagittal/coronal y-axis = depth; convention here is screen-down = +z
  //   so we flip vertically (1 − fraction) for natural radiological orientation.
  const fractionalZ = volumeDims[2] > 1 ? planeVoxel / (volumeDims[2] - 1) : 0.5;
  const screenY = 1 - fractionalZ;

  return (
    <Box
      data-testid={testId}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 3,
      }}
    >
      <Box
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: `${screenY * 100}%`,
          height: 3,
          transform: 'translateY(-1px)',
          background: `rgba(139, 92, 246, ${opacity})`,
          boxShadow: `0 0 6px rgba(139, 92, 246, ${opacity})`,
        }}
      />
    </Box>
  );
}

export default FlrPlaneOverlay;
