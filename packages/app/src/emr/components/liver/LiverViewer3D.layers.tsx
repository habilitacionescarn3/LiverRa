// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * LiverViewer3D.layers — composable overlay stack for LiverViewer3D (T207).
 *
 * Plain-English analogy:
 *   The 3D viewer (LiverViewer3D, T175) is the "stage". This module is
 *   the "scenery crew" — it slots translucent backdrops on top of the
 *   parenchyma based on what the user has toggled in ViewerStateContext
 *   (T181). Keeping scenery in its own file means the US2 agent can
 *   ship without touching the viewer file that the US1 agent owns.
 *
 * How it's consumed:
 *   LiverViewer3D.tsx (US1-owned) imports this composer instead of
 *   hand-rolling the overlay fan-out. It passes its active-layers
 *   record + current selection, and receives a ready-to-render React
 *   subtree of SegmentsLayer + VesselsLayer + (future) LesionLayer.
 *
 * Spec refs:
 *   - §FR-019 toggle each layer independently
 *   - §US2    activate segments + vessels in the viewer
 */

import { type ReactNode, memo } from 'react';

import { SegmentsLayer } from './SegmentsLayer';
import { VesselsLayer } from './VesselsLayer';
import { type CouinaudLabel } from './couinaud-constants';

/** Mirrors ViewerStateContext.activeLayers (T181) — redeclared here so
 *  this module does NOT import the context (avoiding circular imports
 *  with LiverViewer3D). LiverViewer3D is responsible for bridging the
 *  context state into this shape. */
export interface ActiveLayers {
  parenchyma: boolean;
  segments: boolean;
  vessels: boolean;
  lesions: boolean;
}

export interface LiverViewer3DLayersProps {
  activeLayers: ActiveLayers;
  activeSegment?: CouinaudLabel | null;
  onSegmentSelect?: (segment: CouinaudLabel) => void;
  /** Per-Couinaud segment NIfTI URIs (optional — passed to Cornerstone3D). */
  segmentMaskUris?: Partial<Record<CouinaudLabel, string>>;
  portalMaskUri?: string;
  hepaticMaskUri?: string;
  /** US3-owned LesionLayer — will be wired when its file lands. For now
   *  we accept an opaque node so US3 can inject without this file
   *  importing a yet-unwritten component. */
  lesionLayerSlot?: ReactNode;
}

/**
 * Compose overlays over the parenchyma. Returns null when no overlay is
 * active — the base parenchyma layer still renders inside LiverViewer3D.
 */
export const LiverViewer3DLayers = memo(function LiverViewer3DLayers({
  activeLayers,
  activeSegment = null,
  onSegmentSelect,
  segmentMaskUris,
  portalMaskUri,
  hepaticMaskUri,
  lesionLayerSlot,
}: LiverViewer3DLayersProps) {
  const showSegments = activeLayers.segments;
  const showVessels = activeLayers.vessels;
  const showLesions = activeLayers.lesions;

  if (!showSegments && !showVessels && !showLesions) {
    return null;
  }

  return (
    <>
      {showSegments ? (
        <SegmentsLayer
          visible
          activeSegment={activeSegment}
          onSegmentSelect={onSegmentSelect}
          maskUris={segmentMaskUris}
        />
      ) : null}

      {showVessels ? (
        <VesselsLayer
          portalVisible
          hepaticVisible
          portalMaskUri={portalMaskUri}
          hepaticMaskUri={hepaticMaskUri}
        />
      ) : null}

      {showLesions ? lesionLayerSlot ?? null : null}
    </>
  );
});
