// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
//
// ── Friendly volume-rendering preset names → VTK preset names ────────────────
//
// Cornerstone3D's `BaseVolumeViewport.setProperties({ preset })` does strict
// `VIEWPORT_PRESETS.find(p => p.name === name)` — no case-insensitive match,
// no partial match (see `BaseVolumeViewport.js:885-898`). The MediMind UX
// uses friendly preset names ('Bone', 'SoftTissue', 'Lung', 'Vascular',
// 'CtVessel'), but those don't match any shipped VTK preset name — without
// translation, every call would silently no-op.
//
// This module is the SINGLE source of truth that maps each friendly preset
// to its actual VTK preset name from the bundled `CONSTANTS.VIEWPORT_PRESETS`
// library. The 'CtVessel' VTK preset name ('CT-Coronary-Arteries-2') is inlined
// here so the PACS viewer does not import the TAVI tree (pacs-planning); the
// TAVI access-route viewport keeps its own copy in vrViewportMode.ts.

import type { TransferFunctionPreset } from '../../types/pacs';

/**
 * Map a MediMind-friendly preset name to the actual VTK preset name shipped
 * in `@cornerstonejs/core` `CONSTANTS.VIEWPORT_PRESETS`. Every value in the
 * map must be a preset that the VTK community library actually ships, else
 * `setProperties` will silently no-op.
 */
export const VOLUME_PRESET_VTK_NAME: Record<TransferFunctionPreset, string> = {
  Bone: 'CT-Bone',
  SoftTissue: 'CT-Soft-Tissue',
  Lung: 'CT-Lung',
  Vascular: 'CT-Chest-Vessels',
  CtVessel: 'CT-Coronary-Arteries-2',
};
