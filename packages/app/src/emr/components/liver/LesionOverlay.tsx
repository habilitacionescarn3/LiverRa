// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LesionOverlay — Pass C2
 *
 * Plain-English: when the cascade detects lesions, each one comes with a
 * 3D bounding box (an axis-aligned cube around it in voxel space). This
 * component draws those boxes as yellow rectangles on top of the CT
 * viewport, but only on the slices the box actually intersects. Hovering
 * a box surfaces the classification + diameter as a tooltip.
 *
 * Why a 2D canvas overlay (not Cornerstone annotations):
 *   - Cornerstone's RectangleROI tool expects world-coordinate input and
 *     a viewport reference; for axial / sagittal / coronal we'd need to
 *     project the 3D box into each plane separately. A canvas overlay is
 *     simpler, self-contained, and consistent with the parenchyma-mask
 *     overlay strategy already used in Pass B.
 *   - Lesion bbox metadata sits in voxel coordinates, the same coord
 *     system as the parenchyma NIfTI mask, which means we can reuse the
 *     same dims-mapping logic.
 *
 * Empty-state behaviour: returns null when no lesions exist (healthy
 * patient) or when visibility is off — costs nothing.
 */

import { useState, useMemo, useCallback } from 'react';
import { Tooltip, Box } from '@mantine/core';

/** Axis bbox shape — accepts either {x,y,z,dx,dy,dz} or min/max. */
export interface LesionBbox {
  x?: number;
  y?: number;
  z?: number;
  dx?: number;
  dy?: number;
  dz?: number;
  x_min?: number;
  y_min?: number;
  z_min?: number;
  x_max?: number;
  y_max?: number;
  z_max?: number;
}

export interface LesionDatum {
  id: string;
  bbox3d?: LesionBbox | null;
  couinaud_location?: number | null;
  longest_diameter_mm?: string | number | null;
  /** JSON-encoded `{label, confidence}` per backend. */
  classification?: string | null;
}

export type ViewOrientation = 'axial' | 'sagittal' | 'coronal';

export interface LesionOverlayProps {
  lesions: LesionDatum[];
  /** Current slice index in the active orientation. */
  sliceIndex: number;
  /** Total slices in the active orientation (for proportional mapping). */
  totalSlices: number;
  /** Reference voxel dims (matches the parenchyma mask grid). */
  volumeDims: [number, number, number];
  orientation: ViewOrientation;
  visible: boolean;
  /** Whether this viewport is mirrored (for left/right). Defaults to false. */
  'data-testid'?: string;
}

interface NormalisedBox {
  id: string;
  /** Voxel-space min corner. */
  min: [number, number, number];
  /** Voxel-space max corner (exclusive). */
  max: [number, number, number];
  label: string;
  meta: string;
}

function normaliseBox(les: LesionDatum): NormalisedBox | null {
  const b = les.bbox3d;
  if (!b) return null;
  let min: [number, number, number];
  let max: [number, number, number];
  if (
    b.x_min !== undefined &&
    b.y_min !== undefined &&
    b.z_min !== undefined &&
    b.x_max !== undefined &&
    b.y_max !== undefined &&
    b.z_max !== undefined
  ) {
    min = [b.x_min, b.y_min, b.z_min];
    max = [b.x_max, b.y_max, b.z_max];
  } else if (
    b.x !== undefined &&
    b.y !== undefined &&
    b.z !== undefined &&
    b.dx !== undefined &&
    b.dy !== undefined &&
    b.dz !== undefined
  ) {
    min = [b.x, b.y, b.z];
    max = [b.x + b.dx, b.y + b.dy, b.z + b.dz];
  } else {
    return null;
  }

  let label = 'Lesion';
  let confidence: number | undefined;
  try {
    const parsed = JSON.parse(les.classification ?? '{}') as { label?: string; confidence?: number };
    if (parsed.label) label = parsed.label;
    if (typeof parsed.confidence === 'number') confidence = parsed.confidence;
  } catch {
    /* ignore */
  }

  const seg = les.couinaud_location !== null && les.couinaud_location !== undefined
    ? `Segment ${les.couinaud_location}`
    : 'Segment —';
  const diam = les.longest_diameter_mm !== null && les.longest_diameter_mm !== undefined
    ? `${les.longest_diameter_mm} mm`
    : '— mm';
  const conf = confidence !== undefined ? ` · ${Math.round(confidence * 100)}%` : '';

  return {
    id: les.id,
    min,
    max,
    label: label.toUpperCase(),
    meta: `${seg} · ${diam}${conf}`,
  };
}

