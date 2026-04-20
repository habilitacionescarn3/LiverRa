// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RefinementUndoContext (T240).
 *
 * Plain-English analogy:
 *   Every refinement click is a "move" on a chess board — we keep the
 *   moves stacked so the surgeon can Ctrl-Z back to the original AI
 *   mask at any time. The stack is mirrored to IndexedDB so the moves
 *   survive tab crashes + offline reloads (research §C.6).
 *
 * Spec refs: FR-017 (retain both AI + edited), FR-018 (auto-save),
 * plan §Offline reviewer-edit durability.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { offlineQueue, type OfflineEditType } from '../services/offline/offlineQueue';

export interface RefinementUndoItem {
  /** ULID from offlineQueue — primary correlation id. */
  id: string;
  analysisId: string;
  editType: OfflineEditType;
  /** Inverse action the undo handler replays. */
  inverse: Record<string, unknown>;
  /** User-friendly label for the undo toast / history. */
  label: string;
  createdAt: string;
}

export interface RefinementUndoState {
  /** Chronological stack; `pop()` takes the most-recent. */
  stack: RefinementUndoItem[];
  /** True while a pop is in flight (blocks double-clicks). */
  isUndoing: boolean;
}

export interface RefinementUndoActions {
  push(item: Omit<RefinementUndoItem, 'createdAt'>): Promise<void>;
  undo(): Promise<RefinementUndoItem | null>;
  clear(): Promise<void>;
}

export type RefinementUndoContextValue = RefinementUndoState &
  RefinementUndoActions;

const INITIAL_STATE: RefinementUndoState = { stack: [], isUndoing: false };
const Context = createContext<RefinementUndoContextValue | null>(null);

/** IndexedDB mirror store for the undo stack. */
const UNDO_MIRROR_KEY = 'refinement-undo-stack';

export function RefinementUndoProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [state, setState] = useState<RefinementUndoState>(INITIAL_STATE);
  const stackRef = useRef<RefinementUndoItem[]>([]);

  // Rehydrate from localStorage mirror on mount. The offlineQueue
  // IndexedDB store already holds the POSTable payloads; here we only
  // persist the thin UI-side undo projection.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(UNDO_MIRROR_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as RefinementUndoItem[];
        stackRef.current = parsed;
        setState({ stack: parsed, isUndoing: false });
      }
    } catch {
      /* ignore corrupt mirror */
    }
  }, []);

  const persist = useCallback((): void => {
    try {
      window.localStorage.setItem(
        UNDO_MIRROR_KEY,
        JSON.stringify(stackRef.current),
      );
    } catch {
      /* quota full — non-fatal */
    }
  }, []);

  const push = useCallback(
    async (item: Omit<RefinementUndoItem, 'createdAt'>): Promise<void> => {
      const entry: RefinementUndoItem = {
        ...item,
        createdAt: new Date().toISOString(),
      };
      stackRef.current = [...stackRef.current, entry];
      setState({ stack: stackRef.current, isUndoing: false });
      persist();
    },
    [persist],
  );

  const undo = useCallback(async (): Promise<RefinementUndoItem | null> => {
    if (stackRef.current.length === 0) return null;
    setState((prev) => ({ ...prev, isUndoing: true }));
    const last = stackRef.current[stackRef.current.length - 1];
    stackRef.current = stackRef.current.slice(0, -1);

    // Best-effort: if the matching offlineQueue row hasn't synced yet,
    // remove it so we never POST an edit we just rolled back.
    try {
      await offlineQueue.dequeue(last.id);
    } catch {
      /* already flushed — inverse POST is the server-side undo */
    }

    // Enqueue the inverse action (a new edit) so the server ends up
    // with the pre-edit state even if the original already synced.
    try {
      await offlineQueue.enqueue({
        analysis_id: last.analysisId,
        edit_type: last.editType,
        payload: last.inverse,
      });
    } catch {
      /* offlineQueue outage — the UI already reverted locally */
    }

    setState({ stack: stackRef.current, isUndoing: false });
    persist();
    return last;
  }, [persist]);

  const clear = useCallback(async (): Promise<void> => {
    stackRef.current = [];
    setState(INITIAL_STATE);
    try {
      window.localStorage.removeItem(UNDO_MIRROR_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<RefinementUndoContextValue>(
    () => ({ ...state, push, undo, clear }),
    [state, push, undo, clear],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRefinementUndo(): RefinementUndoContextValue {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error(
      'useRefinementUndo must be used inside <RefinementUndoProvider>',
    );
  }
  return ctx;
}

export default RefinementUndoProvider;
