// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useKeyboardShortcuts Hook
// ============================================================================
// Configurable keyboard shortcuts for the PACS medical image viewer.
// Think of it like a customizable remote control — each key maps to a viewer
// action (tool switch, layout change, mode toggle, etc.). Users can remap keys,
// and the mappings are saved to localStorage so they persist across sessions.
//
// Default shortcuts:
//   W=WindowLevel, Z=Zoom, P=Pan, S=Scroll, L=Length, A=Angle, E=ROI,
//   M=MPR, 3=3D, R=Reset, ?=Help
//
// Features:
// - Custom key mappings via setShortcut
// - Conflict detection (warns if a key is already in use)
// - Disabled when a modal is open or when typing in an input field
// - Persisted to localStorage
//
// Ported from MediMind (hooks/pacs/useKeyboardShortcuts.ts). No Medplum.
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import type { PACSViewerTool } from '../../types/pacs';

// ============================================================================
// Types
// ============================================================================

/** Actions that can be triggered by keyboard shortcuts */
export type ShortcutAction =
  | { type: 'tool'; tool: PACSViewerTool }
  | { type: 'action'; action: 'reset' | 'mpr' | '3d' | 'help' | 'cineToggle' | 'cineStepForward' | 'cineStepBackward' | 'fullScreen' | 'prevStudy' | 'nextStudy' };

/** A single keyboard shortcut mapping */
export interface ShortcutMapping {
  /** The key that triggers this action (case-insensitive for letters) */
  key: string;
  /** A human-readable label for the shortcut group */
  group: 'tools' | 'actions' | 'modes';
  /** Human-readable label for this shortcut */
  label: string;
  /** What happens when the key is pressed */
  action: ShortcutAction;
}

/** Conflict info returned when trying to set a shortcut that's already used */
export interface ShortcutConflict {
  /** The key that conflicts */
  key: string;
  /** The existing shortcut using that key */
  existingLabel: string;
}

/** Return value of the useKeyboardShortcuts hook */
export interface UseKeyboardShortcutsReturn {
  /** All current shortcut mappings */
  shortcuts: ShortcutMapping[];
  /** Remap a shortcut by its label to a new key. Returns a conflict if the key is taken. */
  setShortcut: (label: string, newKey: string) => ShortcutConflict | null;
  /** Reset all shortcuts to their defaults */
  resetToDefaults: () => void;
  /** Whether the help overlay should be shown */
  isHelpOpen: boolean;
  /** Toggle the help overlay */
  toggleHelp: () => void;
  /** Close the help overlay */
  closeHelp: () => void;
  /** Temporarily disable all shortcuts (e.g., when a modal is open) */
  setEnabled: (enabled: boolean) => void;
  /** Whether shortcuts are currently enabled */
  enabled: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const STORAGE_KEY = 'pacs-keyboard-shortcuts';

/** Default shortcut mappings — the "factory remote" settings */
const DEFAULT_SHORTCUTS: ShortcutMapping[] = [
  // Tools (mutually exclusive, like switching channels)
  { key: 'w', group: 'tools', label: 'pacs.shortcut.windowLevel', action: { type: 'tool', tool: 'WindowLevel' } },
  { key: 'z', group: 'tools', label: 'pacs.shortcut.zoom', action: { type: 'tool', tool: 'Zoom' } },
  { key: 'p', group: 'tools', label: 'pacs.shortcut.pan', action: { type: 'tool', tool: 'Pan' } },
  { key: 's', group: 'tools', label: 'pacs.shortcut.scroll', action: { type: 'tool', tool: 'StackScroll' } },
  { key: 'l', group: 'tools', label: 'pacs.shortcut.length', action: { type: 'tool', tool: 'Length' } },
  { key: 'a', group: 'tools', label: 'pacs.shortcut.angle', action: { type: 'tool', tool: 'Angle' } },
  { key: 'e', group: 'tools', label: 'pacs.shortcut.ellipticalROI', action: { type: 'tool', tool: 'EllipticalROI' } },
  { key: 'i', group: 'tools', label: 'pacs.shortcut.probe', action: { type: 'tool', tool: 'Probe' } },
  { key: 'd', group: 'tools', label: 'pacs.shortcut.dragProbe', action: { type: 'tool', tool: 'DragProbe' } },
  { key: 'b', group: 'tools', label: 'pacs.shortcut.bidirectional', action: { type: 'tool', tool: 'Bidirectional' } },
  { key: 't', group: 'tools', label: 'pacs.shortcut.arrowAnnotate', action: { type: 'tool', tool: 'ArrowAnnotate' } },
  { key: 'g', group: 'tools', label: 'pacs.shortcut.freehandROI', action: { type: 'tool', tool: 'FreehandROI' } },
  { key: 'c', group: 'tools', label: 'pacs.shortcut.circleROI', action: { type: 'tool', tool: 'CircleROI' } },
  { key: 'u', group: 'tools', label: 'pacs.shortcut.rectangleROI', action: { type: 'tool', tool: 'RectangleROI' } },
  { key: 'o', group: 'tools', label: 'pacs.shortcut.cobbAngle', action: { type: 'tool', tool: 'CobbAngle' } },
  { key: 'x', group: 'tools', label: 'pacs.shortcut.splineROI', action: { type: 'tool', tool: 'SplineROI' } },
  { key: 'n', group: 'tools', label: 'pacs.shortcut.magnifyTool', action: { type: 'tool', tool: 'MagnifyTool' } },
  // Modes (toggle on/off)
  { key: 'm', group: 'modes', label: 'pacs.shortcut.mpr', action: { type: 'action', action: 'mpr' } },
  { key: '3', group: 'modes', label: 'pacs.shortcut.3dVolume', action: { type: 'action', action: '3d' } },
  // Actions (fire-and-forget)
  { key: 'r', group: 'actions', label: 'pacs.shortcut.resetView', action: { type: 'action', action: 'reset' } },
  { key: '?', group: 'actions', label: 'pacs.shortcut.help', action: { type: 'action', action: 'help' } },
  // Cine playback (multi-frame DICOM images)
  { key: ' ', group: 'actions', label: 'pacs.shortcut.playPause', action: { type: 'action', action: 'cineToggle' } },
  { key: 'ArrowRight', group: 'actions', label: 'pacs.shortcut.nextFrame', action: { type: 'action', action: 'cineStepForward' } },
  { key: 'ArrowLeft', group: 'actions', label: 'pacs.shortcut.prevFrame', action: { type: 'action', action: 'cineStepBackward' } },
  // Full-screen toggle & study navigation
  { key: 'f', group: 'actions', label: 'pacs.shortcut.fullScreen', action: { type: 'action', action: 'fullScreen' } },
  { key: 'PageUp', group: 'actions', label: 'pacs.shortcut.prevStudy', action: { type: 'action', action: 'prevStudy' } },
  { key: 'PageDown', group: 'actions', label: 'pacs.shortcut.nextStudy', action: { type: 'action', action: 'nextStudy' } },
];

// ============================================================================
// Helpers
// ============================================================================

/** Normalize a key string for comparison (lowercase letters, keep special chars) */
function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Load custom mappings from localStorage, falling back to defaults */
function loadShortcuts(): ShortcutMapping[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return [...DEFAULT_SHORTCUTS.map((s) => ({ ...s }))];
    }
    const parsed = JSON.parse(stored) as Array<{ label: string; key: string }>;
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_SHORTCUTS.map((s) => ({ ...s }))];
    }

    // Merge stored key mappings onto the default structure
    // This way, if we add new shortcuts in the future, they get the default key
    const keyByLabel = new Map(parsed.map((p) => [p.label, p.key]));
    return DEFAULT_SHORTCUTS.map((def) => ({
      ...def,
      key: keyByLabel.get(def.label) ?? def.key,
    }));
  } catch {
    return [...DEFAULT_SHORTCUTS.map((s) => ({ ...s }))];
  }
}

