// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Cornerstone3D Initialization Service (LiverRa)
// ============================================================================
// Initializes the Cornerstone3D rendering engine, registers viewer tools
// (window/level, zoom, pan, measurements, segmentation, etc.), configures the
// DICOM image loader, and wires up both mouse and touch bindings so the
// same viewer works on desktop (surgeon reading room) and tablet (ward round).
//
// Think of this as the "engine starter" — call initCornerstone() once at app
// startup before rendering any medical images.
//
// Ported from MediMind `services/pacs/cornerstoneInit.ts` and re-wired for
// LiverRa:
//   - Drops MediMind-specific `types/pacs` import
//   - Adds touch gesture bindings per plan §Mobile & touch strategy
//   - Registers the BrushTool + SegmentationDisplayTool (mask editing for
//     VISTA3D / MedSAM-2 refinement workflow)
// ============================================================================

import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import cornerstoneDICOMImageLoader, { init as initDICOMImageLoader } from '@cornerstonejs/dicom-image-loader';
import type { NiftiMask } from './niftiLoader';

// ============================================================================
// Types
// ============================================================================

/**
 * Subset of the LiverRa viewer tool name-space that maps 1:1 to a real
 * Cornerstone3D tool class. Custom/composite tools (resection plane,
 * threshold brush, etc.) are excluded because they are implemented with
 * custom logic rather than a single CS3D tool class.
 */
export type StandardLiverTool =
  // Navigation & display
  | 'WindowLevel'
  | 'Zoom'
  | 'Pan'
  | 'StackScroll'
  | 'Crosshairs'
  | 'ReferenceLines'
  | 'MagnifyTool'
  | 'PlanarRotate'
  | 'TrackballRotate'
  | 'OrientationMarker'
  | 'ScaleOverlay'
  // Measurement tools
  | 'Length'
  | 'Angle'
  | 'CobbAngle'
  | 'Bidirectional'
  | 'Probe'
  | 'DragProbe'
  // ROI tools
  | 'EllipticalROI'
  | 'RectangleROI'
  | 'CircleROI'
  | 'FreehandROI'
  | 'SplineROI'
  // Annotation tools
  | 'ArrowAnnotate';

/** Minimal shape of a Cornerstone3D annotation for type-safe property access */
interface CornerstoneAnnotation {
  metadata?: { toolName?: string };
  isVisible?: boolean;
  data?: {
    cachedStats?: Record<string, { length?: number }>;
  };
}

// ============================================================================
// Constants
// ============================================================================

/** Unique ID for the singleton RenderingEngine instance */
export const RENDERING_ENGINE_ID = 'liverra-pacs-engine';

// ---- HTJ2K Transfer Syntax UIDs ----
// HTJ2K (High-Throughput JPEG 2000) is a faster version of JPEG 2000 that
// supports progressive rendering — images appear blurry first and refine as
// data arrives, like how a photo loads progressively on a slow connection.

/** HTJ2K Lossless — full quality, no compression artifacts */
export const HTJ2K_LOSSLESS_UID = '1.2.840.10008.1.2.4.201';

/** HTJ2K Lossy (RPCL) — slightly compressed, supports progressive rendering */
export const HTJ2K_LOSSY_UID = '1.2.840.10008.1.2.4.202';

/** Explicit VR Little Endian — universal fallback that every PACS supports */
export const EXPLICIT_VR_LITTLE_ENDIAN_UID = '1.2.840.10008.1.2.1';

/**
 * HTJ2K streaming configuration.
 * Controls whether the viewer requests images in HTJ2K format for faster
 * initial display. Can be disabled at runtime if it causes issues.
 */
export interface HTJ2KConfig {
  enabled: boolean;
  preferLossless: boolean;
}

let htj2kConfig: HTJ2KConfig = {
  enabled: true,
  preferLossless: false,
};

/**
 * Window/Level presets — predefined contrast settings for different tissues.
 * LiverRa's default presets focus on hepatic imaging (abdomen, liver-soft
 * tissue window for contrast-enhanced CT, plus the universal bone/lung sets
 * kept so the viewer can display non-liver prior exams).
 */
export const WINDOW_LEVEL_PRESETS: Record<string, { center: number; width: number }> = {
  liver: { center: 90, width: 150 },
  abdomen: { center: 60, width: 400 },
  softTissue: { center: 40, width: 400 },
  lung: { center: -600, width: 1500 },
  bone: { center: 300, width: 1500 },
  brain: { center: 40, width: 80 },
};

/**
 * Maps our LiverRa tool names to the actual Cornerstone3D tool classes.
 * Used during initialization to register all tools at once.
 */
