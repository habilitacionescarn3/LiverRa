// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useCalibrationPolling — Track pixel length of the active calibration line
// ============================================================================
// Polls Cornerstone3D annotation state every 500ms while calibrating, so the
// parent can enable the French-size confirm buttons once a Length annotation
// has been drawn. Resets to null when calibration mode exits.
//
// Extracted from PACSViewer.tsx (PACS-H10).
// ============================================================================

import { useEffect, useState } from 'react';
import { getLatestLengthAnnotationPixels } from '../../services/pacs/cornerstoneInit';

export function useCalibrationPolling(isCalibrating: boolean): number | null {
  const [calibrationPixelLength, setCalibrationPixelLength] = useState<number | null>(null);

  useEffect(() => {
    setCalibrationPixelLength(null);
    if (!isCalibrating) {
      return;
    }
    const interval = setInterval(() => {
      const px = getLatestLengthAnnotationPixels();
      if (px !== null && px > 0) {
        setCalibrationPixelLength(px);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [isCalibrating]);

  return isCalibrating ? calibrationPixelLength : null;
}
