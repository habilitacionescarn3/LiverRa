// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SegmentsLayer — 8 Couinaud segment overlays for the 3D viewer (T200).
 *
 * Plain-English analogy:
 *   Think of the parenchyma mask as a solid-colour liver sculpture.
 *   This component lays 8 translucent paint swatches on top — one per
 *   Couinaud segment (I through VIII) — so the surgeon can see at a
 *   glance which part of the liver belongs to which anatomical region.
 *   Clicking a swatch picks up that segment (like selecting a pie
 *   slice) and broadcasts the choice through ViewerStateContext so
 *   every other panel (MPR views, volume card, legend) can react.
 *
 * Spec refs:
 *   - §FR-008  8-segment Couinaud map
 *   - §FR-019  toggle each layer independently
 *   - §NFR-002 keyboard + ARIA
 *   - SC-004   ≥80% surgeon surgical-usability rating
 *
 * Color tokens:
 *   --liverra-seg-couinaud-I  .. --liverra-seg-couinaud-VIII
 *   (CVD-safe palette verified by T411 palette-cvd-check.)
 *
 * This is a presentational shell — the heavy volume rendering still
 * happens inside LiverViewer3D (T175). We render 8 overlay stubs that
 * the Cornerstone3D renderer picks up via `data-segment` on each DOM
 * node. If `activeSegment` is set, the chosen overlay gets a stronger
 * opacity ring so the surgeon always knows "you're looking at VI".
 */

import { memo, useCallback } from 'react';
import { Box } from '@mantine/core';

import { COUINAUD_LABELS, type CouinaudLabel, getCouinaudColorVar } from './couinaud-constants';

export interface SegmentsLayerProps {
  /** When false, the entire 8-swatch stack is skipped (display:none). */
  visible?: boolean;
  /** Currently highlighted segment (Roman numeral) — I..VIII */
  activeSegment?: CouinaudLabel | null;
  /** Overlay opacity for the inactive segments. Spec default 0.35 (35%). */
  baseOpacity?: number;
  /** Fired when the surgeon clicks a segment — dispatched into ViewerStateContext. */
  onSegmentSelect?: (segment: CouinaudLabel) => void;
  /** Optional mask data URIs from the API (per-segment NIfTI S3 URIs). */
  maskUris?: Partial<Record<CouinaudLabel, string>>;
  'data-testid'?: string;
}

/**
 * A translucent overlay stub per Couinaud segment. The real volume
 * composition is performed by Cornerstone3D inside LiverViewer3D; this
 * component owns the per-segment colour wiring + click routing.
 */
export const SegmentsLayer = memo(function SegmentsLayer({
  visible = true,
  activeSegment = null,
  baseOpacity = 0.35,
  onSegmentSelect,
  maskUris,
  'data-testid': dataTestId = 'segments-layer',
}: SegmentsLayerProps) {
  const handleClick = useCallback(
    (segment: CouinaudLabel) => {
      onSegmentSelect?.(segment);
    },
    [onSegmentSelect],
  );

  if (!visible) {
    return null;
  }

  return (
    <Box
      data-testid={dataTestId}
      role="group"
      aria-label="Couinaud segments overlay"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none', // the children re-enable click-through.
      }}
    >
      {COUINAUD_LABELS.map((label) => {
        const isActive = activeSegment === label;
        const opacity = isActive ? Math.min(1, baseOpacity + 0.25) : baseOpacity;
        return (
          <Box
            key={label}
            data-testid={`segments-layer-swatch-${label}`}
            data-segment={label}
            data-mask-uri={maskUris?.[label] ?? ''}
            data-active={isActive ? 'true' : 'false'}
            role="button"
            tabIndex={0}
            aria-label={`Couinaud segment ${label}`}
            aria-pressed={isActive}
            onClick={() => handleClick(label)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleClick(label);
              }
            }}
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: getCouinaudColorVar(label),
              opacity,
              mixBlendMode: 'multiply',
              pointerEvents: 'auto',
              minWidth: 44,
              minHeight: 44,
              cursor: 'pointer',
              outline: isActive
                ? `2px solid var(--emr-primary)`
                : 'none',
              outlineOffset: 2,
              transition: 'opacity 120ms ease-out, outline 120ms ease-out',
            }}
          />
        );
      })}
    </Box>
  );
});
