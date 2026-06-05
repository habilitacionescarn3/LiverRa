// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Cornerstone3D Private-Shape Compatibility Adapter
// ============================================================================
// Cornerstone3D's PUBLIC types omit several methods we depend on (cached-volume
// access, viewport actors, the VOI setter, tool-group viewport enumeration).
// Historically each call site re-declared its own local `as unknown as { ... }`
// shim for the same private shape, spread across PACSViewer, cornerstoneInit and
// structureIsolation. If Cornerstone renamed a private method or changed a return
// shape, there was no single place to update — failures surfaced indirectly as
// black panes, missing overlays, or broken isolation tools.
//
// This module is that single place. Every helper:
//   * accepts `unknown` (or the public CS type) and narrows behind a runtime
//     `typeof === 'function'` guard, exactly as the inline shims did,
//   * returns the same value / performs the same side effect as the original
//     inline cast — these are behavior-preserving extractions, NOT new logic.
//
// Keep ALL private Cornerstone method/return-shape assumptions HERE so a future
// Cornerstone upgrade has one typed seam to fix.
// ============================================================================

// ----------------------------------------------------------------------------
// getCachedVolume — cache.getVolume(id)
// ----------------------------------------------------------------------------
// `@cornerstonejs/core`'s exported `cache` type does not surface `getVolume` in
// every version, yet it is present at runtime. Callers narrow the returned
// volume shape themselves (they only read the fields they need), so the generic
// param lets each site keep its precise local volume type.

interface CacheLike {
  getVolume?: (id: string) => unknown;
}

export function getCachedVolume<T = unknown>(cache: unknown, volumeId: string): T | undefined {
  const getVolume = (cache as CacheLike)?.getVolume;
  if (typeof getVolume !== 'function') {
    return undefined;
  }
  return getVolume(volumeId) as T | undefined;
}

// ----------------------------------------------------------------------------
// getViewportActors — viewport.getActors()
// ----------------------------------------------------------------------------
// VR / VOLUME_3D viewports expose getActors() at runtime but it is absent from
// the public IViewport union. Returns the raw actor entries (uid / referenceId /
// actor) or [] when the method is unavailable.

export interface CsActorEntry {
  uid?: string;
  referenceId?: string;
  actor?: unknown;
}

export function getViewportActors(viewport: unknown): CsActorEntry[] {
  const getActors = (viewport as { getActors?: () => CsActorEntry[] })?.getActors;
  if (typeof getActors !== 'function') {
    return [];
  }
  return getActors() ?? [];
}

// ----------------------------------------------------------------------------
// setViewportVoiRange — viewport.setProperties({ voiRange })
// ----------------------------------------------------------------------------
// Applies an explicit window/level (voiRange) so a volume pane never renders
// white from Cornerstone's pre-stream auto-VOI. Guarded so it is a safe no-op on
// viewports that don't implement setProperties; returns true when applied.

export function setViewportVoiRange(viewport: unknown, lower: number, upper: number): boolean {
  const setProperties = (viewport as { setProperties?: (p: { voiRange: { lower: number; upper: number } }) => void })
    ?.setProperties;
  if (typeof setProperties !== 'function') {
    return false;
  }
  setProperties({ voiRange: { lower, upper } });
  return true;
}

// ----------------------------------------------------------------------------
// getToolGroupViewportIds — toolGroup.getViewportIds()
// ----------------------------------------------------------------------------
// A tool group's registered viewport ids. `getViewportIds` is present at runtime
// on the IToolGroup but typed loosely; returns [] when unavailable so callers can
// `.length` without guarding.

export function getToolGroupViewportIds(toolGroup: unknown): string[] {
  const getViewportIds = (toolGroup as { getViewportIds?: () => string[] })?.getViewportIds;
  if (typeof getViewportIds !== 'function') {
    return [];
  }
  return getViewportIds() ?? [];
}
