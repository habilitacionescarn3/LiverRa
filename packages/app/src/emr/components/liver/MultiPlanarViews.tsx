// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * MultiPlanarViews — synchronized axial / coronal / sagittal 2D slices (T204).
 *
 * Plain-English analogy:
 *   A CT scan is a 3D loaf of bread. Radiologists traditionally
 *   look at it sliced in three directions:
 *
 *     - Axial     → horizontal slices (as if you're standing over the patient)
 *     - Coronal   → vertical front-to-back slices (looking at the patient face-on)
 *     - Sagittal  → vertical side-to-side slices (looking at the patient from the side)
 *
 *   This component shows all three at once AND keeps them in lockstep:
 *   if the surgeon clicks a blood vessel on the axial view, the coronal
 *   and sagittal views both jump to that exact anatomical point too.
 *   One shared "crosshair" cursor in 3D space, three synced 2D windows.
 *
 * Spec refs:
 *   - §FR-020  synchronized axial/coronal/sagittal views; click-to-recenter
 *   - §NFR-002 accessibility (labelled regions, keyboard scroll)
 *   - Mobile-first: below 768 px the three views stack vertically.
 *
 * Cornerstone3D wiring happens in LiverViewer3D (T175). This component
 * owns the 3 labelled panels, the slice slider, the crosshair-sync
 * dispatch, and the responsive layout. Each panel exposes a stable
 * `data-view` attribute that the Cornerstone3D viewport manager binds.
 */

import { memo, useCallback, useState, useEffect } from 'react';
import { Box, Text, Slider } from '@mantine/core';

export type MprPlane = 'axial' | 'coronal' | 'sagittal';

/** 3D crosshair position in voxel space (synced across the 3 views). */
export interface MprCrosshair {
  x: number;
  y: number;
  z: number;
}

export interface MultiPlanarViewsProps {
  /** Initial crosshair — defaults to the volume centre. */
  initialCrosshair?: MprCrosshair;
  /** Volume shape [x,y,z] used to drive slice slider maxima. */
  volumeShape?: [number, number, number];
  /** Fired when the user clicks on any view — the event propagates to all. */
  onCrosshairChange?: (crosshair: MprCrosshair, source: MprPlane) => void;
  /** Breakpoint at which the 3-up layout collapses to a vertical stack. */
  stackBelowPx?: number;
  'data-testid'?: string;
}

const PLANES: Array<{ key: MprPlane; title: string }> = [
  { key: 'axial', title: 'Axial' },
  { key: 'coronal', title: 'Coronal' },
  { key: 'sagittal', title: 'Sagittal' },
];

/** Which axis each plane scrolls along — used to drive the slice slider. */
const PLANE_SCROLL_AXIS: Record<MprPlane, 'x' | 'y' | 'z'> = {
  axial: 'z',    // scrolling axial changes z (superior/inferior)
  coronal: 'y',  // scrolling coronal changes y (anterior/posterior)
  sagittal: 'x', // scrolling sagittal changes x (left/right)
};

/** Simple viewport-width hook so we can switch between 3-up and stacked. */
function useIsNarrow(breakpointPx: number): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < breakpointPx;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setNarrow(window.innerWidth < breakpointPx);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpointPx]);
  return narrow;
}