export const TOOL_MAP: Record<StandardLiverTool, typeof cornerstoneTools.BaseTool> = {
  // Navigation & display
  WindowLevel: cornerstoneTools.WindowLevelTool,
  Zoom: cornerstoneTools.ZoomTool,
  Pan: cornerstoneTools.PanTool,
  StackScroll: cornerstoneTools.StackScrollTool,
  Crosshairs: cornerstoneTools.CrosshairsTool,
  ReferenceLines: cornerstoneTools.ReferenceLinesTool,
  MagnifyTool: cornerstoneTools.MagnifyTool,
  PlanarRotate: cornerstoneTools.PlanarRotateTool,
  TrackballRotate: cornerstoneTools.TrackballRotateTool,
  OrientationMarker: cornerstoneTools.OrientationMarkerTool,
  ScaleOverlay: cornerstoneTools.ScaleOverlayTool,
  // Measurement tools
  Length: cornerstoneTools.LengthTool,
  Angle: cornerstoneTools.AngleTool,
  CobbAngle: cornerstoneTools.CobbAngleTool,
  Bidirectional: cornerstoneTools.BidirectionalTool,
  Probe: cornerstoneTools.ProbeTool,
  DragProbe: cornerstoneTools.DragProbeTool,
  // ROI tools
  EllipticalROI: cornerstoneTools.EllipticalROITool,
  RectangleROI: cornerstoneTools.RectangleROITool,
  CircleROI: cornerstoneTools.CircleROITool,
  FreehandROI: cornerstoneTools.PlanarFreehandROITool,
  SplineROI: cornerstoneTools.SplineROITool,
  // Annotation tools
  ArrowAnnotate: cornerstoneTools.ArrowAnnotateTool,
};

/**
 * Maps LiverRa tool names to CS3D internal tool names for mismatches.
 * Think of this as a "translation table" between our naming and CS3D's.
 */
const CS3D_NAME_MAP: Record<string, string> = {
  FreehandROI: 'PlanarFreehandROI',
  MagnifyTool: 'Magnify',
};

export function getCS3DToolName(appToolName: string): string {
  return CS3D_NAME_MAP[appToolName] ?? appToolName;
}

// ============================================================================
// State
// ============================================================================

let initialized = false;
let renderingEngine: cornerstone.RenderingEngine | null = null;

// ============================================================================
// ArrowAnnotate Text Input Callback
// ============================================================================
// Instead of using window.prompt(), we hook into a React component to show a
// polished text input. Works like a "callback mailbox": when CS3D wants text,
// we store the callback; the React component picks it up, prompts the user,
// and calls the callback with the result.

let pendingArrowTextCallback: ((text: string) => void) | null = null;
let arrowTextRequestListener: (() => void) | null = null;

export function onArrowAnnotateTextRequest(listener: () => void): () => void {
  arrowTextRequestListener = listener;
  return () => {
    arrowTextRequestListener = null;
  };
}

export function submitArrowAnnotateText(text: string): void {
  if (pendingArrowTextCallback) {
    pendingArrowTextCallback(text);
    pendingArrowTextCallback = null;
  }
}

export function cancelArrowAnnotateText(): void {
  submitArrowAnnotateText('');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize Cornerstone3D — must be called once before any viewer is rendered.
 *
 * 1. Initializes the Cornerstone3D core library (WebGL2 context)
 * 2. Configures the DICOM image loader
 * 3. Registers all viewer tools (measurement, annotation, navigation)
 * 4. Registers segmentation tools (BrushTool + SegmentationDisplayTool) so
 *    the VISTA3D/MedSAM-2 refinement UX can paint/erase masks
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initCornerstone(): Promise<void> {
  if (initialized) {
    return;
  }

  // Step 1: Initialize Cornerstone3D core (WebGL2 rendering pipeline)
  await cornerstone.init();

  // Step 2: Initialize the DICOM image loader (v4 API).
  // Registers web workers for decoding DICOM pixel data in background threads.
  // (The "Worker type already registered" warning that fires on HMR / Strict
  // Mode double-init is filtered by `utils/installConsoleFilters.ts`.)
  initDICOMImageLoader();

  // Step 2.5: Configure HTJ2K progressive streaming
  try {
    const savedConfig = localStorage.getItem('liverra-htj2k-config');
    if (savedConfig) {
      const parsed = JSON.parse(savedConfig) as Partial<HTJ2KConfig>;
      htj2kConfig = { ...htj2kConfig, ...parsed };
    }
  } catch {
    // Invalid or missing config — use defaults
  }

  // Step 2.6: Register the streaming volume loader for MPR / 3D volumes
  cornerstone.volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    cornerstone.cornerstoneStreamingImageVolumeLoader
  );

  // Step 3: Initialize the tools framework
  cornerstoneTools.init();

  // Step 4: Register all viewer tools
  for (const ToolClass of Object.values(TOOL_MAP)) {
    cornerstoneTools.addTool(ToolClass);
  }

  // Step 5: Register segmentation tools.
  // These are separate from TOOL_MAP because they use different activation
  // patterns. BrushTool handles painting, threshold painting (via strategies),
  // and erasing — the "Swiss Army knife" of mask editing. SegmentationDisplayTool
  // is the rendering-only overlay that draws existing masks on every viewport.
  cornerstoneTools.addTool(cornerstoneTools.BrushTool);
  try {
    // SegmentationDisplayTool is exported in @cornerstonejs/tools ≤ 1.x and
    // folded into the segmentation state in 2.x. Guarded so either version
    // builds without breaking.
    const maybeDisplay = (cornerstoneTools as unknown as {
      SegmentationDisplayTool?: typeof cornerstoneTools.BaseTool;
    }).SegmentationDisplayTool;
    if (maybeDisplay) {
      cornerstoneTools.addTool(maybeDisplay);
    }
  } catch {
    // Segmentation display tool not present in this CS3D release — viewer
    // still works; masks render via the segmentation state helpers directly.
  }

  initialized = true;
}

