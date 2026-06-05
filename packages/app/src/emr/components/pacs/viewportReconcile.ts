// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Viewport reconciliation helpers (extracted from PACSViewer for unit testing)
// ============================================================================
// Cornerstone3D's `renderingEngine.setViewports(...)` reuses a viewport slot
// whose id already exists. Two failure modes follow:
//   1. A slot that is LEAVING the next layout must be torn down (disableElement)
//      or the next `addViewport` throws "already in group".
//   2. A slot whose TYPE changes (e.g. STACK → VOLUME_3D when toggling solo 3D)
//      is SILENTLY not swapped unless the element is disabled first.
// `reconcileViewports` handles both by comparing the previous id→type registry
// against the next render's id→type map and detaching every id that is leaving
// OR whose type changed.
// ============================================================================

/** The three Cornerstone-backed viewport kinds we register (mirrors ViewportState['type']). */
export type RegisteredVpType = 'stack' | 'volume' | 'volume3d';

// Minimal duck-typed shapes — Cornerstone's public engine/tool-group types omit
// these methods on some viewport unions, so we narrow to what we actually call.
export interface ViewportCleanupEngine {
  id: string;
  disableElement?: (viewportId: string) => void;
}
export interface ViewportCleanupToolGroup {
  removeViewports?: (renderingEngineId: string, viewportId?: string) => void;
}

/**
 * Detach the given viewport ids from a tool group AND the rendering engine.
 * Best-effort: every call is individually try-caught so one bad id can't abort
 * the rest of the teardown.
 */
export function detachViewportIds(
  ids: Iterable<string>,
  engine: ViewportCleanupEngine,
  toolGroup: ViewportCleanupToolGroup
): void {
  for (const viewportId of ids) {
    try {
      toolGroup.removeViewports?.(engine.id, viewportId);
    } catch (err) {
      console.warn('[PACSViewer] toolGroup.removeViewports failed for', viewportId, err);
    }
    try {
      engine.disableElement?.(viewportId);
    } catch (err) {
      console.warn('[PACSViewer] engine.disableElement failed for', viewportId, err);
    }
  }
}

/**
 * Reconcile the engine + tool-group viewport registration against the NEXT
 * render's id→type map. Disables (detaches from both the stack and VR tool
 * groups) any id that is leaving OR whose viewport TYPE changed, then returns
 * the new registry to store for the following pass.
 *
 * Type-awareness is what fixes the "3D only opens the first time" bug: a reused
 * `viewport-0` flipping STACK→VOLUME_3D stays in `next`, so a leaving-only check
 * never disables it and Cornerstone silently keeps the old stack viewport.
 */
export function reconcileViewports(
  prev: Map<string, RegisteredVpType>,
  next: Map<string, RegisteredVpType>,
  engine: ViewportCleanupEngine,
  stackGroup: ViewportCleanupToolGroup,
  vrGroup: ViewportCleanupToolGroup
): Map<string, RegisteredVpType> {
  const toDisable: string[] = [];
  for (const [id, type] of prev) {
    // `next.get(id) !== type` covers BOTH "id is leaving" (get → undefined)
    // AND "type changed" in one comparison.
    if (next.get(id) !== type) {
      toDisable.push(id);
    }
  }
  if (toDisable.length > 0) {
    detachViewportIds(toDisable, engine, stackGroup);
    detachViewportIds(toDisable, engine, vrGroup);
  }
  return new Map(next);
}
