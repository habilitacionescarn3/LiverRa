// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useReportMacros — Hook for report macro management & text expansion
// ============================================================================
// Manages macro state and provides text expansion. Think of macros like
// autocomplete shortcuts: a radiologist types ".impression" and hits Space,
// and it expands into a full "IMPRESSION:\n..." boilerplate text block.
//
// Longest-match-wins: if ".imp" and ".impression" both exist, typing
// ".impression" will use ".impression" (not ".imp").
//
// Phase-2 status (LiverRa):
//   Reads return an empty list until Phase 4 wires the real FHIR store.
//   Writes go through the FHIR stub (logged in the console). The UI still
//   exercises the full create/update/delete flow.
//
// Ported from MediMind (hooks/pacs/useReportMacros.ts) with the
// `useMedplum()` import swapped for `useLiverraFhir()`; everything else is
// a line-for-line copy so expansion semantics remain identical.
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { useLiverraFhir } from '../useLiverraFhir';
import {
  searchMacros,
  createMacro as createMacroService,
  updateMacro as updateMacroService,
  deleteMacro as deleteMacroService,
  getMacroTrigger,
  getMacroExpansion,
  getMacroCategory,
} from '../../services/pacs/macroService';
import type { MacroCategory } from '../../services/pacs/macroService';

// ============================================================================
// Types
// ============================================================================

export interface MacroItem {
  id: string;
  trigger: string;
  expansion: string;
  category: string;
}

export interface MacroExpansionResult {
  /** The full text with the trigger replaced by the expansion. */
  expanded: string;
  /** Where the cursor should be placed after expansion. */
  newCursorPosition: number;
}

export interface UseReportMacrosReturn {
  /** Loaded macros. */
  macros: MacroItem[];
  /** Whether macros are loading. */
  isLoading: boolean;
  /** Try to expand a macro trigger at the cursor position. */
  expandMacro: (text: string, cursorPosition: number) => MacroExpansionResult | null;
  /** Create a new macro. */
  createMacro: (trigger: string, expansion: string, category?: MacroCategory) => Promise<void>;
  /** Update an existing macro. */
  updateMacro: (
    macroId: string,
    updates: { trigger?: string; expansion?: string; category?: string },
  ) => Promise<void>;
  /** Delete a macro. */
  deleteMacro: (macroId: string) => Promise<void>;
}

// ============================================================================
// Hook
// ============================================================================

export function useReportMacros(practitionerId: string): UseReportMacrosReturn {
  const medplum = useLiverraFhir();
  const [macros, setMacros] = useState<MacroItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);

  // Cleanup on unmount — Strict Mode double-mount safe.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load macros from FHIR on mount
  const loadMacros = useCallback(async () => {
    if (!practitionerId) {
      return;
    }
    setIsLoading(true);
    try {
      const resources = await searchMacros(medplum, practitionerId);
      if (!mountedRef.current) {
        return;
      }
      const items: MacroItem[] = resources
        .filter((r) => r.id)
        .map((r) => ({
          id: r.id as string,
          trigger: getMacroTrigger(r),
          expansion: getMacroExpansion(r),
          category: getMacroCategory(r),
        }));
      setMacros(items);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useReportMacros] Failed to load macros:', err);
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [medplum, practitionerId]);

  useEffect(() => {
    void loadMacros();
  }, [loadMacros]);

  // ========================================================================
  // Expand a macro trigger at the cursor position
  // ========================================================================
  // Scans backward from cursorPosition to find a word starting with "."
  // If it matches a loaded macro trigger, replaces it with the expansion.
  // Uses longest-match-wins: ".impression" beats ".imp" when both match.
  const expandMacro = useCallback(
    (text: string, cursorPosition: number): MacroExpansionResult | null => {
      if (macros.length === 0) {
        return null;
      }

      // Scan backward from cursor to find the start of a trigger (a "." character)
      let triggerStart = -1;
      for (let i = cursorPosition - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === '.') {
          triggerStart = i;
          break;
        }
        // Stop scanning if we hit whitespace or a non-word character (except ".")
        if (ch === ' ' || ch === '\n' || ch === '\t') {
          break;
        }
      }

      if (triggerStart === -1) {
        return null;
      }

      // Extract the candidate trigger text
      const candidate = text.slice(triggerStart, cursorPosition).toLowerCase();

      // Find the longest matching macro trigger (case-insensitive)
      let bestMatch: MacroItem | null = null;
      for (const macro of macros) {
        const macroTrigger = macro.trigger.toLowerCase();
        if (candidate === macroTrigger) {
          if (!bestMatch || macro.trigger.length > bestMatch.trigger.length) {
            bestMatch = macro;
          }
        }
      }

      if (!bestMatch) {
        return null;
      }

      // Replace the trigger with the expansion
      const before = text.slice(0, triggerStart);
      const after = text.slice(cursorPosition);
      const expanded = before + bestMatch.expansion + after;
      const newCursorPosition = before.length + bestMatch.expansion.length;

      return { expanded, newCursorPosition };
    },
    [macros],
  );

  // ========================================================================
  // CRUD operations
  // ========================================================================

  const createMacro = useCallback(
    async (trigger: string, expansion: string, category?: MacroCategory) => {
      await createMacroService(medplum, practitionerId, trigger, expansion, category);
      await loadMacros();
    },
    [medplum, practitionerId, loadMacros],
  );

  const updateMacro = useCallback(
    async (
      macroId: string,
      updates: { trigger?: string; expansion?: string; category?: string },
    ) => {
      await updateMacroService(medplum, macroId, updates);
      await loadMacros();
    },
    [medplum, loadMacros],
  );

  const deleteMacro = useCallback(
    async (macroId: string) => {
      await deleteMacroService(medplum, macroId);
      await loadMacros();
    },
    [medplum, loadMacros],
  );

  return {
    macros,
    isLoading,
    expandMacro,
    createMacro,
    updateMacro,
    deleteMacro,
  };
}
