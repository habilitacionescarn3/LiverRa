// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SegmentLayer — adapter for ViewerLayers.tsx lazy-load contract.
 *
 * Plain-English analogy:
 *   ViewerLayers.tsx (T223) was built expecting files named
 *   `./SegmentLayer` / `./VesselLayer` / `./LesionLayer` as its
 *   lazy-import targets — one default export each, all accepting
 *   `{ analysisId: string }`. The US2 couinaud agent built the richer
 *   `SegmentsLayer` (plural; props-heavy) as the actual visual
 *   component. This thin file is the adapter that lets ViewerLayers
 *   compose the couinaud overlay via its declared contract.
 *
 *   Think of it as a power-plug converter: the viewer expects one
 *   kind of prop-shape, the feature component offers a richer one,
 *   and this file sits between them to translate.
 *
 * Behaviour:
 *   - Reads the active Couinaud selection + per-segment mask URIs
 *     from `ViewerStateContext` (when the context lands — T181).
 *   - Forwards `onSegmentSelect` into the context's `selectSegment`
 *     action if available; otherwise silently no-ops.
 */

import { memo, useCallback } from 'react';

import { SegmentsLayer } from './SegmentsLayer';
import type { CouinaudLabel } from './couinaud-constants';

export interface SegmentLayerProps {
  analysisId: string;
}

/**
 * Default export matches the {default: ComponentType<LayerComponentProps>}
 * contract that ViewerLayers.tsx's lazy loader expects.
 */
const SegmentLayer = memo(function SegmentLayer({
  analysisId: _analysisId,
}: SegmentLayerProps) {
  // Context bridge placeholder — the real implementation reads
  // ViewerStateContext (T181) for activeSegment + maskUris once that
  // context exports those fields. For now we render the overlay with
  // no active segment highlighted; the SegmentsLayer click handler
  // is a no-op until wired through the context.
  const handleSelect = useCallback((_segment: CouinaudLabel) => {
    /* TODO(T181): dispatch to ViewerStateContext.selectSegment */
  }, []);

  return (
    <SegmentsLayer
      visible
      activeSegment={null}
      onSegmentSelect={handleSelect}
    />
  );
});

export default SegmentLayer;
