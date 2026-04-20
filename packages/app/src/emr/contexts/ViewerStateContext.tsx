// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ViewerStateContext (T181).
 *
 * Plain-English: every time the user pans, zooms, flips on the vessel
 * layer, or drops a resection plane, that state has to be shared across
 * several panels at once — the 3D viewer, the slice viewer, the layer
 * toolbar, the FLR calculator. This context is the single dashboard they
 * all read from.
 *
 * It also remembers the pose between reloads: camera + tool mode are
 * persisted to `localStorage` under `liverra.viewer.{analysisId}`, so when
 * the surgeon refreshes the page the view comes back exactly where they
 * left it. Think "save the crime-scene markers on the whiteboard".
 *
 * Spec refs: plan.md §Contexts graph, §UI Conventions.
 */

import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ViewerLayer = 'parenchyma' | 'segments' | 'vessels' | 'lesions';
export type ViewerToolMode =
  | 'pan'
  | 'zoom'
  | 'wl'
  | 'plane'
  | 'measure'
  | 'probe'
  | 'segment-edit';

export interface ViewerCamera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  zoom: number;
}

export interface ViewerPlanePose {
  /** Plane normal in world space — right-hand rule. */
  normal: [number, number, number];
  /** Signed distance from origin along the normal. */
  offset: number;
}

export interface ViewerStateContextValue {
  camera: ViewerCamera;
  activeLayers: Set<ViewerLayer>;
  planePose: ViewerPlanePose | null;
  toolMode: ViewerToolMode;
  setCamera: (camera: ViewerCamera) => void;
  toggleLayer: (layer: ViewerLayer) => void;
  setLayerVisible: (layer: ViewerLayer, visible: boolean) => void;
  setPlanePose: (pose: ViewerPlanePose | null) => void;
  setToolMode: (mode: ViewerToolMode) => void;
}

const ViewerStateContext = createContext<ViewerStateContextValue | null>(null);

// ---------------------------------------------------------------------------
// Defaults + persistence
// ---------------------------------------------------------------------------

const DEFAULT_CAMERA: ViewerCamera = {
  position: [0, 0, 500],
  target: [0, 0, 0],
  up: [0, -1, 0],
  zoom: 1,
};

const DEFAULT_LAYERS: ViewerLayer[] = ['parenchyma'];
const DEFAULT_TOOL: ViewerToolMode = 'pan';

interface PersistedShape {
  camera?: ViewerCamera;
  activeLayers?: ViewerLayer[];
  toolMode?: ViewerToolMode;
}

function storageKey(analysisId: string): string {
  return `liverra.viewer.${analysisId}`;
}

function loadPersisted(analysisId: string): PersistedShape | null {
  try {
    const raw = window.localStorage.getItem(storageKey(analysisId));
    if (!raw) return null;
    return JSON.parse(raw) as PersistedShape;
  } catch {
    return null;
  }
}

function savePersisted(analysisId: string, data: PersistedShape): void {
  try {
    window.localStorage.setItem(storageKey(analysisId), JSON.stringify(data));
  } catch {
    // Quota / privacy mode — persistence is best-effort, not critical.
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ViewerStateProviderProps {
  analysisId: string;
  children: ReactNode;
  /**
   * When `false`, skip localStorage read + write. Useful for anonymous /
   * kiosk sessions and tests.
   */
  persist?: boolean;
}

export function ViewerStateProvider({
  analysisId,
  children,
  persist = true,
}: ViewerStateProviderProps): JSX.Element {
  // Hydrate synchronously so the first paint already reflects persisted
  // state — prevents a camera "snap" on reload.
  const initial = useRef(persist ? loadPersisted(analysisId) : null).current;

  const [camera, setCameraState] = useState<ViewerCamera>(initial?.camera ?? DEFAULT_CAMERA);
  const [activeLayers, setActiveLayers] = useState<Set<ViewerLayer>>(
    new Set(initial?.activeLayers ?? DEFAULT_LAYERS),
  );
  const [planePose, setPlanePose] = useState<ViewerPlanePose | null>(null);
  const [toolMode, setToolModeState] = useState<ViewerToolMode>(initial?.toolMode ?? DEFAULT_TOOL);

  // Debounce persistence: every setter writes through, but localStorage
  // writes are batched via microtask to avoid hammering on scrub gestures.
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFlush = useCallback(
    (next: PersistedShape) => {
      if (!persist) return;
      if (flushRef.current) clearTimeout(flushRef.current);
      flushRef.current = setTimeout(() => savePersisted(analysisId, next), 150);
    },
    [analysisId, persist],
  );

  const setCamera = useCallback(
    (next: ViewerCamera) => {
      setCameraState(next);
      scheduleFlush({ camera: next, activeLayers: Array.from(activeLayers), toolMode });
    },
    [activeLayers, toolMode, scheduleFlush],
  );

  const toggleLayer = useCallback(
    (layer: ViewerLayer) => {
      setActiveLayers((prev) => {
        const next = new Set(prev);
        if (next.has(layer)) next.delete(layer);
        else next.add(layer);
        scheduleFlush({ camera, activeLayers: Array.from(next), toolMode });
        return next;
      });
    },
    [camera, toolMode, scheduleFlush],
  );

  const setLayerVisible = useCallback(
    (layer: ViewerLayer, visible: boolean) => {
      setActiveLayers((prev) => {
        const next = new Set(prev);
        if (visible) next.add(layer);
        else next.delete(layer);
        scheduleFlush({ camera, activeLayers: Array.from(next), toolMode });
        return next;
      });
    },
    [camera, toolMode, scheduleFlush],
  );

  const setToolMode = useCallback(
    (mode: ViewerToolMode) => {
      setToolModeState(mode);
      scheduleFlush({ camera, activeLayers: Array.from(activeLayers), toolMode: mode });
    },
    [camera, activeLayers, scheduleFlush],
  );

  // Flush on unmount so the last state is persisted even if the user
  // navigates away before the debounced timer fires.
  useEffect(() => {
    return () => {
      if (!persist) return;
      if (flushRef.current) clearTimeout(flushRef.current);
      savePersisted(analysisId, {
        camera,
        activeLayers: Array.from(activeLayers),
        toolMode,
      });
    };
    // Intentionally capture the latest snapshot on unmount only.
  }, [analysisId]);

  const value = useMemo<ViewerStateContextValue>(
    () => ({
      camera,
      activeLayers,
      planePose,
      toolMode,
      setCamera,
      toggleLayer,
      setLayerVisible,
      setPlanePose,
      setToolMode,
    }),
    [
      camera,
      activeLayers,
      planePose,
      toolMode,
      setCamera,
      toggleLayer,
      setLayerVisible,
      setToolMode,
    ],
  );

  return <ViewerStateContext.Provider value={value}>{children}</ViewerStateContext.Provider>;
}

/** Consumer hook. Throws if used outside the provider. */
export function useViewerState(): ViewerStateContextValue {
  const ctx = useContext(ViewerStateContext);
  if (!ctx) {
    throw new Error('useViewerState must be used inside <ViewerStateProvider>');
  }
  return ctx;
}

export { ViewerStateContext };