/**
 * Destroy Cornerstone3D state — call when the viewer surface is fully
 * unmounted (e.g., user signs out or navigates out of the analysis view).
 * Frees GPU buffers and cleans up the shared ToolGroup.
 */
export function destroyCornerstone(): void {
  try {
    cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
  } catch {
    // ToolGroup may not exist yet or already destroyed
  }
  toolGroup = undefined;

  if (renderingEngine && !renderingEngine.hasBeenDestroyed) {
    renderingEngine.destroy();
  }
  renderingEngine = null;
  initialized = false;
}

/** Backward-compatible alias — some older callers expect this name. */
export const destroyRenderingEngine = destroyCornerstone;

/**
 * Get the singleton RenderingEngine, creating it if needed.
 */
export function getOrCreateRenderingEngine(): cornerstone.RenderingEngine {
  if (!initialized) {
    throw new Error('Cornerstone3D not initialized. Call initCornerstone() first.');
  }

  if (!renderingEngine || renderingEngine.hasBeenDestroyed) {
    renderingEngine = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);
  }

  return renderingEngine;
}

/**
 * Check if the browser supports WebGL2, which Cornerstone3D requires.
 */
export function detectWebGL2Support(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const supported = gl !== null;
    if (gl) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return supported;
  } catch {
    return false;
  }
}

/**
 * Configure the DICOM image loader with auth headers so Cornerstone3D can
 * fetch pixel data from Orthanc (behind the Cognito-authenticated proxy).
 * Call after login and whenever the JWT refreshes.
 *
 * @param getToken - Callback returning the current Cognito JWT access token
 */
export function configureDicomAuth(getToken: () => string | null): void {
  const { setOptions } = cornerstoneDICOMImageLoader.internal;
  setOptions({
    beforeSend: (xhr: XMLHttpRequest) => {
      const token = getToken();
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }
    },
  });
}

export function isCornerstoneInitialized(): boolean {
  return initialized;
}

// ============================================================================
// HTJ2K Progressive Streaming
// ============================================================================

export function configureHTJ2K(config: Partial<HTJ2KConfig>): void {
  htj2kConfig = { ...htj2kConfig, ...config };
}

export function getHTJ2KConfig(): Readonly<HTJ2KConfig> {
  return { ...htj2kConfig };
}

export function getPreferredTransferSyntaxes(): string[] {
  if (!htj2kConfig.enabled) {
    return [EXPLICIT_VR_LITTLE_ENDIAN_UID];
  }

  const primary = htj2kConfig.preferLossless ? HTJ2K_LOSSLESS_UID : HTJ2K_LOSSY_UID;
  const secondary = htj2kConfig.preferLossless ? HTJ2K_LOSSY_UID : HTJ2K_LOSSLESS_UID;

  return [primary, secondary, EXPLICIT_VR_LITTLE_ENDIAN_UID];
}

export function isHTJ2KTransferSyntax(uid: string): boolean {
  return uid === HTJ2K_LOSSLESS_UID || uid === HTJ2K_LOSSY_UID;
}

// ============================================================================
// ToolGroup Management — Mouse & Touch Bindings
// ============================================================================
// The ToolGroup is the object that maps an input (mouse button, touch
// gesture) to a tool, for every viewport in the rendering engine. On desktop
// the user drives the tools via mouse buttons; on tablet (ward round) they
// drive the same tools via touch gestures.
//
// Gesture mapping (plan §Mobile & touch strategy):
//   - PinchGesture            → Zoom
//   - TwoFingerRotateGesture  → TrackballRotate (3D view)
//   - DragGesture (1-finger)  → Pan
//   - DragGesture (2-finger)  → WindowLevel (vertical drag)
//   - DragGesture (freehand)  → PlanarFreehandROI (resection plane sketch)
//   - TapGesture              → Probe (lesion select)
// ============================================================================

const TOOL_GROUP_ID = 'liverra-pacs-toolgroup';

let toolGroup: ReturnType<typeof cornerstoneTools.ToolGroupManager.getToolGroup> = undefined;

/**
 * Safely resolve a CS3D touch binding enum by name. Cornerstone3D 2.x ships
 * `Enums.Touch` ({ numTouchPoints: 1 | 2 | 3 }); older releases exposed a
 * different shape. We look up the enum defensively so the module loads even
 * if a constant is missing at runtime.
 */