/** Save only the label→key pairs to localStorage (minimal footprint) */
function saveShortcuts(shortcuts: ShortcutMapping[]): void {
  try {
    const minimal = shortcuts.map((s) => ({ label: s.label, key: s.key }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(minimal));
  } catch {
    // Storage full or unavailable — silently fail
  }
}

// ============================================================================
// Hook
// ============================================================================

interface UseKeyboardShortcutsOptions {
  /** Called when a tool shortcut is pressed */
  onToolChange?: (tool: PACSViewerTool) => void;
  /** Called when the reset action is triggered */
  onReset?: () => void;
  /** Called when MPR toggle is triggered */
  onMPRToggle?: () => void;
  /** Called when 3D toggle is triggered */
  on3DToggle?: () => void;
  /** Called when cine play/pause is toggled */
  onCineToggle?: () => void;
  /** Called when stepping to the next frame */
  onCineStepForward?: () => void;
  /** Called when stepping to the previous frame */
  onCineStepBackward?: () => void;
  /** Called when full-screen toggle is pressed */
  onFullScreenToggle?: () => void;
  /** Called when previous study is triggered */
  onPrevStudy?: () => void;
  /** Called when next study is triggered */
  onNextStudy?: () => void;
  /** Called when Ctrl+Z is pressed (undo annotation) */
  onUndo?: () => void;
  /** Called when Ctrl+Shift+Z or Ctrl+Y is pressed (redo annotation) */
  onRedo?: () => void;
  /** Called when Escape is pressed (cancel in-progress annotation) */
  onCancelAnnotation?: () => void;
  /** Called when Delete or Backspace is pressed (remove selected annotation) */
  onDeleteAnnotation?: () => void;
}

export function useKeyboardShortcuts(
  options: UseKeyboardShortcutsOptions = {}
): UseKeyboardShortcutsReturn {
  const [shortcuts, setShortcuts] = useState<ShortcutMapping[]>(loadShortcuts);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);

  // Use refs for callbacks so the keydown handler doesn't need to re-register
  // every time a callback changes (prevents stale closures)
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const helpOpenRef = useRef(isHelpOpen);
  helpOpenRef.current = isHelpOpen;

  // --------------------------------------------------------------------------
  // Keyboard event handler
  // --------------------------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Don't fire when shortcuts are disabled (e.g., modal is open)
      if (!enabledRef.current) {
        return;
      }

      // Don't fire when typing in form fields
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }
      if (target?.isContentEditable) {
        return;
      }

      // Escape key — cancel in-progress annotation drawing
      // Handled before modifier check because Escape never has modifiers and
      // should work regardless. Like pressing Escape while dragging a file.
      if (e.key === 'Escape') {
        e.preventDefault();
        optionsRef.current.onCancelAnnotation?.();
        return;
      }

      // Delete/Backspace — remove the selected annotation from the viewport
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        optionsRef.current.onDeleteAnnotation?.();
        return;
      }

      // Ignore when modifier keys are held (those are browser shortcuts)
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      const pressedKey = normalizeKey(e.key);
      const mapping = shortcutsRef.current.find((s) => normalizeKey(s.key) === pressedKey);

      if (!mapping) {
        return;
      }

      // Prevent default browser behavior for matched shortcuts
      e.preventDefault();

      const { action } = mapping;

      if (action.type === 'tool') {
        optionsRef.current.onToolChange?.(action.tool);
      } else if (action.type === 'action') {
        switch (action.action) {
          case 'reset':
            optionsRef.current.onReset?.();
            break;
          case 'mpr':
            optionsRef.current.onMPRToggle?.();
            break;
          case '3d':
            optionsRef.current.on3DToggle?.();
            break;
          case 'help':
            setIsHelpOpen((prev) => !prev);
            break;
          case 'cineToggle':
            optionsRef.current.onCineToggle?.();
            break;
          case 'cineStepForward':
            optionsRef.current.onCineStepForward?.();
            break;
          case 'cineStepBackward':
            optionsRef.current.onCineStepBackward?.();
            break;
          case 'fullScreen':
            optionsRef.current.onFullScreenToggle?.();
            break;
          case 'prevStudy':
            optionsRef.current.onPrevStudy?.();
            break;
          case 'nextStudy':
            optionsRef.current.onNextStudy?.();
            break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // Empty deps — handler uses refs for current values

  // --------------------------------------------------------------------------
  // Ctrl/Meta key combos: Undo (Ctrl+Z) and Redo (Ctrl+Shift+Z / Ctrl+Y)
  // --------------------------------------------------------------------------
  // Separate handler because the main handler ignores modifier keys.
  // These work like undo/redo in a drawing app — step through annotation history.
  useEffect(() => {
    const handleCtrlKeyDown = (e: KeyboardEvent): void => {
      if (!enabledRef.current) {
        return;
      }

      // Don't fire when typing in form fields
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }
      if (target?.isContentEditable) {
        return;
      }

      // Only handle Ctrl/Meta combos (not plain keys or Alt combos)
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }

      const key = e.key.toLowerCase();

      // Ctrl+Shift+Z → Redo
      if (key === 'z' && e.shiftKey) {
        e.preventDefault();
        optionsRef.current.onRedo?.();
        return;
      }

      // Ctrl+Z → Undo
      if (key === 'z') {
        e.preventDefault();
        optionsRef.current.onUndo?.();
        return;
      }

      // Ctrl+Y → Redo (alternative shortcut)
      if (key === 'y') {
        e.preventDefault();
        optionsRef.current.onRedo?.();
        return;
      }
    };

    window.addEventListener('keydown', handleCtrlKeyDown);
    return () => window.removeEventListener('keydown', handleCtrlKeyDown);
  }, []); // Empty deps — handler uses refs for current values

  // --------------------------------------------------------------------------
  // setShortcut — Remap a shortcut to a new key
  // --------------------------------------------------------------------------
  const setShortcut = useCallback(
    (label: string, newKey: string): ShortcutConflict | null => {
      const normalized = normalizeKey(newKey);

      // Check for conflict: is this key already used by another shortcut?
      const existing = shortcutsRef.current.find(
        (s) => normalizeKey(s.key) === normalized && s.label !== label
      );

      if (existing) {
        return { key: newKey, existingLabel: existing.label };
      }

      setShortcuts((prev) => {
        const updated = prev.map((s) =>
          s.label === label ? { ...s, key: normalized } : s
        );
        saveShortcuts(updated);
        return updated;
      });

      return null;
    },
    []
  );

  // --------------------------------------------------------------------------
  // resetToDefaults — Go back to factory settings
  // --------------------------------------------------------------------------
  const resetToDefaults = useCallback(() => {
    const defaults = DEFAULT_SHORTCUTS.map((s) => ({ ...s }));
    setShortcuts(defaults);
    saveShortcuts(defaults);
  }, []);

  // --------------------------------------------------------------------------
  // Help overlay controls
  // --------------------------------------------------------------------------
  const toggleHelp = useCallback(() => {
    setIsHelpOpen((prev) => !prev);
  }, []);

  const closeHelp = useCallback(() => {
    setIsHelpOpen(false);
  }, []);

  return {
    shortcuts,
    setShortcut,
    resetToDefaults,
    isHelpOpen,
    toggleHelp,
    closeHelp,
    setEnabled,
    enabled,
  };
}
