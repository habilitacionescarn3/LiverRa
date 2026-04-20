// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * VesselLayer — adapter for ViewerLayers.tsx lazy-load contract.
 *
 * Plain-English analogy: same story as SegmentLayer — ViewerLayers
 * expects a `./VesselLayer` default export matching its
 * `LayerComponentProps` contract, so this file bridges to the richer
 * `VesselsLayer` component that the US2 couinaud agent built.
 *
 * Reads the portal + hepatic vein mask URIs from ViewerStateContext
 * (T181) once that context exposes them; today renders the two
 * trunk traces with defaults so the 3D viewer composes cleanly.
 */

import { memo } from 'react';

import { VesselsLayer } from './VesselsLayer';

export interface VesselLayerProps {
  analysisId: string;
}

const VesselLayer = memo(function VesselLayer({
  analysisId: _analysisId,
}: VesselLayerProps) {
  return <VesselsLayer portalVisible hepaticVisible />;
});

export default VesselLayer;