function touchBinding(numTouchPoints: 1 | 2 | 3): { numTouchPoints: 1 | 2 | 3 } {
  return { numTouchPoints };
}

/**
 * Get or create the shared ToolGroup — maps input events to tools for all
 * viewports. All tools start in Passive state (show existing annotations,
 * don't respond to input). `activateToolOnGroup(toolName)` switches one to
 * Active (responds to the default mouse + touch bindings).
 */
export function getOrCreateToolGroup(): cornerstoneTools.Types.IToolGroup {
  const existing = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
  if (existing) {
    toolGroup = existing;
    return existing;
  }

  const group = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  if (!group) {
    throw new Error('Failed to create ToolGroup');
  }

  // Add all tools to the group (Passive by default — annotations visible but
  // not interactive). Use CS3D tool names (some differ, e.g.
  // FreehandROI → PlanarFreehandROI).
  for (const appName of Object.keys(TOOL_MAP)) {
    // Crosshairs + ReferenceLines require ≥2 synced viewports (MPR layouts).
    // The shared tool group backs the single-viewport stack viewer, where
    // CS3D's Crosshairs.mouseMoveCallback crashes reading `.length` of
    // undefined on every mousemove. MPR viewers must create their own
    // tool group and opt these in.
    if (appName === 'Crosshairs' || appName === 'ReferenceLines') continue;

    const cs3dName = getCS3DToolName(appName);

    if (appName === 'ArrowAnnotate') {
      group.addTool(cs3dName, {
        getTextCallback: (doneChangingTextCallback: (text: string) => void) => {
          pendingArrowTextCallback = doneChangingTextCallback;
          arrowTextRequestListener?.();
        },
        changeTextCallback: (
          _annotation: unknown,
          _eventData: unknown,
          doneChangingTextCallback: (text: string) => void
        ) => {
          pendingArrowTextCallback = doneChangingTextCallback;
          arrowTextRequestListener?.();
        },
      });
    } else {
      group.addTool(cs3dName);
    }
  }

  // Segmentation tools (registered separately; not in TOOL_MAP).
  try {
    group.addTool('Brush');
  } catch {
    // May not be registered (unit tests, trimmed CS3D builds)
  }
  try {
    group.addTool('SegmentationDisplay');
    group.setToolEnabled('SegmentationDisplay');
  } catch {
    // CS3D 2.x folds this into the segmentation state helper; not fatal.
    // The console.warn that Cornerstone itself prints is filtered by
    // utils/installConsoleFilters.ts so it doesn't pollute the dev console.
  }

  // ---- Default mouse bindings ----
  // Left mouse = StackScroll (scroll through slices) — surgeons expect this
  // as the "neutral" cursor state in a DICOM viewer.
  group.setToolActive('StackScroll', {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });

  // ---- Default touch bindings (plan §Mobile & touch strategy) ----
  // These bindings coexist with mouse bindings: a tool can be bound to BOTH
  // a mouseButton and a numTouchPoints tuple simultaneously. We pin
  // Zoom/Pan/WindowLevel to their canonical gestures here so the gestures
  // always work regardless of which "active tool" the user has selected.
  try {
    // Pinch = Zoom (two-finger pinch in/out)
    group.setToolActive('Zoom', {
      bindings: [touchBinding(2)],
    });
  } catch {
    // Tool may not be available or already bound
  }
  try {
    // Single-finger drag = Pan (slide the image around)
    group.setToolActive('Pan', {
      bindings: [touchBinding(1)],
    });
  } catch {
    // Tool may not be available or already bound
  }
  try {
    // 3-finger drag = WindowLevel (adjust contrast by vertical drag).
    // Using 3 touch points avoids colliding with the 2-finger pinch binding.
    group.setToolActive('WindowLevel', {
      bindings: [touchBinding(3)],
    });
  } catch {
    // Tool may not be available or already bound
  }
  try {
    // Two-finger rotate = TrackballRotate (3D volume view)
    // CS3D activates rotate gestures on TrackballRotate via touch points 2.
    // Pan+Zoom already occupy 1/2-point bindings on other tools, so we
    // bind rotate to the 3D viewports only via activateToolOnGroup() when
    // a 3D viewport is registered. Here we register it as Passive so
    // annotations/tool state persist.
    group.setToolPassive('TrackballRotate');
  } catch {
    // Tool may not be registered
  }

  // Always-on overlays
  try {
    group.setToolEnabled('OrientationMarker');
  } catch {
    // Not available on all platforms
  }
  try {
    group.setToolEnabled('ScaleOverlay');
  } catch {
    // Not available on all platforms
  }

  toolGroup = group;
  return group;
}

/**
 * Switch the active tool — deactivates the current primary tool and
 * activates the new one on left mouse button + 1-finger touch (tap/drag).
 *
 * Zoom/Pan/WindowLevel keep their pinch/1-finger/3-finger touch bindings
 * configured in getOrCreateToolGroup() regardless of which tool is "primary",
 * so a surgeon can pinch-zoom or 3-finger WL while drawing a Length line.
 *
 * @param toolName - Tool to activate (e.g., 'Zoom', 'Length', 'FreehandROI')
 */
