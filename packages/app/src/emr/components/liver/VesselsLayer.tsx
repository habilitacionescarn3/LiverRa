// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * VesselsLayer — portal + hepatic vein trunks overlay (T201).
 *
 * Plain-English analogy:
 *   A liver isn't a blob — it's more like a sponge threaded with two
 *   river systems: the portal vein (blood coming IN from the gut) and
 *   the hepatic vein (blood going OUT to the heart). This component
 *   draws those rivers as line traces on top of the 3D liver, in blue
 *   and red respectively, so the surgeon can plan a cut that avoids
 *   severing a major tributary.
 *
 * Spec refs:
 *   - §FR-009  portal + hepatic vein trunks overlayable on parenchyma
 *   - §FR-019  toggle each layer independently
 *
 * Color tokens:
 *   --liverra-vessel-portal   (blue)
 *   --liverra-vessel-hepatic  (red)
 *
 * Rendering mode is "line-trace" — vessels are tubular, not volumetric.
 * We expose two separate toggles so the surgeon can compare sides.
 * The Cornerstone3D layer reads the `data-vessel` attribute to choose
 * the centreline-trace pipeline over the voxel-mask pipeline.
 */

import { memo } from 'react';
import { Box } from '@mantine/core';

import { VESSEL_COLOR_VARS } from './couinaud-constants';

export interface VesselsLayerProps {
  /** Whether the portal vein trace is drawn. */
  portalVisible?: boolean;
  /** Whether the hepatic vein trace is drawn. */
  hepaticVisible?: boolean;
  /** NIfTI URIs (for Cornerstone3D to load). */
  portalMaskUri?: string;
  hepaticMaskUri?: string;
  /** Line thickness px — default 3; can be bumped on high-DPI. */
  lineThickness?: number;
  'data-testid'?: string;
}

export const VesselsLayer = memo(function VesselsLayer({
  portalVisible = true,
  hepaticVisible = true,
  portalMaskUri,
  hepaticMaskUri,
  lineThickness = 3,
  'data-testid': dataTestId = 'vessels-layer',
}: VesselsLayerProps) {
  if (!portalVisible && !hepaticVisible) {
    return null;
  }

  return (
    <Box
      data-testid={dataTestId}
      role="group"
      aria-label="Vein trunks overlay"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
      }}
    >
      {portalVisible ? (
        <Box
          data-testid="vessels-layer-portal"
          data-vessel="portal"
          data-mask-uri={portalMaskUri ?? ''}
          aria-label="Portal vein trunk"
          style={{
            position: 'absolute',
            inset: 0,
            border: `${lineThickness}px dashed ${VESSEL_COLOR_VARS.portal}`,
            borderRadius: 'var(--emr-radius-lg, 12px)',
            opacity: 0.85,
            mixBlendMode: 'normal',
          }}
        />
      ) : null}

      {hepaticVisible ? (
        <Box
          data-testid="vessels-layer-hepatic"
          data-vessel="hepatic"
          data-mask-uri={hepaticMaskUri ?? ''}
          aria-label="Hepatic vein trunk"
          style={{
            position: 'absolute',
            inset: 0,
            border: `${lineThickness}px dotted ${VESSEL_COLOR_VARS.hepatic}`,
            borderRadius: 'var(--emr-radius-lg, 12px)',
            opacity: 0.85,
            mixBlendMode: 'normal',
          }}
        />
      ) : null}
    </Box>
  );
});