/**
 * Project a 3D voxel bbox into a 2D rectangle on the given orientation,
 * IF the current slice intersects it. Returns null otherwise.
 *
 * Coordinate convention (matches NIfTI dims [w, h, d]):
 *   - axial:    plane is z = const; rect uses x (0..w), y (0..h)
 *   - sagittal: plane is x = const; rect uses y (0..h), z (0..d)
 *   - coronal:  plane is y = const; rect uses x (0..w), z (0..d)
 */
function intersectAndProject(
  box: NormalisedBox,
  orientation: ViewOrientation,
  sliceVoxelIdx: number,
  volumeDims: [number, number, number],
): { x: number; y: number; w: number; h: number; vx: number; vy: number } | null {
  const [w, h, d] = volumeDims;
  if (orientation === 'axial') {
    if (sliceVoxelIdx < box.min[2] || sliceVoxelIdx >= box.max[2]) return null;
    return {
      x: box.min[0] / Math.max(w, 1),
      y: box.min[1] / Math.max(h, 1),
      w: (box.max[0] - box.min[0]) / Math.max(w, 1),
      h: (box.max[1] - box.min[1]) / Math.max(h, 1),
      vx: w,
      vy: h,
    };
  }
  if (orientation === 'sagittal') {
    if (sliceVoxelIdx < box.min[0] || sliceVoxelIdx >= box.max[0]) return null;
    return {
      x: box.min[1] / Math.max(h, 1),
      y: 1 - box.max[2] / Math.max(d, 1), // z-up flip for screen
      w: (box.max[1] - box.min[1]) / Math.max(h, 1),
      h: (box.max[2] - box.min[2]) / Math.max(d, 1),
      vx: h,
      vy: d,
    };
  }
  // coronal
  if (sliceVoxelIdx < box.min[1] || sliceVoxelIdx >= box.max[1]) return null;
  return {
    x: box.min[0] / Math.max(w, 1),
    y: 1 - box.max[2] / Math.max(d, 1),
    w: (box.max[0] - box.min[0]) / Math.max(w, 1),
    h: (box.max[2] - box.min[2]) / Math.max(d, 1),
    vx: w,
    vy: d,
  };
}

export function LesionOverlay({
  lesions,
  sliceIndex,
  totalSlices,
  volumeDims,
  orientation,
  visible,
  'data-testid': testId = 'lesion-overlay',
}: LesionOverlayProps): React.ReactElement | null {
  const [hovered, setHovered] = useState<string | null>(null);

  // Map slice index (in DICOM/render space) onto voxel-space slice axis
  // proportionally — same trick used by the parenchyma overlay.
  const voxelSlice = useMemo(() => {
    const axisLen =
      orientation === 'axial' ? volumeDims[2] :
      orientation === 'sagittal' ? volumeDims[0] :
      volumeDims[1];
    if (totalSlices <= 1 || axisLen <= 0) return sliceIndex;
    return Math.floor((sliceIndex / Math.max(totalSlices - 1, 1)) * (axisLen - 1));
  }, [sliceIndex, totalSlices, volumeDims, orientation]);

  const boxes = useMemo(
    () =>
      lesions
        .map(normaliseBox)
        .filter((b): b is NormalisedBox => b !== null),
    [lesions],
  );

  const onLeave = useCallback(() => setHovered(null), []);

  if (!visible || boxes.length === 0) return null;

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
      {boxes.map((box) => {
        const proj = intersectAndProject(box, orientation, voxelSlice, volumeDims);
        if (!proj) return null;
        const left = `${proj.x * 100}%`;
        const top = `${proj.y * 100}%`;
        const width = `${proj.w * 100}%`;
        const height = `${proj.h * 100}%`;
        return (
          <Tooltip
            key={`${box.id}-${orientation}`}
            label={`${box.label} · ${box.meta}`}
            withArrow
            position="top"
            opened={hovered === box.id ? true : undefined}
          >
            <Box
              data-testid={`lesion-box-${box.id}-${orientation}`}
              onMouseEnter={() => setHovered(box.id)}
              onMouseLeave={onLeave}
              style={{
                position: 'absolute',
                left,
                top,
                width,
                height,
                border: '2px solid #facc15',
                background: 'rgba(250, 204, 21, 0.08)',
                boxSizing: 'border-box',
                pointerEvents: 'auto',
                cursor: 'help',
                transition: 'background 120ms ease',
              }}
            />
          </Tooltip>
        );
      })}
    </Box>
  );
}

export default LesionOverlay;
