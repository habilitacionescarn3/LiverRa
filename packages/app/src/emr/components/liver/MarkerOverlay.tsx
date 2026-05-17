// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * MarkerOverlay — Phase H9.
 *
 * Plain-English: the reviewer drops "sticky note" markers at specific
 * voxels (Phase G). The MarkersList in the left rail shows them as a
 * list, but until now nothing rendered them in the viewer itself. This
 * component draws a small pin (a coloured ring with the label, if any)
 * on top of each Cornerstone3D viewport — but only on slices where the
 * marker's slice-axis voxel actually falls within ±1 voxel of the
 * current slice (so it doesn't ghost across the whole stack).
 *
 * Mirrors `LesionOverlay`'s mounting pattern: one instance per viewport
 * (stack + 3 MPR), each told its orientation + current slice index +
 * total slices so it can project voxel space → screen %.
 *
 * Empty-state behaviour: returns null when `markers` is empty or
 * `visible === false` — zero cost when the layer is off.
 */

import { useMemo } from 'react';
import { Box, Tooltip, Text } from '@mantine/core';

import type { ReviewerMarker } from '../../hooks/useMarkers';

export type ViewOrientation = 'axial' | 'sagittal' | 'coronal';

export interface MarkerOverlayProps {
  markers: ReviewerMarker[];
  sliceIndex: number;
  totalSlices: number;
  /** Reference voxel dims (matches the parenchyma mask grid). */
  volumeDims: [number, number, number];
  orientation: ViewOrientation;
  visible: boolean;
  /**
   * Slack on either side of the current slice (in voxels) for "is this
   * marker on this slice?" — a marker that is one voxel above/below the
   * displayed slice still renders, so the user doesn't see it strobe on
   * and off while they scroll. Defaults to 1.
   */
  sliceTolerance?: number;
  'data-testid'?: string;
}

/**
 * Project a marker voxel into a 2D `(left%, top%)` if its slice-axis
 * voxel is within `sliceTolerance` of the current slice; otherwise null.
 *
 * Convention (matches NIfTI dims [w, h, d] and `LesionOverlay`):
 *   - axial:    plane is z = const; 2D = (x/w, y/h)
 *   - sagittal: plane is x = const; 2D = (y/h, 1 - z/d) — z flipped for screen
 *   - coronal:  plane is y = const; 2D = (x/w, 1 - z/d)
 */
function projectMarker(
  voxel: [number, number, number],
  orientation: ViewOrientation,
  sliceVoxelIdx: number,
  sliceTolerance: number,
  volumeDims: [number, number, number],
): { left: number; top: number } | null {
  const [w, h, d] = volumeDims;
  const [vx, vy, vz] = voxel;
  const onSlice = (axisVal: number): boolean =>
    Math.abs(axisVal - sliceVoxelIdx) <= sliceTolerance;
  if (orientation === 'axial') {
    if (!onSlice(vz)) return null;
    return { left: vx / Math.max(w, 1), top: vy / Math.max(h, 1) };
  }
  if (orientation === 'sagittal') {
    if (!onSlice(vx)) return null;
    return {
      left: vy / Math.max(h, 1),
      top: 1 - vz / Math.max(d, 1),
    };
  }
  // coronal
  if (!onSlice(vy)) return null;
  return {
    left: vx / Math.max(w, 1),
    top: 1 - vz / Math.max(d, 1),
  };
}

export function MarkerOverlay({
  markers,
  sliceIndex,
  totalSlices,
  volumeDims,
  orientation,
  visible,
  sliceTolerance = 1,
  'data-testid': testId = 'marker-overlay',
}: MarkerOverlayProps): React.ReactElement | null {
  // Map screen slice index onto voxel-space slice axis proportionally —
  // same trick the lesion + parenchyma overlays use, so a viewport with
  // 200 slices and a 100-deep volume still surfaces markers at the
  // right z.
  const voxelSlice = useMemo(() => {
    const axisLen =
      orientation === 'axial' ? volumeDims[2] :
      orientation === 'sagittal' ? volumeDims[0] :
      volumeDims[1];
    if (totalSlices <= 1 || axisLen <= 0) return sliceIndex;
    return Math.floor((sliceIndex / Math.max(totalSlices - 1, 1)) * (axisLen - 1));
  }, [sliceIndex, totalSlices, volumeDims, orientation]);

  if (!visible || markers.length === 0) return null;

  return (
    <Box
      data-testid={testId}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 3,
      }}
    >
      {markers.map((m) => {
        const proj = projectMarker(
          m.voxel,
          orientation,
          voxelSlice,
          sliceTolerance,
          volumeDims,
        );
        if (!proj) return null;
        const tooltipLabel = m.label || m.note || m.couinaud_segment || 'Marker';
        return (
          <Tooltip
            key={`${m.id}-${orientation}`}
            label={tooltipLabel}
            withArrow
            position="top"
          >
            <Box
              data-testid={`marker-pin-${m.id}-${orientation}`}
              style={{
                position: 'absolute',
                left: `${proj.left * 100}%`,
                top: `${proj.top * 100}%`,
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'auto',
                cursor: 'help',
              }}
            >
              <Box
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: 'rgba(236, 72, 153, 0.92)',
                  border: '2px solid rgba(255,255,255,0.95)',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.4)',
                }}
              />
              {m.label ? (
                <Text
                  fz={10}
                  fw={600}
                  style={{
                    position: 'absolute',
                    top: 16,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    color: 'rgba(255,255,255,0.95)',
                    background: 'rgba(15, 23, 42, 0.72)',
                    padding: '1px 6px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                    textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                  }}
                >
                  {m.label}
                </Text>
              ) : null}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

export default MarkerOverlay;
