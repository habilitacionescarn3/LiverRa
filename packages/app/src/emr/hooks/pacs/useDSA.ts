// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useDSA Hook
// ============================================================================
// Manages the UI state for Digital Subtraction Angiography (DSA). Think of it
// like a TV remote control for DSA — it tracks whether DSA mode is on/off,
// which "before" frame (mask) is selected, how much the mask has been shifted
// to correct for patient movement, and whether the user wants to see the
// original (un-subtracted) image.
//
// This hook does NOT perform the actual pixel subtraction (that's dsaService).
// It only manages the state that drives the DSA UI and passes parameters to
// the subtraction engine.
// ============================================================================

import { useState, useCallback } from 'react';

// ============================================================================
// Constants
// ============================================================================

/** Maximum allowed pixel shift in any direction (prevents wild offsets) */
export const MAX_SHIFT = 50;

// ============================================================================
// Types
// ============================================================================

export interface DSAState {
  /** Whether DSA mode is currently active */
  isActive: boolean;
  /** Index of the mask (pre-contrast) frame, null when DSA is off */
  maskFrameIndex: number | null;
  /** Horizontal pixel shift for motion correction */
  shiftX: number;
  /** Vertical pixel shift for motion correction */
  shiftY: number;
  /** Whether showing the original (un-subtracted) image */
  showOriginal: boolean;
}

export interface UseDSAReturn {
  /** Current DSA state */
  dsaState: DSAState;
  /** Turn DSA mode on — sets isActive true and maskFrameIndex to 0 */
  activateDSA: () => void;
  /** Turn DSA mode off — resets all state to defaults */
  deactivateDSA: () => void;
  /** Toggle DSA on/off (convenience — calls activate or deactivate) */
  toggleDSA: () => void;
  /** Change the mask frame index (no-op if DSA is inactive) */
  setMaskFrame: (index: number) => void;
  /** Shift the mask by a delta (accumulates, clamped to +/-50) (no-op if DSA is inactive) */
  shiftMask: (dx: number, dy: number) => void;
  /** Set absolute shift values (clamped to +/-50) (no-op if DSA is inactive) */
  setShift: (x: number, y: number) => void;
  /** Toggle between subtracted and original view (no-op if DSA is inactive) */
  toggleOriginal: () => void;
  /** Alias for toggleOriginal — used by DSAControls */
  toggleShowOriginal: () => void;
}

// ============================================================================
// Initial state
// ============================================================================

const INITIAL_STATE: DSAState = {
  isActive: false,
  maskFrameIndex: null,
  shiftX: 0,
  shiftY: 0,
  showOriginal: false,
};

// ============================================================================
// Hook
// ============================================================================

export function useDSA(): UseDSAReturn {
  const [dsaState, setDsaState] = useState<DSAState>(INITIAL_STATE);

  const activateDSA = useCallback(() => {
    setDsaState({
      isActive: true,
      maskFrameIndex: 0,
      shiftX: 0,
      shiftY: 0,
      showOriginal: false,
    });
  }, []);

  const deactivateDSA = useCallback(() => {
    setDsaState(INITIAL_STATE);
  }, []);

  const setMaskFrame = useCallback((index: number) => {
    setDsaState((prev) => {
      if (!prev.isActive) {
        return prev;
      }
      return { ...prev, maskFrameIndex: index };
    });
  }, []);

  const shiftMask = useCallback((dx: number, dy: number) => {
    setDsaState((prev) => {
      if (!prev.isActive) {
        return prev;
      }
      const newX = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, prev.shiftX + dx));
      const newY = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, prev.shiftY + dy));
      return { ...prev, shiftX: newX, shiftY: newY };
    });
  }, []);

  const toggleOriginal = useCallback(() => {
    setDsaState((prev) => {
      if (!prev.isActive) {
        return prev;
      }
      return { ...prev, showOriginal: !prev.showOriginal };
    });
  }, []);

  /** Toggle DSA on/off — convenience wrapper for activate/deactivate */
  const toggleDSA = useCallback(() => {
    setDsaState((prev) => {
      if (prev.isActive) {
        return INITIAL_STATE;
      }
      return {
        isActive: true,
        maskFrameIndex: 0,
        shiftX: 0,
        shiftY: 0,
        showOriginal: false,
      };
    });
  }, []);

  /** Set absolute shift values (used by DSAControls sliders) */
  const setShift = useCallback((x: number, y: number) => {
    setDsaState((prev) => {
      if (!prev.isActive) {
        return prev;
      }
      const clampedX = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, x));
      const clampedY = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, y));
      return { ...prev, shiftX: clampedX, shiftY: clampedY };
    });
  }, []);

  return {
    dsaState,
    activateDSA,
    deactivateDSA,
    toggleDSA,
    setMaskFrame,
    shiftMask,
    setShift,
    toggleOriginal,
    toggleShowOriginal: toggleOriginal,
  };
}
