// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useInitialSopSync — set initial SOP UID once the viewport has its first image
// ============================================================================
// Re-runs whenever the active series or viewport changes so the Key Image
// Gallery can highlight whatever instance is now on screen. Uses a 500ms
// delay to let the viewport finish loading its initial image.
//
// Extracted from PACSViewer.tsx (PACS-H10).
// ============================================================================

import { useEffect } from 'react';
import { getOrCreateRenderingEngine } from '../../services/pacs';
import { silentLog } from '../../utils/silentLog';

interface CS3DStackViewport {
  getCurrentImageId: () => string | undefined;
}

function hasCurrentImageId(value: unknown): value is CS3DStackViewport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { getCurrentImageId?: unknown }).getCurrentImageId === 'function';
}

export function extractSopUidFromImageId(imageId: string): string | undefined {
  const match = imageId.match(/\/instances\/([^/]+)/);
  return match?.[1];
}

export interface UseInitialSopSyncOptions {
  ready: boolean;
  activeSeriesUid: string | undefined;
  activeViewportId: string | undefined;
  onSopInstanceChange: (sopUid: string | undefined) => void;
}

export function useInitialSopSync({
  ready,
  activeSeriesUid,
  activeViewportId,
  onSopInstanceChange,
}: UseInitialSopSyncOptions): void {
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      try {
        const renderingEngine = getOrCreateRenderingEngine();
        const viewport = renderingEngine.getViewport(activeViewportId ?? 'viewport-0');
        const currentImageId = hasCurrentImageId(viewport) ? viewport.getCurrentImageId() : undefined;
        if (currentImageId) {
          onSopInstanceChange(extractSopUidFromImageId(currentImageId));
        }
      } catch (err) {
        silentLog('PACSViewer', 'syncSopInstanceTimer', err);
        console.warn('[useInitialSopSync] best-effort PACS operation failed:', err);
        // Viewport may not be ready
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [ready, activeSeriesUid, activeViewportId, onSopInstanceChange]);
}
