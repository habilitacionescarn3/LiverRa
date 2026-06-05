// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useViewportResize — ResizeObserver bridging the viewer container to CS3D
// ============================================================================
// Without this, toggling fullscreen stretches/distorts the image because
// Cornerstone keeps rendering at the old canvas dimensions.
//
// Extracted from PACSViewer.tsx (PACS-H10).
// ============================================================================

import { useEffect, type RefObject } from 'react';
import { getOrCreateRenderingEngine } from '../../services/pacs';
import { silentLog } from '../../utils/silentLog';

export function useViewportResize(
  containerRef: RefObject<HTMLDivElement | null>,
  ready: boolean
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ready) {
      return;
    }
    const observer = new ResizeObserver(() => {
      try {
        const renderingEngine = getOrCreateRenderingEngine();
        renderingEngine.resize();
        // PACS-VT3: explicitly re-render after a resize. Cornerstone's `resize()`
        // updates the offscreen canvas dimensions but does not always repaint
        // when the new size is dramatically smaller (e.g. desktop → mobile
        // breakpoint), leaving viewports black until the user manually scrubs.
        if (typeof renderingEngine.render === 'function') {
          renderingEngine.render();
        }
      } catch (err) {
        console.warn('[useViewportResize] best-effort PACS operation failed:', err);
        silentLog('PACSViewer', 'engineResize', err);
        // Engine may not be initialized yet
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, ready]);
}
