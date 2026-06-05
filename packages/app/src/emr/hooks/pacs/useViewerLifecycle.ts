// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useViewerLifecycle — WebGL context-loss + visibility lifecycle (PACS-B3)
// ============================================================================
// iOS Safari/Capacitor force-kills the WebGL2 context when the page is
// backgrounded; without listeners the next render throws and the tab crashes.
// This hook installs the lifecycle listeners on the first viewport canvas
// once it becomes available (rAF retry loop with bounded attempts).
//
// PACS-M18 fix: rAF retry instead of fixed 200ms setTimeout — race-free
// and adapts to slow first paints on mobile while still capping total wait.
//
// Extracted from PACSViewer.tsx (PACS-H10).
// ============================================================================

import { useEffect } from 'react';
import { installViewerLifecycle, uninstallViewerLifecycle } from '../../services/pacs/cornerstoneInit';

export interface UseViewerLifecycleOptions {
  /** Only install when status === 'ready'. */
  enabled: boolean;
  /** Called when the engine reload should run (e.g. after visibilitychange). */
  onReload: () => void;
}

const MAX_ATTEMPTS = 180; // ~3 seconds @ 60fps; enough for slow DICOM metadata/canvas creation

export function useViewerLifecycle({ enabled, onReload }: UseViewerLifecycleOptions): void {
  useEffect(() => {
    if (!enabled) return;
    let installedCanvas: HTMLCanvasElement | null = null;
    let cancelled = false;
    let rafId: number | null = null;
    let attempts = 0;

    const tryInstall = (): void => {
      if (cancelled) return;
      const host = document.getElementById('cs3d-viewport-0');
      const canvas = host?.querySelector('canvas') as HTMLCanvasElement | null;
      if (canvas) {
        installedCanvas = canvas;
        installViewerLifecycle(
          canvas,
          () => console.warn('[PACSViewer] WebGL context lost — engine destroyed; reload to recover'),
          onReload
        );
        return;
      }
      attempts++;
      if (attempts < MAX_ATTEMPTS) {
        rafId = requestAnimationFrame(tryInstall);
      }
    };
    rafId = requestAnimationFrame(tryInstall);

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      uninstallViewerLifecycle(installedCanvas);
    };
  }, [enabled, onReload]);
}
