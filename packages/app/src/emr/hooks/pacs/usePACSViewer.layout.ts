// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import type { ViewportLayout, ViewportState } from '../../types/pacs';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create the initial set of viewports for a given layout.
 * Each layout has a fixed number of viewport "slots" — this generates
 * a Map of default ViewportState objects for each slot.
 */
export function createViewportsForLayout(layout: ViewportLayout): Map<string, ViewportState> {
  const counts: Record<ViewportLayout, number> = {
    '1x1': 1,
    '1x2': 2,
    '2x1': 2,
    '2x2': 4,
    'mammo-4up': 4,
    '1x3-mpr': 3,
    '1x1-axial': 1,
    '1x1-3d': 1,
    '2x2-mpr-vr': 4,
  };

  // Per-slot viewport type rules:
  //   '1x3-mpr', '1x1-axial'          → 'volume'  (all slots — ORTHOGRAPHIC, volume-backed)
  //   '1x1-3d'                        → 'volume3d' (single VR pane)
  //   '2x2-mpr-vr' indices 0..2 → 'volume', index 3 → 'volume3d'  (3 MPR + 1 VR)
  //   everything else                 → 'stack'  (STACK, 2D bitmaps)
  const slotType = (index: number): ViewportState['type'] => {
    if (layout === '1x3-mpr' || layout === '1x1-axial') return 'volume';
    if (layout === '1x1-3d') return 'volume3d';
    if (layout === '2x2-mpr-vr') return index === 3 ? 'volume3d' : 'volume';
    return 'stack';
  };

  const count = counts[layout];
  const viewports = new Map<string, ViewportState>();

  for (let i = 0; i < count; i++) {
    const id = `viewport-${i}`;
    const type = slotType(i);
    viewports.set(id, {
      id,
      type,
      imageIndex: 0,
      windowLevel: { center: 40, width: 400 },
      zoom: 1.0,
      pan: { x: 0, y: 0 },
      rotation: 0,
      flipH: false,
      flipV: false,
      // Seed a default VR preset on the volume3d slot so the render effect
      // can apply it immediately without an undefined check.
      // 'CtVessel' → 'CT-Coronary-Arteries-2' (the 3mensio orange-vessels-
      // on-translucent-bone preset, same one TAVI Step 9 uses by default).
      // Reuses VOLUME_PRESET_VTK_NAME from volumePresetNames.ts.
      ...(type === 'volume3d' ? { volume3DPreset: 'CtVessel' as const } : {}),
    });
  }

  return viewports;
}

