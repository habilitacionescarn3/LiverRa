// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useStenosisPolling — Stenosis-mode state + measurement polling
// ============================================================================
// Owns the stenosis toggle and the polled RVD/MLD measurements derived from
// the two most-recent Length annotations (auto-sorted: larger = RVD reference
// vessel, smaller = MLD minimum lumen).
//
// Extracted from PACSViewer.tsx (PACS-H10).
// ============================================================================

import { useState, useCallback, useEffect } from 'react';
import { getRecentLengthAnnotationPixels } from '../../services/pacs/cornerstoneInit';

export interface UseStenosisPollingReturn {
  isStenosisActive: boolean;
  toggleStenosis: () => void;
  stenosisRVD: number | null;
  stenosisMLD: number | null;
  stenosisError: string | null;
  stenosisSubMode: 'manual' | 'qca';
  setStenosisSubMode: (mode: 'manual' | 'qca') => void;
}

export function useStenosisPolling(
  calibrationMmPerPixel: number | null
): UseStenosisPollingReturn {
  const [isStenosisActive, setIsStenosisActive] = useState(false);
  const [stenosisRVD, setStenosisRVD] = useState<number | null>(null);
  const [stenosisMLD, setStenosisMLD] = useState<number | null>(null);
  const [stenosisError, setStenosisError] = useState<string | null>(null);
  const [stenosisSubMode, setStenosisSubMode] = useState<'manual' | 'qca'>('manual');

  const toggleStenosis = useCallback(() => {
    setIsStenosisActive((prev) => !prev);
    setStenosisRVD(null);
    setStenosisMLD(null);
    setStenosisError(null);
    setStenosisSubMode('manual');
  }, []);

  // Poll for stenosis measurements when stenosis mode is active.
  // The user draws two Length annotations (in any order). We auto-sort so
  // the larger value = RVD (reference vessel), smaller = MLD (minimum lumen).
  useEffect(() => {
    if (!isStenosisActive) return;

    const interval = setInterval(() => {
      // CROSS-M23 (2026-05-06 audit): wrap polling body in try/catch so a
      // CS3D failure doesn't kill the interval silently.
      try {
        if (calibrationMmPerPixel === null) {
          setStenosisRVD(null);
          setStenosisMLD(null);
          setStenosisError(null);
          return;
        }
        const pixels = getRecentLengthAnnotationPixels(2);
        setStenosisError(null);
        if (pixels.length >= 2) {
          const mm0 = pixels[0] * calibrationMmPerPixel;
          const mm1 = pixels[1] * calibrationMmPerPixel;
          // Auto-sort: larger = RVD (normal vessel), smaller = MLD (narrowest)
          setStenosisRVD(Math.max(mm0, mm1));
          setStenosisMLD(Math.min(mm0, mm1));
        } else if (pixels.length === 1) {
          setStenosisRVD(pixels[0] * calibrationMmPerPixel);
          setStenosisMLD(null);
        } else {
          setStenosisRVD(null);
          setStenosisMLD(null);
        }
      } catch (err) {
        console.warn('[PACSViewer] stenosis poll failed:', err);
        setStenosisRVD(null);
        setStenosisMLD(null);
        setStenosisError('measurement-read-failed');
      }
    }, 500);
    return () => clearInterval(interval);
  }, [isStenosisActive, calibrationMmPerPixel]);

  return {
    isStenosisActive,
    toggleStenosis,
    stenosisRVD,
    stenosisMLD,
    stenosisError,
    stenosisSubMode,
    setStenosisSubMode,
  };
}
