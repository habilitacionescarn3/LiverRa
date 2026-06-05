// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useCineFrameSync — bridges useCinePlayback frame counter → CS3D viewport
// ============================================================================
// useCinePlayback manages a frame counter but doesn't talk to Cornerstone3D
// directly. This effect bridges the two: when cine.currentFrame changes, we
// tell the viewport to display that frame and report the new SOP UID up so
// the Key Image Gallery knows which frame is on screen.
//
// Extracted from PACSViewer.tsx (PACS-H10).
// ============================================================================

import { useEffect } from 'react';
import { getOrCreateRenderingEngine } from '../../services/pacs';
import { silentLog } from '../../utils/silentLog';

interface CS3DStackViewport {
  setImageIdIndex: (index: number) => void;
  getCurrentImageId: () => string | undefined;
}

function isStackViewport(value: unknown): value is CS3DStackViewport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { setImageIdIndex?: unknown; getCurrentImageId?: unknown };
  return (
    typeof candidate.setImageIdIndex === 'function' &&
    typeof candidate.getCurrentImageId === 'function'
  );
}

// Extract the SOP Instance UID from a wadors image ID.
function extractSopUidFromImageId(imageId: string): string | undefined {
  const match = imageId.match(/\/instances\/([^/]+)/);
  return match?.[1];
}

export interface UseCineFrameSyncOptions {
  isMultiFrame: boolean;
  currentFrame: number;
  ready: boolean;
  activeViewportId: string | undefined;
  onSopInstanceChange: (sopUid: string | undefined) => void;
}

export function useCineFrameSync({
  isMultiFrame,
  currentFrame,
  ready,
  activeViewportId,
  onSopInstanceChange,
}: UseCineFrameSyncOptions): void {
  useEffect(() => {
    if (!isMultiFrame || !ready) {
      return;
    }
    try {
      const renderingEngine = getOrCreateRenderingEngine();
      const viewport = renderingEngine.getViewport(activeViewportId ?? 'viewport-0');
      if (isStackViewport(viewport)) {
        viewport.setImageIdIndex(currentFrame);
        const currentImageId = viewport.getCurrentImageId();
        if (currentImageId) {
          onSopInstanceChange(extractSopUidFromImageId(currentImageId));
        }
      }
    } catch (err) {
      console.warn('[useCineFrameSync] best-effort PACS operation failed:', err);
      silentLog('PACSViewer', 'cineFrameSync', err);
      // Viewport may not be ready
    }
  }, [currentFrame, isMultiFrame, ready, activeViewportId, onSopInstanceChange]);
}
