// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useViewportWheelScroll — empty-viewport wheel GUARD (not a scroller)
// ============================================================================
// Wheel -> slice navigation is owned SOLELY by Cornerstone's native
// StackScrollTool, bound to the wheel inside `activateToolOnGroup`
// (`cornerstoneInit.ts` -> `['StackScroll', MouseBindings.Wheel]`). This
// hook does NOT scroll — doing so here too would double-advance every tick
// (the lag bug fixed in B5). It now does ONE small defensive thing:
//
//   When the panel under the cursor has NO images yet, Cornerstone's
//   native StackScrollTool throws an UNCAUGHT
//   `Scroll::Stack Viewport has no images` on every wheel tick (ugly
//   console error, pre-existing). We attach a CAPTURE-phase wheel listener
//   so we run BEFORE the viewport element's native handler, and if that
//   viewport has no images we swallow the event so the native tool never
//   runs (and never throws). When the viewport HAS images we do nothing —
//   the event flows straight to native StackScroll, which remains the sole
//   owner of actual slice scrolling (no double-handling).
//
// History: PACS-H10 (extracted from PACSViewer.tsx), PACS-H14 (ref/once),
// B5 (manual scroller removed -> native single owner), B5-guard (this).
// ============================================================================

import { useEffect } from 'react';
import { getOrCreateRenderingEngine } from '../../services/pacs';

interface MaybeStackViewport {
  getImageIds?: () => string[];
}

export function useViewportWheelScroll(
  _activeViewportId: string | undefined,
  ready: boolean
): void {
  useEffect(() => {
    if (!ready) return;
    const root = document.body;
    if (!root) return;

    // Capture phase: runs before the viewport element's own (bubble-phase)
    // native StackScroll wheel listener, so a swallow here prevents the
    // uncaught throw without interfering with normal scrolling.
    const guard = (e: WheelEvent): void => {
      try {
        if (!(e.target instanceof Element)) return;
        // Resolve the panel under the cursor (works for any pane in a
        // multi-viewport layout, not just the active one).
        const vpEl = e.target.closest('[id^="cs3d-"]');
        if (!vpEl) return;
        const viewportId = vpEl.id.slice('cs3d-'.length);
        if (!viewportId) return;

        const engine = getOrCreateRenderingEngine();
        const viewport = engine.getViewport(viewportId) as
          | MaybeStackViewport
          | undefined;
        // Only act on stack viewports that expose getImageIds. Volume
        // (MPR/TAVI) viewports don't throw this error — leave them alone.
        if (!viewport || typeof viewport.getImageIds !== 'function') return;

        let count = 0;
        try {
          count = viewport.getImageIds().length;
        } catch (err) {
          console.warn('[useViewportWheelScroll] best-effort PACS operation failed:', err);
          count = 0; // mid-teardown / not a stack viewport -> treat as empty
        }
        if (count === 0) {
          // No images: stop the event reaching native StackScroll so it
          // can't throw "Scroll::Stack Viewport has no images".
          e.stopImmediatePropagation();
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
        }
        // count > 0: do nothing — native StackScroll handles the scroll.
      } catch (err) {
        console.warn('[useViewportWheelScroll] best-effort PACS operation failed:', err);
        // A wheel guard must never throw.
      }
    };

    root.addEventListener('wheel', guard, { capture: true, passive: false });
    return () => root.removeEventListener('wheel', guard, { capture: true });
  }, [ready]);
}