export function activateToolOnGroup(toolName: string): void {
  const group = getOrCreateToolGroup();
  const cs3dName = getCS3DToolName(toolName);

  // Tools that keep their bindings regardless of primary-tool selection
  const ALWAYS_ON_TOOLS = new Set([
    'OrientationMarker',
    'ScaleOverlay',
    'SegmentationDisplay',
  ]);
  // Tools whose touch bindings must persist (pinch-zoom always available, etc.)
  const STICKY_TOUCH_TOOLS = new Set(['Zoom', 'Pan', 'WindowLevel']);

  // Deactivate every non-overlay tool (set to Passive). For sticky-touch
  // tools we re-bind the touch gesture after this pass so the gesture
  // survives a tool switch.
  for (const appName of Object.keys(TOOL_MAP)) {
    if (ALWAYS_ON_TOOLS.has(appName)) {
      continue;
    }
    try {
      group.setToolPassive(getCS3DToolName(appName));
    } catch {
      // Tool may not be in this state
    }
  }

  try {
    group.setToolPassive('Brush');
  } catch {
    // May not be registered
  }

  // Activate the requested tool on left mouse button + 1-finger tap/drag.
  // Probe → TapGesture and FreehandROI → DragGesture are satisfied by the
  // same 1-touch-point binding CS3D uses for both.
  try {
    group.setToolActive(cs3dName, {
      bindings: [
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary },
        touchBinding(1),
      ],
    });
  } catch {
    // Fallback: WindowLevel is the "safe" default state
    try {
      group.setToolActive('WindowLevel', {
        bindings: [
          { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary },
          touchBinding(3),
        ],
      });
    } catch {
      // ToolGroup broken — nothing to do
    }
  }

  // Re-assert sticky touch bindings for Zoom (pinch) + Pan (1-finger-when-
  // primary-is-other) + WindowLevel (3-finger). Zoom's pinch gesture uses
  // 2 touch points, so it never collides with the 1-touch primary tool.
  if (!STICKY_TOUCH_TOOLS.has(toolName)) {
    try {
      group.setToolActive('Zoom', { bindings: [touchBinding(2)] });
    } catch {
      // Tool may not be available
    }
    try {
      group.setToolActive('WindowLevel', { bindings: [touchBinding(3)] });
    } catch {
      // Tool may not be available
    }
  }
}

/**
 * Enable TrackballRotate with a two-finger rotate gesture on a given 3D
 * viewport (call after the 3D viewport is created and added to the group).
 *
 * Kept separate from the default gesture bindings because TrackballRotate
 * only makes sense on volume viewports — applying it to 2D axial/coronal/
 * sagittal viewports produces jarring "free rotation" that confuses users.
 */
export function enable3DRotateGesture(): void {
  const group = getOrCreateToolGroup();
  try {
    group.setToolActive('TrackballRotate', {
      bindings: [touchBinding(2)],
    });
  } catch {
    // TrackballRotate may not be registered in this build
  }
}

// ============================================================================
// Per-Annotation Visibility & Locking
// ============================================================================

export function toggleAnnotationVisibility(annotationUID: string): boolean | null {
  try {
    const ann = cornerstoneTools.annotation.state.getAnnotation(annotationUID);
    if (!ann) {
      return null;
    }
    ann.isVisible = ann.isVisible === false ? true : false;

    renderingEngine?.renderViewports(
      renderingEngine.getViewports().map((vp) => vp.id)
    );

    return ann.isVisible;
  } catch {
    return null;
  }
}

export function toggleAnnotationLock(annotationUID: string): boolean | null {
  try {
    const ann = cornerstoneTools.annotation.state.getAnnotation(annotationUID);
    if (!ann) {
      return null;
    }
    ann.isLocked = !ann.isLocked;

    renderingEngine?.renderViewports(
      renderingEngine.getViewports().map((vp) => vp.id)
    );

    return ann.isLocked;
  } catch {
    return null;
  }
}

// ============================================================================
// Cancel In-Progress Annotations
// ============================================================================

export function cancelActiveAnnotation(): boolean {
  try {
    if (!renderingEngine || renderingEngine.hasBeenDestroyed) {
      return false;
    }

    const viewports = renderingEngine.getViewports();
    if (viewports.length === 0) {
      return false;
    }

    for (const viewport of viewports) {
      const element = viewport.element;
      if (element) {
        cornerstoneTools.cancelActiveManipulations(element);
      }
    }

    renderingEngine.renderViewports(viewports.map((vp) => vp.id));
    return true;
  } catch {
    return false;
  }
}