export const MultiPlanarViews = memo(function MultiPlanarViews({
  initialCrosshair,
  volumeShape = [128, 128, 128],
  onCrosshairChange,
  stackBelowPx = 768,
  'data-testid': dataTestId = 'mpr-views',
}: MultiPlanarViewsProps) {
  const narrow = useIsNarrow(stackBelowPx);

  const [crosshair, setCrosshair] = useState<MprCrosshair>(
    initialCrosshair ?? {
      x: Math.floor(volumeShape[0] / 2),
      y: Math.floor(volumeShape[1] / 2),
      z: Math.floor(volumeShape[2] / 2),
    },
  );

  const updateCrosshair = useCallback(
    (next: MprCrosshair, source: MprPlane) => {
      setCrosshair(next);
      onCrosshairChange?.(next, source);
    },
    [onCrosshairChange],
  );

  const handleViewClick = useCallback(
    (plane: MprPlane, event: React.MouseEvent<HTMLDivElement>) => {
      // Map the 2D click back into 3D voxel coordinates. Cornerstone3D
      // does this precisely once it's wired in; here we do a simple
      // fractional remap so the dev preview + e2e tests behave sanely.
      const rect = event.currentTarget.getBoundingClientRect();
      const fx = (event.clientX - rect.left) / rect.width;
      const fy = (event.clientY - rect.top) / rect.height;
      const next = { ...crosshair };
      if (plane === 'axial') {
        next.x = Math.round(fx * volumeShape[0]);
        next.y = Math.round(fy * volumeShape[1]);
      } else if (plane === 'coronal') {
        next.x = Math.round(fx * volumeShape[0]);
        next.z = Math.round((1 - fy) * volumeShape[2]);
      } else if (plane === 'sagittal') {
        next.y = Math.round(fx * volumeShape[1]);
        next.z = Math.round((1 - fy) * volumeShape[2]);
      }
      updateCrosshair(next, plane);
    },
    [crosshair, updateCrosshair, volumeShape],
  );

  const handleSliceChange = useCallback(
    (plane: MprPlane, value: number) => {
      const axis = PLANE_SCROLL_AXIS[plane];
      updateCrosshair({ ...crosshair, [axis]: value }, plane);
    },
    [crosshair, updateCrosshair],
  );

  return (
    <Box
      data-testid={dataTestId}
      role="region"
      aria-label="Multi-planar reformatted views"
      style={{
        display: 'grid',
        gap: 'var(--emr-space-md, 12px)',
        gridTemplateColumns: narrow ? '1fr' : 'repeat(3, minmax(0, 1fr))',
        width: '100%',
      }}
    >
      {PLANES.map(({ key, title }) => {
        const axis = PLANE_SCROLL_AXIS[key];
        const axisIdx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
        const sliceMax = Math.max(1, volumeShape[axisIdx] - 1);
        const sliceValue = crosshair[axis];
        return (
          <Box
            key={key}
            data-testid={`mpr-view-${key}`}
            data-view={key}
            role="group"
            aria-label={`${title} view`}
            style={{
              background: 'var(--emr-bg-card)',
              border: '1px solid var(--emr-border-color)',
              borderRadius: 'var(--emr-radius-md, 8px)',
              padding: 'var(--emr-space-sm, 8px)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              minWidth: 0,
            }}
          >
            <Text
              size="sm"
              fw={600}
              style={{
                color: 'var(--emr-text-primary)',
                fontSize: 'var(--emr-font-sm)',
              }}
            >
              {title}
            </Text>

            <Box
              data-testid={`mpr-canvas-${key}`}
              onClick={(e) => handleViewClick(key, e)}
              role="button"
              tabIndex={0}
              aria-label={`${title} slice — click to recenter crosshair`}
              style={{
                position: 'relative',
                width: '100%',
                aspectRatio: '1 / 1',
                background: 'var(--emr-mpr-canvas-bg)',
                borderRadius: 'var(--emr-radius-sm, 6px)',
                overflow: 'hidden',
                cursor: 'crosshair',
                minHeight: 160,
              }}
            >
              {/* Crosshair overlay — purely visual; Cornerstone3D replaces the canvas. */}
              <Box
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: `${(sliceValue / sliceMax) * 100}%`,
                  height: 1,
                  background: 'var(--emr-primary)',
                  opacity: 0.6,
                }}
              />
            </Box>

            <Slider
              data-testid={`mpr-slider-${key}`}
              aria-label={`${title} slice index`}
              min={0}
              max={sliceMax}
              value={sliceValue}
              onChange={(value) => handleSliceChange(key, value)}
              size="sm"
              thumbSize={14}
            />
            <Text
              size="xs"
              style={{
                color: 'var(--emr-text-secondary)',
                fontSize: 'var(--emr-font-xs, 11px)',
              }}
            >
              Slice {sliceValue + 1} / {sliceMax + 1}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
});