export function getLatestLengthAnnotationPixels(): number | null {
  try {
    const allAnnotations = cornerstoneTools.annotation.state.getAllAnnotations?.() ?? [];
    const lengthAnnotations = allAnnotations.filter((a: unknown) => {
      const ann = a as CornerstoneAnnotation;
      return ann.metadata?.toolName === 'Length' && ann.isVisible !== false;
    });
    if (lengthAnnotations.length === 0) {
      return null;
    }
    const latest = lengthAnnotations[lengthAnnotations.length - 1] as CornerstoneAnnotation;
    const cachedStats = latest.data?.cachedStats;
    if (cachedStats) {
      const statsValues = Object.values(cachedStats);
      for (const stats of statsValues) {
        if (typeof stats?.length === 'number' && stats.length > 0) {
          return stats.length;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function getRecentLengthAnnotationPixels(count: number): number[] {
  try {
    const allAnnotations = cornerstoneTools.annotation.state.getAllAnnotations?.() ?? [];
    const lengthAnnotations = allAnnotations.filter((a: unknown) => {
      const ann = a as CornerstoneAnnotation;
      return ann.metadata?.toolName === 'Length' && ann.isVisible !== false;
    });
    if (lengthAnnotations.length === 0) {
      return [];
    }
    const recent = lengthAnnotations.slice(-count);
    const results: number[] = [];
    for (const ann of recent) {
      const typed = ann as CornerstoneAnnotation;
      const cachedStats = typed.data?.cachedStats;
      if (cachedStats) {
        const statsValues = Object.values(cachedStats);
        for (const stats of statsValues) {
          if (typeof stats?.length === 'number' && stats.length > 0) {
            results.push(stats.length);
            break;
          }
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ============================================================================
// Annotation Deletion & Restoration
// ============================================================================

export function removeSelectedAnnotation(): string | null {
  try {
    const selectedUIDs = cornerstoneTools.annotation.selection.getAnnotationsSelected() ?? [];
    if (selectedUIDs.length === 0) {
      return null;
    }

    const uid = selectedUIDs[0];
    cornerstoneTools.annotation.state.removeAnnotation(uid);

    if (renderingEngine && !renderingEngine.hasBeenDestroyed) {
      renderingEngine.renderViewports(
        renderingEngine.getViewports().map((vp) => vp.id)
      );
    }

    return uid;
  } catch {
    return null;
  }
}

export function removeAllAnnotations(): number {
  try {
    const allAnnotations = cornerstoneTools.annotation.state.getAllAnnotations?.() ?? [];
    const count = allAnnotations.length;

    for (const ann of allAnnotations) {
      const typed = ann as { annotationUID?: string };
      if (typed.annotationUID) {
        cornerstoneTools.annotation.state.removeAnnotation(typed.annotationUID);
      }
    }

    if (renderingEngine && !renderingEngine.hasBeenDestroyed) {
      renderingEngine.renderViewports(
        renderingEngine.getViewports().map((vp) => vp.id)
      );
    }

    return count;
  } catch {
    return 0;
  }
}

export function restoreAnnotationsFromJson(json: string): void {
  try {
    const existing = cornerstoneTools.annotation.state.getAllAnnotations?.() ?? [];
    for (const ann of existing) {
      const typed = ann as { annotationUID?: string };
      if (typed.annotationUID) {
        cornerstoneTools.annotation.state.removeAnnotation(typed.annotationUID);
      }
    }

    if (json) {
      const parsed = JSON.parse(json);
      const annotations = Array.isArray(parsed) ? parsed : [];
      for (const ann of annotations) {
        if (ann && typeof ann === 'object') {
          cornerstoneTools.annotation.state.addAnnotation(ann);
        }
      }
    }

    if (renderingEngine && !renderingEngine.hasBeenDestroyed) {
      renderingEngine.renderViewports(
        renderingEngine.getViewports().map((vp) => vp.id)
      );
    }
  } catch {
    // Failed to restore — viewport may show stale data until next render
  }
}

export function getCurrentAnnotationsJson(): string {
  try {
    const allAnnotations = cornerstoneTools.annotation.state.getAllAnnotations?.() ?? [];
    return JSON.stringify(allAnnotations);
  } catch {
    return '[]';
  }
}

// ============================================================================
// Pass D5 — Segmentation labelmap helpers (MPR overlay)
// ============================================================================
//
// Plain-English: a "labelmap" is a 3-D mask volume that lives next to the CT
// volume in Cornerstone's cache and shares its coordinate system. When you
// attach the labelmap to a viewport, Cornerstone automatically paints it on
// every plane (axial / sagittal / coronal) and updates as you scroll — no
// per-slice canvas blitting required. This is how MPR mode renders the
// parenchyma overlay across all 3 planes.
//
// Why we resample 128³ → 512×512×674 in JS instead of asking the server to
// ship a full-resolution mask: the cascade pipeline writes 128³ binary masks
// (~2 MB) for bandwidth + S3 storage reasons. Cornerstone's derived volume
// inherits the reference CT grid, so we have to copy our small mask into
// that bigger grid via nearest-neighbor before it can render. The whole
// pipeline runs once per analysis on the client (≈80 ms for 128³ → 512×512×674
// on M1) so this is acceptable.
//
// Coordinate-system caveat: this assumes both volumes cover the same
// physical extent with identical axis alignment. The cascade generates the
// mask by resampling onto the CT's own grid in SimpleITK (LPS, axial top-down)
// then downsamples to 128³ — so the two grids ARE aligned by construction.
// If a future cascade ever ships a mask with a different orientation, the
// fix is to consult `nifti.header` (sform/qform) and transpose accordingly.
// ============================================================================

/**
 * Build a Cornerstone3D labelmap segmentation volume from a NIfTI mask,
 * derived from a reference CT volume so it inherits the CT's grid + spacing.
 *
 * Plain-English: "transcribe the AI's binary mask into a coordinate system
 * that Cornerstone can paint across axial / sagittal / coronal slices."
 *
 * @param referenceVolumeId  ID of the already-cached CT volume
 * @param nifti              Parsed NIfTI mask (typically 128³ uint8)
 * @param segmentationId     Stable ID for this labelmap (also used as volumeId)
 */
export async function createLabelmapFromNifti(
  referenceVolumeId: string,
  nifti: NiftiMask,
  segmentationId: string,
): Promise<void> {
  // CS3D 4.x exposes createAndCacheDerivedLabelmapVolume (sync, returns an
  // IImageVolume). It picks up dims/spacing/origin/direction from the
  // reference CT and pre-allocates a Uint8Array scalar buffer of the right
  // size. We then write the mask voxels into it.
  const segVol = (cornerstone.volumeLoader as unknown as {
    createAndCacheDerivedLabelmapVolume: (
      refId: string,
      opts: { volumeId: string },
    ) => cornerstone.Types.IImageVolume;
  }).createAndCacheDerivedLabelmapVolume(referenceVolumeId, {
    volumeId: segmentationId,
  });

  // CS3D 4.15 derived volumes are ready immediately (no async load needed),
  // but we guard anyway so a future API change is non-fatal.
  const maybeLoad = (segVol as unknown as { load?: () => Promise<void> }).load;
  if (typeof maybeLoad === 'function') {
    try {
      await maybeLoad.call(segVol);
    } catch {
      /* not fatal — derived labelmaps don't need a remote load */
    }
  }

  const voxelManager = (segVol as unknown as {
    voxelManager?: {
      dimensions?: [number, number, number];
      getCompleteScalarDataArray?: () => ArrayLike<number>;
      setCompleteScalarDataArray?: (data: ArrayLike<number>) => void;
    };
  }).voxelManager;

  const refDims =
    voxelManager?.dimensions ??
    ((segVol as unknown as { dimensions?: [number, number, number] }).dimensions ?? [0, 0, 0]);
  const [refX, refY, refZ] = refDims;
  const [niX, niY, niZ] = nifti.dims;
  if (refX <= 0 || refY <= 0 || refZ <= 0 || niX <= 0 || niY <= 0 || niZ <= 0) {
    throw new Error(
      `[cornerstoneInit] createLabelmapFromNifti: invalid dims ref=${refDims.join('×')} nifti=${nifti.dims.join('×')}`,
    );
  }

  // Acquire the writable scalar buffer. CS3D 4.x usually returns a
  // typed array directly; we treat it as a Uint8Array because that's what
  // createAndCacheDerivedLabelmapVolume allocates (Uint8Array targetBuffer).
  const rawScalar = voxelManager?.getCompleteScalarDataArray?.();
  if (!rawScalar) {
    throw new Error(
      '[cornerstoneInit] createLabelmapFromNifti: voxelManager has no getCompleteScalarDataArray()',
    );
  }
  const scalar = rawScalar as Uint8Array;

  // Nearest-neighbor resample: for each destination voxel (x,y,z) in the
  // reference grid, look up the closest source voxel in the NIfTI grid.
  // Two-level loop hoisting (precompute z + y indices into the NIfTI buffer)
  // keeps this fast — ~80 ms for 128³ → 512×512×674 on an M1 in dev.
  for (let z = 0; z < refZ; z++) {
    const niz = Math.min(niZ - 1, Math.floor((z / refZ) * niZ));
    const niSliceBase = niz * niX * niY;
    const refSliceBase = z * refX * refY;
    for (let y = 0; y < refY; y++) {
      const niy = Math.min(niY - 1, Math.floor((y / refY) * niY));
      const niRowBase = niSliceBase + niy * niX;
      const refRowBase = refSliceBase + y * refX;
      for (let x = 0; x < refX; x++) {
        const nix = Math.min(niX - 1, Math.floor((x / refX) * niX));
        scalar[refRowBase + x] = nifti.voxels[niRowBase + nix];
      }
    }
  }

  // Persist back if API requires explicit write. In CS3D 4.x the array
  // returned by getCompleteScalarDataArray is the same backing buffer, so
  // mutations are usually live — but calling setCompleteScalarDataArray is
  // the safe API contract.
  if (typeof voxelManager?.setCompleteScalarDataArray === 'function') {
    voxelManager.setCompleteScalarDataArray(scalar);
  }

  // Some CS versions need an explicit "modified" trigger so the renderer
  // re-uploads the labelmap texture. Best-effort.
  const maybeModified = (segVol as unknown as { modified?: () => void }).modified;
  if (typeof maybeModified === 'function') {
    try {
      maybeModified.call(segVol);
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Register a labelmap with Cornerstone's segmentation state and attach it
 * to one or more viewports. After this returns, scrolling any of those
 * viewports will paint the labelmap on every plane automatically.
 *
 * Idempotent: re-calling for the same segmentationId is a no-op for the
 * registration step but re-attaches representations to viewports (safe).
 */
export async function attachLabelmapToViewports(
  segmentationId: string,
  viewportIds: string[],
  color: [number, number, number, number] = [86, 199, 119, 100],
): Promise<void> {
  const segNs = cornerstoneTools.segmentation;
  const repType = cornerstoneTools.Enums.SegmentationRepresentations.Labelmap;

  // addSegmentations: register the labelmap with the segmentation state.
  // Skip if already present so re-renders don't throw.
  let existing: unknown;
  try {
    existing = (segNs as unknown as {
      state: { getSegmentation: (id: string) => unknown };
    }).state.getSegmentation(segmentationId);
  } catch {
    existing = null;
  }
  if (!existing) {
    (segNs as unknown as {
      addSegmentations: (
        input: Array<{
          segmentationId: string;
          representation: { type: string; data: { volumeId: string } };
        }>,
      ) => void;
    }).addSegmentations([
      {
        segmentationId,
        representation: {
          type: repType,
          data: { volumeId: segmentationId },
        },
      },
    ]);
  }

  // Attach the labelmap representation to each viewport. CS3D 4.x's
  // addSegmentationRepresentations is sync (returns void) but we await
  // any potential Promise it may return in future versions.
  for (const vpId of viewportIds) {
    try {
      const result = (segNs as unknown as {
        addSegmentationRepresentations: (
          viewportId: string,
          repInput: Array<{ segmentationId: string; type: string }>,
        ) => void | Promise<void>;
      }).addSegmentationRepresentations(vpId, [
        { segmentationId, type: repType },
      ]);
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result;
      }
    } catch (e) {
      console.warn('[cornerstoneInit] addSegmentationRepresentations failed', vpId, e);
    }

    // Set per-segment colour (segment index 1 = the only non-zero label
    // in a binary parenchyma mask). RGBA 0-255.
    try {
      const colorApi = (segNs as unknown as {
        config?: {
          color?: {
            setSegmentIndexColor?: (
              viewportId: string,
              segmentationId: string,
              segmentIndex: number,
              color: [number, number, number, number],
            ) => void;
          };
        };
      }).config?.color;
      colorApi?.setSegmentIndexColor?.(vpId, segmentationId, 1, color);
    } catch {
      /* color API may differ across CS releases — non-fatal */
    }
  }
}

/**
 * Toggle visibility of a previously-attached labelmap segmentation in a
 * specific viewport. Non-throwing — logs warnings only, so rapid toggle
 * never blanks the viewer.
 */
export function setLabelmapVisibility(
  viewportId: string,
  segmentationId: string,
  visible: boolean,
): void {
  try {
    const repType = cornerstoneTools.Enums.SegmentationRepresentations.Labelmap;
    const visibilityApi = (cornerstoneTools.segmentation as unknown as {
      config?: {
        visibility?: {
          setSegmentationRepresentationVisibility?: (
            viewportId: string,
            specifier: { segmentationId: string; type?: unknown },
            visibility: boolean,
          ) => void;
        };
      };
    }).config?.visibility;
    visibilityApi?.setSegmentationRepresentationVisibility?.(
      viewportId,
      { segmentationId, type: repType },
      visible,
    );
  } catch (e) {
    console.warn('[cornerstoneInit] setLabelmapVisibility failed', e);
  }
}

/**
 * Remove a labelmap segmentation from the segmentation state entirely.
 * Used when the analysis ID changes so we don't leak labelmaps across
 * cases. Best-effort; failures are logged not thrown.
 */
export function removeLabelmapSegmentation(segmentationId: string): void {
  try {
    const segNs = cornerstoneTools.segmentation as unknown as {
      removeSegmentation?: (id: string) => void;
    };
    segNs.removeSegmentation?.(segmentationId);
  } catch (e) {
    console.warn('[cornerstoneInit] removeLabelmapSegmentation failed', e);
  }
  try {
    cornerstone.cache.removeVolumeLoadObject(segmentationId);
  } catch {
    /* not in cache — fine */
  }
}

/**
 * Reset the initialization state. Only used in tests.
 * @internal
 */
export function _resetForTesting(): void {
  destroyCornerstone();
  htj2kConfig = { enabled: true, preferLossless: false };
}
