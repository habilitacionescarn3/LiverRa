// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Cornerstone3D Initialization Service (LiverRa)
// ============================================================================
// Initializes the Cornerstone3D rendering engine, registers viewer tools
// (window/level, zoom, pan, measurements, etc.), and configures the DICOM
// image loader. Think of this as the "engine starter" — call initCornerstone()
// once at app startup before rendering any medical images.
//
// MERGE PROVENANCE (2026-06-05 advanced-viewer port): this file is MediMind's
// cornerstoneInit.ts (2535 lines, the version the ported PACSViewer.tsx was
// built against) RE-MERGED with LiverRa's pre-existing fork. LiverRa deltas
// preserved on top of the MediMind base — DO NOT remove any of these when
// uplifting from upstream again:
//   1. RENDERING_ENGINE_ID / TOOL_GROUP_ID / VR_TOOL_GROUP_ID keep the
//      'liverra-*' id strings (ComparisonView + LiverViewer3D reference them).
//   2. Engine refcount lifecycle (acquireCornerstoneRef / guarded
//      destroyCornerstone / destroyRenderingEngine alias) — H-PACS-1.
//   3. NIfTI labelmap suite (createLabelmapFromNifti / attachLabelmapToViewports
//      / setLabelmapVisibility / removeLabelmapSegmentation + affine helpers)
//      — renders the case viewer's lesion/Couinaud/parenchyma overlays.
//   4. Touch gesture bindings (pinch-zoom / 3-finger W/L / TrackballRotate)
//      — plan §Mobile & touch strategy.
//   5. configureDicomAuth keeps the nullable token getter AND only enters the
//      token-wait poll loop after a token has been seen once (LiverViewer3D
//      passes a deliberate no-auth getter; polling would stall every frame 3s).
//   6. cornerstone.init() stays UNFLAGGED — MediMind passes
//      { rendering: { preferSizeOverAccuracy: true } }, which trades WebGL
//      texture precision for VRAM. The case viewer's lesion-contour rendering
//      is validated against full precision, so the flag is dropped pending a
//      clinical-rendering review.
//   7. SegmentationDisplayTool guarded registration (mask-overlay rendering).
// ============================================================================

import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import cornerstoneDICOMImageLoader, { init as initDICOMImageLoader } from '@cornerstonejs/dicom-image-loader';

import { silentLog } from '../../utils/silentLog';
import { registerTaviTools } from './taviIntegration';
import { getToolGroupViewportIds } from './cornerstoneCompat';
import type { NiftiMask } from './niftiLoader';

// ============================================================================
// Types
// ============================================================================

/**
 * Subset of PACSViewerTool that maps 1:1 to a real Cornerstone3D tool class.
 * Custom/composite tools (Calibrate, Stenosis, Brush, Threshold, Eraser, DSA,
 * Polyline) are excluded because they are implemented with custom logic rather
 * than a single CS3D tool class.
 */
export type StandardPACSTool =
  // Navigation & display
  | 'WindowLevel'
  | 'Zoom'
  | 'Pan'
  | 'StackScroll'
  | 'Crosshairs'
  | 'ReferenceLines'
  | 'MagnifyTool'
  | 'PlanarRotate'
  // LiverRa delta: TrackballRotate lives in TOOL_MAP (not a separate addTool)
  // so enable3DRotateGesture() can bind it on the shared group for tablets.
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

/** @deprecated LiverRa pre-port alias — use StandardPACSTool. */
export type StandardLiverTool = StandardPACSTool;

/** Minimal shape of a Cornerstone3D annotation for type-safe property access */
interface CornerstoneAnnotation {
  annotationUID?: string;
  metadata?: {
    toolName?: string;
    purpose?: string;
    calibrationPurpose?: string;
    referencedImageId?: string;
    imageId?: string;
    viewportId?: string;
    StudyInstanceUID?: string;
    SeriesInstanceUID?: string;
    SOPInstanceUID?: string;
    FrameOfReferenceUID?: string;
    frameNumber?: string;
    calibrationId?: string;
  };
  isVisible?: boolean;
  data?: {
    cachedStats?: Record<string, { length?: number; unit?: string }>;
    handles?: { points?: unknown[] };
    purpose?: string;
    calibrationPurpose?: string;
    referencedImageId?: string;
    imageId?: string;
    viewportId?: string;
    StudyInstanceUID?: string;
    SeriesInstanceUID?: string;
    SOPInstanceUID?: string;
    FrameOfReferenceUID?: string;
    frameNumber?: string;
    calibrationId?: string;
  };
}

interface CornerstoneVolumeCache {
  getVolumes?: () => Array<{ volumeId?: string }>;
  removeVolumeLoadObject?: (id: string) => void;
}

// ============================================================================
// Constants
// ============================================================================

/** Unique ID for the singleton RenderingEngine instance */
export const RENDERING_ENGINE_ID = 'liverra-pacs-engine';

// ---- HTJ2K Transfer Syntax UIDs ----
// HTJ2K (High-Throughput JPEG 2000) is a faster version of JPEG 2000 that supports
// progressive rendering — images appear blurry first and refine as data arrives,
// like how a photo loads progressively on a slow internet connection.

/** HTJ2K Lossless — full quality, no compression artifacts */
export const HTJ2K_LOSSLESS_UID = '1.2.840.10008.1.2.4.201';

/** HTJ2K Lossy (RPCL) — slightly compressed, supports progressive rendering */
export const HTJ2K_LOSSY_UID = '1.2.840.10008.1.2.4.202';

/** Explicit VR Little Endian — the universal fallback that all PACS servers support */
export const EXPLICIT_VR_LITTLE_ENDIAN_UID = '1.2.840.10008.1.2.1';

/**
 * HTJ2K streaming configuration.
 * Controls whether the viewer requests images in HTJ2K format for faster
 * initial display. Can be disabled at runtime if it causes issues.
 */
export interface HTJ2KConfig {
  /** Whether HTJ2K progressive streaming is enabled (default: true) */
  enabled: boolean;
  /** Prefer lossless (true) or lossy progressive (false). Default: false (lossy = faster initial display) */
  preferLossless: boolean;
}

/** Current HTJ2K configuration — can be changed at runtime via configureHTJ2K() */
let htj2kConfig: HTJ2KConfig = {
  enabled: true,
  preferLossless: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseHTJ2KConfig(value: unknown): Partial<HTJ2KConfig> {
  if (!isRecord(value)) {
    return {};
  }

  const config: Partial<HTJ2KConfig> = {};
  if (typeof value.enabled === 'boolean') {
    config.enabled = value.enabled;
  }
  if (typeof value.preferLossless === 'boolean') {
    config.preferLossless = value.preferLossless;
  }
  return config;
}

/**
 * Window/Level presets — predefined contrast settings for different body parts.
 * Doctors switch between these to highlight specific tissues in CT/MR images.
 * - center: the midpoint of the Hounsfield Unit range to display
 * - width: how wide the range is (narrow = high contrast, wide = low contrast)
 */
export const WINDOW_LEVEL_PRESETS: Record<string, { center: number; width: number }> = {
  // LiverRa delta: hepatic soft-tissue window for contrast-enhanced CT —
  // WindowPresets.tsx hardcodes the 'liver' key; never remove this entry.
  liver: { center: 90, width: 150 },
  // Cardiac CT angiography — primary preset for TAVI / pre-procedural cardiac
  // planning. Wide enough to show contrast-enhanced lumen + calcium without
  // blowing out the myocardium.
  cardiac: { center: 200, width: 600 },
  // Chest mediastinum / soft tissue — used for sternum + great vessel review,
  // standard non-cardiac chest CT default.
  mediastinum: { center: 50, width: 350 },
  lung: { center: -600, width: 1500 },
  bone: { center: 300, width: 1500 },
  brain: { center: 40, width: 80 },
  softTissue: { center: 40, width: 400 },
  abdomen: { center: 60, width: 400 },
  // Mammography (FFDM) — values are in stored-pixel units, NOT Hounsfield.
  // 'For Presentation' FFDM is already VOI-mapped to ~12-bit display values,
  // so these are sensible STARTING points to tune against a real study from
  // the unit. mammoStandard = near-identity full range; mammoDense = a tighter
  // window to lift dense-tissue (ACR c/d) contrast.
  mammoStandard: { center: 2048, width: 4096 },
  mammoDense: { center: 1600, width: 2200 },
};

/**
 * Maps our PACSViewerTool type names to the actual Cornerstone3D tool classes.
 * This is used during initialization to register all tools at once.
 *
 * Most tool names match the CS3D toolName (e.g., 'Length' → LengthTool).
 * For tools where our name differs from CS3D, see CS3D_NAME_MAP below.
 */
export const TOOL_MAP: Record<StandardPACSTool, typeof cornerstoneTools.BaseTool> = {
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
 * Maps our app tool names to CS3D internal tool names, for cases where they differ.
 * Most tools have matching names (e.g., 'Probe' → 'Probe'), so only mismatches go here.
 * Think of this as a "translation table" between our naming and CS3D's naming.
 */
const CS3D_NAME_MAP: Record<string, string> = {
  FreehandROI: 'PlanarFreehandROI',
  MagnifyTool: 'Magnify',
  // `cornerstoneTools.BrushTool.toolName === 'Brush'`. The TAVI workspace
  // (Step 03) activates segmentation by calling `activateToolOnGroup('BrushTool')`
  // — match it to the registered group tool name to avoid the runtime error
  // "Tool BrushTool not added to toolGroup, can't set tool mode" (live-fix round 2, Bug B).
  BrushTool: 'Brush',
};

/**
 * Get the CS3D internal tool name for a given PACSViewerTool name.
 * Returns the mapped name if one exists, otherwise the original name.
 */
export function getCS3DToolName(appToolName: string): string {
  return CS3D_NAME_MAP[appToolName] ?? appToolName;
}

/**
 * Per-plane reference-line colors for the MPR CrosshairsTool.
 *
 * Each viewport's crosshair is drawn in the OTHER two viewports as a
 * reference line; this map colors it by the plane it represents so the
 * operator can tell at a glance which line moves which view. Uses only
 * the project's allowed theme colors (no purple/orange/yellow):
 *   • blue  (#3182ce, --emr-accent)  → axial
 *   • green (#22c55e, --emr-success) → sagittal / left-coronary proxy
 *   • red   (#ef4444, --emr-error)   → coronal / right-coronary proxy
 *
 * Keyed by both the TAVI viewport ids and the generic PACS ids so the
 * single shared tool group serves Feature 079 and Feature 044 alike.
 */
const CROSSHAIR_AXIAL = '#3182ce';
const CROSSHAIR_SAGITTAL = '#22c55e';
const CROSSHAIR_CORONAL = '#ef4444';
export const CROSSHAIR_REFERENCE_COLORS: Record<string, string> = {
  'tavi-axial': CROSSHAIR_AXIAL,
  'tavi-sagittal': CROSSHAIR_SAGITTAL,
  'tavi-coronal': CROSSHAIR_CORONAL,
  'tavi-lca': CROSSHAIR_SAGITTAL,
  'tavi-rca': CROSSHAIR_CORONAL,
  'viewport-0': CROSSHAIR_AXIAL,
  'viewport-1': CROSSHAIR_SAGITTAL,
  'viewport-2': CROSSHAIR_CORONAL,
};

/** Resolve a crosshair reference-line color, defaulting to theme blue. */
export function getCrosshairReferenceColor(viewportId: string): string {
  return CROSSHAIR_REFERENCE_COLORS[viewportId] ?? CROSSHAIR_AXIAL;
}

// When false, the MPR crosshair still draws its colored reference lines and
// keeps the panes camera-synced (passive), but its line/center handles are
// NOT grab-able — so a left-click/drag falls through to the active tool
// (e.g. TAVI Step-3 BrushTool) instead of being stolen as a re-slice. The
// `getReferenceLine*` config closures below read this live, so flipping it
// takes effect on the next interaction with no re-add. Defaults true →
// Feature-044 PACS MPR and every non-paint step are completely unaffected.
let crosshairLinesInteractive = true;

/**
 * Toggle whether the shared MPR crosshair's reference lines are grab-able.
 * TAVI Step 3 sets this false while a paint tool is active and true again
 * for the "Navigate" tool. No-op-safe to call before the tool group exists.
 */
export function setCrosshairLinesInteractive(interactive: boolean): void {
  crosshairLinesInteractive = interactive;
}

// ============================================================================
// Window/Level (VOI) synchronization across MPR panes
// ============================================================================
// On the TAVI 3-up MPR the operator expects a window/level drag on ANY pane to
// adjust ALL panes together (one contrast for the whole root). Cornerstone3D's
// WindowLevelTool only touches the pane you drag in; the cross-pane behaviour
// comes from a VOI synchronizer that re-broadcasts every VOI_MODIFIED event to
// the other registered viewports. Same primitive Feature 044's ComparisonView
// uses for prior/current contrast sync. The W/L preset row in TaviUnifiedToolbar
// already loops every pane explicitly — this covers the interactive drag path.
// ============================================================================

/** Single shared synchronizer id for the TAVI MPR W/L group. */
const TAVI_VOI_SYNC_ID = 'liverra-voi-sync';

/**
 * Make window/level adjustments propagate across the given viewports. Tears
 * down any prior instance first so repeated calls (step/layout changes) don't
 * stack synchronizers. No-op-safe before the engine/viewports exist — the
 * synchronizer simply has nothing to broadcast until they render.
 *
 * @param viewportIds - Cornerstone3D viewport ids in the current MPR layout.
 *   Fewer than 2 ids → cleared (nothing to sync on a single-pane layout).
 */
export function syncVoiAcrossViewports(viewportIds: string[]): void {
  clearVoiSync();
  if (!Array.isArray(viewportIds) || viewportIds.length < 2) {
    return;
  }
  try {
    const sync = cornerstoneTools.synchronizers.createVOISynchronizer(TAVI_VOI_SYNC_ID, {
      syncInvertState: true,
      syncColormap: false,
    });
    for (const viewportId of viewportIds) {
      sync.add({ renderingEngineId: RENDERING_ENGINE_ID, viewportId });
    }
  } catch (err) {
    silentLog('cornerstoneInit', 'syncVoiAcrossViewports', err);
  }
}

/** Destroy the TAVI W/L synchronizer. Safe to call when none exists. */
export function clearVoiSync(): void {
  try {
    cornerstoneTools.SynchronizerManager.destroySynchronizer(TAVI_VOI_SYNC_ID);
  } catch (err) {
    silentLog('cornerstoneInit', 'clearVoiSync', err);
  }
}

// ============================================================================
// State
// ============================================================================

/** Tracks whether initCornerstone() has already run successfully */
let initialized = false;

/**
 * In-flight init promise — single-flight guard. The `initialized` flag only flips
 * true at the END of the async body, so two concurrent callers (React StrictMode's
 * double-mount, or a fast study switch) both pass the `if (initialized)` check and
 * both run the body → "Worker type 'dicomImageLoader' is already registered" and
 * redundant cornerstone.init/cache-sizing/tool-registration. Caching the promise
 * makes the body run exactly once; concurrent callers await the same promise.
 */
let initPromise: Promise<void> | null = null;

/** Singleton rendering engine reference */
let renderingEngine: cornerstone.RenderingEngine | null = null;

// H-PACS-1 (LiverRa): refcount the shared rendering engine. Callers acquire
// a refcount when they mount and release it on unmount; only the last
// release actually destroys the engine (multi-tab + comparison-view + the
// case viewer's MPR fallback all share this engine).
let engineRefcount = 0;

// ============================================================================
// ArrowAnnotate Text Input Callback
// ============================================================================
// Instead of using window.prompt(), we hook into a React component to show a
// polished text input. This works like a "callback mailbox" — when CS3D wants
// text, we store the callback here. The React component picks it up, gets the
// text from the user, and calls the callback with the result.

/** Stores the pending callback from ArrowAnnotateTool's getTextCallback */
let pendingArrowTextCallback: ((text: string) => void) | null = null;

/** Listener that React components register to know when text is needed */
let arrowTextRequestListener: (() => void) | null = null;

/**
 * Register a listener from a React component that will be called whenever
 * the ArrowAnnotateTool needs a text label from the user.
 */
export function onArrowAnnotateTextRequest(listener: () => void): () => void {
  arrowTextRequestListener = listener;
  return () => {
    arrowTextRequestListener = null;
  };
}

/**
 * Submit the text label from the React component back to Cornerstone3D.
 * Call this when the user finishes typing in the text input popover.
 */
export function submitArrowAnnotateText(text: string): void {
  if (pendingArrowTextCallback) {
    pendingArrowTextCallback(text);
    pendingArrowTextCallback = null;
  }
}

/**
 * Cancel the arrow annotate text input — submits empty string.
 */
export function cancelArrowAnnotateText(): void {
  submitArrowAnnotateText('');
}

// ============================================================================
// Public API
// ============================================================================

// ============================================================================
// Dropped-frame retry (fixes "black bands" in MPR/VR volumes)
// ============================================================================
// The local PACS (nginx → bridge → Orthanc) serves every frame fine on its own
// (a one-off GET returns 200 OK), but a streaming MPR/VR volume fires its frames
// as a ~12-wide parallel burst and the PACS DROPS a fraction of them under that
// concurrency (verified: ~30% of an 826-slice CTA fail with an XHR error, a
// different ~250 each load). Cornerstone's image-load pool has NO retry, so a
// dropped frame leaves a permanent hole → BLACK horizontal bands across the
// reconstructed volume (worst in the run-off region whose slices queue last).
//
// Re-requesting a frame AFTER the volume's loader already gave up does NOT help:
// a StreamingImageVolume writes each decoded frame into its scalar buffer inside
// the loader's success callback, so a later standalone re-fetch fills the cache
// but not the buffer. The retry must therefore live INSIDE the loader the pool
// calls — we wrap the registered `wadors`/`wadouri` loaders so a failed attempt
// is re-tried (bounded, with backoff) and the pool only ever sees the eventual
// success, which then writes the frame into the volume.
//
// Crucially the wrapper HOLDS THE POOL SLOT for the whole retry sequence, so
// retries stay within the existing concurrency cap (Prefetch/Interaction = 12)
// instead of re-bursting the PACS — it recovers drops without making the storm
// worse. As a side benefit, succeeding-on-retry avoids leaving a rejected
// image-load promise cached against the imageId (the "poisoned frame" trap).
const FRAME_LOAD_MAX_ATTEMPTS = 3; // 1 initial + 2 retries
const FRAME_LOAD_BACKOFF_MS = [300, 900]; // delay before retry #1, retry #2 (+jitter)

type CsImageLoadObject = { promise: Promise<unknown>; cancelFn?: () => void; decache?: () => void };
type CsImageLoader = (imageId: string, options?: unknown) => CsImageLoadObject;

function isRealPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
}

function isImageLoadObject(value: unknown): value is CsImageLoadObject {
  return isRecord(value) && isRealPromise(value.promise);
}

function shouldProbeLoaderShape(): boolean {
  return typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
}

function getRetryableLoader(scheme: string, candidate: unknown): CsImageLoader | undefined {
  if (typeof candidate !== 'function') {
    console.warn(`[cornerstoneInit] skipping ${scheme} retry wrapper: loadImage is not a function`);
    return undefined;
  }
  const loader = candidate as CsImageLoader;
  if (!shouldProbeLoaderShape()) {
    return loader;
  }
  try {
    const probe = loader(`${scheme}:__liverra_loader_shape_probe__`);
    if (!isImageLoadObject(probe)) {
      console.warn(`[cornerstoneInit] skipping ${scheme} retry wrapper: loadImage returned an invalid load object`);
      return undefined;
    }
    probe.promise.catch(() => undefined);
    try { probe.cancelFn?.(); } catch (err) { console.warn('[cornerstoneInit] frame load probe cancel failed:', err); }
    try { probe.decache?.(); } catch (err) { console.warn('[cornerstoneInit] frame load probe decache failed:', err); }
    return loader;
  } catch (err) {
    console.warn(`[cornerstoneInit] skipping ${scheme} retry wrapper: loadImage probe failed`, err);
    return undefined;
  }
}

function wrapLoaderWithRetry(original: CsImageLoader): CsImageLoader {
  return (imageId: string, options?: unknown): CsImageLoadObject => {
    let cancelled = false;
    let inflight: CsImageLoadObject | undefined;

    const run = async (): Promise<unknown> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < FRAME_LOAD_MAX_ATTEMPTS; attempt++) {
        if (cancelled) {
          break;
        }
        try {
          const loadObject = original(imageId, options);
          if (!isImageLoadObject(loadObject)) {
            throw new Error('Cornerstone image loader returned an invalid load object');
          }
          inflight = loadObject;
          return await inflight.promise;
        } catch (err) {
          lastErr = err;
          // Stop if the request was cancelled (viewport/volume torn down) or we
          // are out of attempts — re-throw so the caller sees the original error.
          if (cancelled || attempt === FRAME_LOAD_MAX_ATTEMPTS - 1) {
            console.warn('[cornerstoneInit] frame load retry failed:', err);
            break;
          }
          const base = FRAME_LOAD_BACKOFF_MS[attempt] ?? 900;
          await new Promise((resolve) => {
            setTimeout(resolve, base + Math.floor(Math.random() * 200));
          });
        }
      }
      throw lastErr;
    };

    return {
      promise: run(),
      cancelFn: () => {
        cancelled = true;
        try { inflight?.cancelFn?.(); } catch (err) { console.warn('[cornerstoneInit] frame load cancel failed:', err); }
      },
      decache: () => {
        try { inflight?.decache?.(); } catch (err) { console.warn('[cornerstoneInit] frame load decache failed:', err); }
      },
    };
  };
}

/**
 * Re-register the `wadors` (DICOMweb) and `wadouri` (file/uri) image loaders with
 * a bounded retry wrapper. Call AFTER initDICOMImageLoader() — it overrides only
 * the loader registration, leaving the metadata providers + web workers intact.
 */
function installFrameRetryLoaders(): void {
  const csLoader = cornerstone.imageLoader as unknown as {
    registerImageLoader?: (scheme: string, fn: CsImageLoader) => void;
  };
  if (typeof csLoader.registerImageLoader !== 'function') {
    return;
  }
  try {
    const wadorsOriginal = getRetryableLoader('wadors', cornerstoneDICOMImageLoader.wadors?.loadImage);
    if (wadorsOriginal) {
      csLoader.registerImageLoader('wadors', wrapLoaderWithRetry(wadorsOriginal as CsImageLoader));
    }
    const wadouriOriginal = getRetryableLoader('wadouri', cornerstoneDICOMImageLoader.wadouri?.loadImage);
    if (wadouriOriginal) {
      csLoader.registerImageLoader('wadouri', wrapLoaderWithRetry(wadouriOriginal as CsImageLoader));
    }
  } catch (err) {
    silentLog('cornerstoneInit', 'installFrameRetryLoaders', err);
  }
}

/**
 * Initialize Cornerstone3D — must be called once before any viewer is rendered.
 *
 * What it does:
 * 1. Initializes the Cornerstone3D core library (sets up WebGL context)
 * 2. Configures the DICOM image loader (tells Cornerstone how to fetch DICOM files)
 * 3. Registers all viewer tools (measurement, annotation, navigation tools)
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initCornerstone(): Promise<void> {
  if (initialized) {
    return;
  }
  // Single-flight: if a concurrent caller is already running the body, await it
  // instead of re-running it (prevents the duplicate worker registration).
  if (initPromise) {
    return initPromise;
  }
  initPromise = initCornerstoneImpl();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

async function initCornerstoneImpl(): Promise<void> {
  // Step 1: Initialize Cornerstone3D core (WebGL2 rendering pipeline).
  // LiverRa delta: MediMind passes { rendering: { preferSizeOverAccuracy:
  // true } } (halves VRAM via a normalized texture path). LiverRa's case
  // viewer renders surgical lesion contours validated against full WebGL
  // precision, so the flag is intentionally DROPPED pending a clinical
  // rendering review (Class IIb conservatism over VRAM savings).
  await cornerstone.init();

  // Step 1.1: Size the image cache for whole CT volumes.
  //
  // Cornerstone's default cache is ~1 GB. A ~600-2000-slice cardiac CT
  // (≈0.5 MB/decoded slice) plus MPR textures overruns that, so frames
  // are evicted and RE-FETCHED + RE-DECODED on every scroll pass — a
  // primary cause of scroll lag. 3 GB desktop holds a ≤2k-slice study
  // with margin (under NFR-004/006 ceilings); 512 MB on mobile prevents
  // tab OOM kills. Guarded — older builds / unit-test mocks may lack it.
  try {
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const maxCacheBytes = isMobile ? 512 * 1024 * 1024 : 3 * 1024 * 1024 * 1024;
    cornerstone.cache?.setMaxCacheSize?.(maxCacheBytes);
  } catch (err) {
    silentLog('cornerstoneInit', 'setMaxCacheSize', err);
  }

  // Step 1.5: Cap concurrent WADO-RS frame requests.
  //
  // Cornerstone's shipped `imageLoadPoolManager` singleton overrides its own
  // sane class defaults to `maxNumRequests.Prefetch = 1000` / `grabDelay = 0`.
  // A streaming MPR volume enqueues EVERY frame as RequestType.Prefetch, so a
  // ~600-slice TAVI CT bursts hundreds of frame XHRs at once. The PACS nginx
  // edge fronting Orthanc rate-limits `/dicom-web/` (limit_req/limit_conn +
  // a per-frame `/auth-validate` 5 r/s subrequest) and rejects the burst with
  // HTTP 503; Cornerstone's pool has NO backoff/max-retry and retries
  // forever → no pixels ever load → permanently gray viewports.
  //
  // The historical clamp was Prefetch=4 — a band-aid because every frame
  // fired an UNCACHED nginx `/auth-validate` → Bridge → Medplum `/auth/me`
  // round-trip. The Bridge auth-cache (pacs/bridge dicomWebAuthValidate,
  // sha256(token)→exp, 30s TTL) is now DEPLOYED + verified live in the
  // running container (B1 / B-STEP 2 verified 2026-05-19: authValidationCache
  // present, /health lastSeq preserved), and nginx budgets were raised to
  // match (limit_conn 32 ≥ Prefetch 12 + Interaction 12 + Thumbnail 8). So
  // the per-frame auth subrequest is no longer the floor: Prefetch=12 /
  // Interaction=12 lets the volume stream in seconds without self-503.
  // Stack-mode PACS is unaffected. Single set at startup is enough —
  // the pool is a process-wide singleton consumed by BaseStreamingImageVolume.
  // Guarded so a missing pool (older builds / unit-test mocks) is a no-op.
  try {
    const requestType = cornerstone.Enums?.RequestType;
    const pool = cornerstone.imageLoadPoolManager;
    if (pool && requestType && typeof pool.setMaxSimultaneousRequests === 'function') {
      pool.setMaxSimultaneousRequests(requestType.Prefetch, 12);
      pool.setMaxSimultaneousRequests(requestType.Interaction, 12);
      pool.setMaxSimultaneousRequests(requestType.Thumbnail, 8);
      pool.grabDelay = 8;
    }
  } catch (err) {
    silentLog('cornerstoneInit', 'configureRequestPool', err);
  }

  // Step 2: Initialize the DICOM image loader (v4 API)
  // This registers web workers for decoding DICOM pixel data in background threads.
  // The actual DICOMweb server URL is set per-request when loading studies.
  //
  // Tuned for CT:
  //  • maxWebWorkers = cores-1 (capped 8) — leaves a thread for the UI and
  //    avoids worker thrash on high-core machines (default = all cores).
  //  • use16BitDataType: CT is natively 16-bit; decoding straight to 16-bit
  //    (instead of upcasting to float32) halves texture bytes and speeds
  //    upload — compounds the Step 1.1 cache headroom and Step 1 texture path.
  //  • convertFloatPixelDataToInt: false — preserve CT HU integer fidelity.
  try {
    initDICOMImageLoader({
      maxWebWorkers: Math.max(
        1,
        Math.min(8, (navigator.hardwareConcurrency || 4) - 1)
      ),
      decodeConfig: {
        use16BitDataType: true,
        convertFloatPixelDataToInt: false,
      },
    } as Parameters<typeof initDICOMImageLoader>[0]);
  } catch (err) {
    silentLog('cornerstoneInit', 'initDICOMImageLoader', err);
    initDICOMImageLoader();
  }

  // Step 2.5: Configure HTJ2K progressive streaming
  // If enabled, the DICOM image loader will request images in HTJ2K format first.
  // If the PACS server doesn't support HTJ2K, it falls back to standard format.
  // This is a non-breaking opt-in — stored in htj2kConfig and read by
  // getPreferredTransferSyntaxes() when building DICOMweb retrieve requests.
  try {
    const savedConfig = localStorage.getItem('liverra-htj2k-config');
    if (savedConfig) {
      const parsed: unknown = JSON.parse(savedConfig);
      htj2kConfig = { ...htj2kConfig, ...parseHTJ2KConfig(parsed) };
    }
  } catch (err) {
    silentLog('cornerstoneInit', 'loadHTJ2KConfig', err);
    // Invalid or missing config — use defaults (HTJ2K enabled, lossy preferred)
  }

  // Step 2.6: Register the streaming volume loader for MPR
  // This tells Cornerstone3D how to build a 3D volume from a stack of 2D slices.
  // Without this, createAndCacheVolume() fails because it doesn't know how to load pixel data.
  cornerstone.volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    cornerstone.cornerstoneStreamingImageVolumeLoader
  );

  // Step 2.7: Wrap the frame loaders with bounded retry so dropped frames
  // auto-recover instead of leaving permanent BLACK BANDS in the volume. Must
  // run AFTER initDICOMImageLoader registered the loaders. See wrapLoaderWithRetry.
  installFrameRetryLoaders();

  // Step 3: Initialize the tools framework (sets up event listeners, annotation state)
  cornerstoneTools.init();

  // Step 4: Register all viewer tools
  // Tools must be registered globally before they can be activated per-viewport.
  for (const ToolClass of Object.values(TOOL_MAP)) {
    cornerstoneTools.addTool(ToolClass);
  }

  // Step 5: Register segmentation tools
  // These are separate from TOOL_MAP because they use different activation
  // patterns (not tied to a single mouse binding like measurement tools).
  // BrushTool handles painting, threshold painting (via strategies), and erasing
  // (by setting active segment index to 0). It's the "Swiss Army knife" of
  // segmentation tools.
  cornerstoneTools.addTool(cornerstoneTools.BrushTool);
  // LiverRa delta: SegmentationDisplayTool renders existing labelmap overlays
  // (the case viewer's parenchyma/Couinaud/lesion masks). Exported in
  // @cornerstonejs/tools ≤ 1.x and folded into the segmentation state in 2.x —
  // guarded so either version builds without breaking.
  try {
    const maybeDisplay = (cornerstoneTools as unknown as {
      SegmentationDisplayTool?: typeof cornerstoneTools.BaseTool;
    }).SegmentationDisplayTool;
    if (maybeDisplay) {
      cornerstoneTools.addTool(maybeDisplay);
    }
  } catch (err) {
    silentLog('cornerstoneInit', 'registerSegmentationDisplay', err);
  }

  // Step 6: (LiverRa delta) TrackballRotateTool is registered via TOOL_MAP
  // above — LiverRa keeps it in the shared group (Passive) so
  // enable3DRotateGesture() can bind the two-finger rotate gesture on
  // tablets. The VR tool group still binds it to LMB for the 3D pane.

  // Step 7: Register the advanced 3D VR tools.
  // - VolumeCroppingTool: renders 6 face + 8 corner spheres + 12 edge lines
  //   on the VR pane; operator drags handles to clip the volume.
  // - VolumeCroppingControlTool: shares the SAME ClippingPlane[] state and
  //   renders min/max reference lines on each MPR pane — dragging the lines
  //   updates the 3D crop in real time. This pair is the "draw on MPR → 3D
  //   shows only that region" workflow that the 3mensio TAVI workstation
  //   built its reputation on.
  // - OrientationControllerTool: clickable orientation cube. Distinct from
  //   OrientationMarkerTool (which is display-only). Click A/P/L/R/S/I to
  //   snap the VR camera; no manual setCamera math needed.
  cornerstoneTools.addTool(cornerstoneTools.VolumeCroppingTool);
  cornerstoneTools.addTool(cornerstoneTools.VolumeCroppingControlTool);
  cornerstoneTools.addTool(cornerstoneTools.OrientationControllerTool);

  // Step 8: Register the TAVI MarkerPlaceTool (Feature 079, Step 4 / 5 / 6 / 7).
  // This is the click-to-place tool that replaces the legacy native-pointer
  // addEventListener on the viewport host (which fought PanTool for the LMB
  // binding). Registered globally here so it's always available — the TAVI
  // workspace activates/disables it per-step via the helpers in
  // `services/pacs-planning/markerPlaceTool.ts`. Safe no-op outside TAVI.
  try {
    await registerTaviTools();
  } catch (err) {
    silentLog('cornerstoneInit', 'registerMarkerPlaceTool', err);
  }

  initialized = true;
}

/**
 * Get the singleton RenderingEngine, creating it if needed.
 *
 * The RenderingEngine is the central object that manages all viewports
 * (the rectangles on screen where images are rendered). There's only one
 * per application — viewports are added/removed from it as needed.
 *
 * @returns The shared RenderingEngine instance
 * @throws If Cornerstone3D hasn't been initialized yet
 */
export function getOrCreateRenderingEngine(): cornerstone.RenderingEngine {
  if (!initialized) {
    throw new Error(
      'Cornerstone3D not initialized. Call initCornerstone() first.'
    );
  }

  if (!renderingEngine || renderingEngine.hasBeenDestroyed) {
    renderingEngine = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);
  }

  return renderingEngine;
}

/**
 * Acquire a reference to the shared Cornerstone state (LiverRa H-PACS-1).
 *
 * Pattern:
 *   const release = acquireCornerstoneRef();
 *   // ... use the engine / toolgroup ...
 *   return () => release();        // unmount
 *
 * The returned `release` function is idempotent — calling it twice
 * decrements the count once. When the count reaches zero the engine is
 * destroyed via `destroyCornerstoneNow()`, matching the previous behaviour
 * for single-viewer scenarios.
 */
export function acquireCornerstoneRef(): () => void {
  engineRefcount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    engineRefcount = Math.max(0, engineRefcount - 1);
    if (engineRefcount === 0) {
      destroyCornerstoneNow();
    }
  };
}

/**
 * Destroy Cornerstone3D engine state UNCONDITIONALLY. Internal helper called
 * by the refcount reaching zero (and by the WebGL context-lost handler, where
 * a hard reset is required regardless of who still holds a ref). External
 * callers should prefer the `acquireCornerstoneRef()` + release pattern so
 * multi-view scenarios don't tear down the engine while another viewport
 * still needs it.
 */
function destroyCornerstoneNow(): void {
  // Destroy the ToolGroups first — they hold references to viewports in the
  // engine. Without this, orphaned ToolGroup references accumulate across
  // mount/unmount cycles.
  try {
    cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
  } catch (err) {
    silentLog('cornerstoneInit', 'destroyToolGroup', err);
    // ToolGroup may not exist yet or already destroyed
  }
  try {
    cornerstoneTools.ToolGroupManager.destroyToolGroup(VR_TOOL_GROUP_ID);
  } catch (err) {
    silentLog('cornerstoneInit', 'destroyVrToolGroup', err);
    // VR ToolGroup may not exist yet (created lazily on first 3D activation)
  }
  toolGroup = undefined;
  // The destroyed groups took their tool bindings with them — reset the dedup cache.
  activePrimaryToolKeyByGroup.clear();

  if (renderingEngine && !renderingEngine.hasBeenDestroyed) {
    renderingEngine.destroy();
  }
  renderingEngine = null;

  // NOTE: We intentionally do NOT purge the CS3D volume/image cache here.
  // Cache lifetime is independent of engine lifetime — a React 19 Strict-Mode
  // simulated unmount would otherwise wipe volumes the very next render is
  // about to bind. If you need to clear the cache (page unload, explicit
  // user "clear cache" action), call `purgeCornerstoneCache()` below.
}

/**
 * Destroy Cornerstone3D state — kept for backward compatibility with
 * callers that haven't migrated to `acquireCornerstoneRef()` yet
 * (LiverViewer3D's unmount path among them).
 *
 * BACKWARD-COMPATIBLE BEHAVIOUR: if refcount is non-zero we warn rather
 * than destroy, because tearing down the engine while another viewport
 * still has it attached blanks all open PACS tabs (H-PACS-1). New
 * code MUST use `acquireCornerstoneRef()`.
 */
export function destroyCornerstone(): void {
  if (engineRefcount > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[cornerstoneInit] destroyCornerstone() called with engineRefcount=${engineRefcount}; ` +
        'preferring refcount semantics (use acquireCornerstoneRef() instead). ' +
        'Engine NOT destroyed.',
    );
    return;
  }
  destroyCornerstoneNow();
}

/**
 * Backward-compatible alias — the ported MediMind code calls this name.
 * Same refcount-guarded semantics as {@link destroyCornerstone}.
 */
export const destroyRenderingEngine = destroyCornerstone;

/**
 * Purge every cached image + volume from Cornerstone3D's global cache.
 *
 * Call this only for explicit lifecycle events (page unload, user-triggered
 * "clear cache", out-of-memory recovery) — NOT from a React component
 * unmount, because Strict Mode's mount→unmount→remount cycle will then
 * wipe volumes that the next render is about to use.
 */
export function purgeCornerstoneCache(): void {
  try {
    cornerstone.cache.purgeCache();
  } catch (err) {
    silentLog('cornerstoneInit', 'cacheTeardown', err);
    // cache may already be torn down
  }
}

// ============================================================================
// WebGL context-loss + visibility lifecycle (PACS-B3)
// ============================================================================
// iOS Safari, Capacitor, and low-RAM Android can force-kill the WebGL2 context
// when the page is backgrounded or memory pressure spikes. Without listeners,
// the next render call after foregrounding throws and the tab crashes.
// We expose installers so the viewer hook (usePACSViewer) can wire them once
// per mount and remove them on unmount.

let lifecycleInstalled = false;
let onContextLost: ((e: Event) => void) | null = null;
let onContextRestored: ((e: Event) => void) | null = null;
let onVisibilityChange: (() => void) | null = null;
let pendingPurgeTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingPurgeTimer(): void {
  if (pendingPurgeTimer) {
    clearTimeout(pendingPurgeTimer);
    pendingPurgeTimer = null;
  }
}

/**
 * Install browser lifecycle listeners that proactively destroy the rendering
 * engine when the WebGL context is lost or the tab is hidden. Idempotent —
 * repeated calls have no effect until {@link uninstallViewerLifecycle} runs.
 *
 * @param canvas - The visible WebGL canvas (or any canvas backed by the engine);
 *   used to subscribe to `webglcontextlost` / `webglcontextrestored`.
 * @param onLost - Optional callback fired after the engine is destroyed so the
 *   UI can mark itself as 'error' / show a reload prompt.
 * @param onRestored - Optional callback fired when the GPU returns; the UI can
 *   re-load the active study to rebuild GPU textures.
 */
export function installViewerLifecycle(
  canvas: HTMLCanvasElement,
  onLost?: () => void,
  onRestored?: () => void
): void {
  if (lifecycleInstalled) {
    return;
  }
  lifecycleInstalled = true;

  onContextLost = (e: Event) => {
    // Standard practice: preventDefault on context-lost to allow restoration.
    // Uses the UNCONDITIONAL destroy: a lost WebGL context invalidates the
    // engine for every ref-holder, so the refcount guard must not block it.
    e.preventDefault();
    destroyCornerstoneNow();
    if (onLost) {
      try {
        onLost();
      } catch (err) {
        console.warn('[PACS] WebGL context lost callback failed:', err);
        // swallow — callback is advisory
      }
    }
  };

  onContextRestored = () => {
    if (onRestored) {
      try {
        onRestored();
      } catch (err) {
        console.warn('[PACS] WebGL context restored callback failed:', err);
        // swallow
      }
    }
  };

  // 5 minutes — long enough that a brief Cmd+Tab away (look up labs,
  // answer a message, glance at email) doesn't lose the cached volume,
  // short enough that a genuinely-abandoned tab still releases GPU memory
  // eventually. The original implementation purged INSTANTLY on document.hidden,
  // which produced fresh gray bars every time the operator briefly tabbed away.
  const BACKGROUND_PURGE_DELAY_MS = 5 * 60 * 1000;

  onVisibilityChange = () => {
    if (document.hidden) {
      // Schedule (don't execute) a deferred purge. If the operator returns
      // within BACKGROUND_PURGE_DELAY_MS we cancel it below and the cache
      // is preserved — gray bars don't reappear on tab return.
      clearPendingPurgeTimer();
      pendingPurgeTimer = setTimeout(() => {
        pendingPurgeTimer = null;
        try {
          const cache = cornerstone.cache as CornerstoneVolumeCache;
          const volumeCache = cache.getVolumes?.();
          if (volumeCache) {
            for (const vol of volumeCache) {
              if (vol.volumeId) {
                try {
                  cache.removeVolumeLoadObject?.(vol.volumeId);
                } catch (err) {
                  console.warn('[PACS] volume cache cleanup failed:', err);
                  // ignore
                }
              }
            }
          }
        } catch (err) {
          console.warn('[PACS] background visibility cleanup failed:', err);
          // ignore — best-effort cleanup
        }
      }, BACKGROUND_PURGE_DELAY_MS);
    } else if (pendingPurgeTimer) {
      // Tab visible again before the 5-minute mark — cancel the pending
      // purge so the operator returns to an instantly-warm viewer.
      clearPendingPurgeTimer();
    }
  };

  canvas.addEventListener('webglcontextlost', onContextLost as EventListener, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored as EventListener, false);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

/**
 * Remove the lifecycle listeners installed by {@link installViewerLifecycle}.
 * Call from the viewer hook's cleanup. Safe to call multiple times.
 */
export function uninstallViewerLifecycle(canvas?: HTMLCanvasElement | null): void {
  clearPendingPurgeTimer();
  if (!lifecycleInstalled) {
    return;
  }
  if (canvas && onContextLost) {
    canvas.removeEventListener('webglcontextlost', onContextLost as EventListener);
  }
  if (canvas && onContextRestored) {
    canvas.removeEventListener('webglcontextrestored', onContextRestored as EventListener);
  }
  if (onVisibilityChange) {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  onContextLost = null;
  onContextRestored = null;
  onVisibilityChange = null;
  lifecycleInstalled = false;
}

/**
 * Check if the browser supports WebGL2, which Cornerstone3D requires.
 *
 * WebGL2 is the graphics API that lets the browser render 3D medical images
 * on the GPU. Without it, the PACS viewer can't work at all.
 *
 * @returns true if WebGL2 is available, false otherwise
 */
export function detectWebGL2Support(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const supported = gl !== null;
    // Explicitly release the GPU context — without this, the memory reserved
    // for this detection context persists indefinitely even though we only
    // needed it momentarily for feature detection.
    if (gl) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return supported;
  } catch (err) {
    console.warn('[PACS] WebGL2 support detection failed:', err);
    return false;
  }
}

// LiverRa delta: tracks whether the configured token getter has EVER
// returned a token — gates the beforeSend wait-for-token poll (see
// configureDicomAuth). Reset by clearDicomAuth on logout.
let dicomAuthTokenSeen = false;

/**
 * Configure the DICOM image loader with auth headers so it can fetch
 * images from the PACS server. Call this after login and whenever the
 * JWT token refreshes — like updating your security badge at work.
 *
 * @param getToken - Callback that returns the current JWT token
 */
export function configureDicomAuth(getToken: () => string | null): void {
  // The DICOM image loader makes its own XHR requests to fetch pixel data.
  // Without auth headers, nginx rejects these requests and the loader gets
  // HTML error pages instead of DICOM data → "samplesPerPixel is undefined".
  // The beforeSend hook injects the JWT token into every image fetch request.
  //
  // Accept-header handling is endpoint-sensitive:
  //   • Instance retrieve  (.../instances/X)         → application/dicom
  //   • Frame retrieve     (.../instances/X/frames/N) → multipart/related; type=application/octet-stream
  // Sending the wrong Accept returns HTTP 400 from the PACS proxy (verified
  // empirically). The regular PACS viewer fetches at instance granularity
  // so it never hit this; TAVI volume mode fetches per-frame and was
  // getting 400s for every pixel-data request → black viewport.
  //
  // Cornerstone-DICOM-image-loader (v4) gives us the right hook for this:
  // the `beforeSend` callback receives `(xhr, imageId, defaultHeaders)`
  // and we return a Record of headers to MERGE with the loader's defaults.
  // The loader already populates `defaultHeaders.Accept` with the correct
  // value per endpoint (multipart for frames, application/dicom for
  // instances), so we MUST NOT clobber it via `xhr.setRequestHeader('Accept', …)`.
  // We just add Authorization and return; the loader merges over its
  // defaults and the right Accept survives.
  const { setOptions } = cornerstoneDICOMImageLoader.internal;
  setOptions({
    // IMPORTANT: this is `async` on purpose. The v4 loader `await`s
    // `beforeSend` (see @cornerstonejs/dicom-image-loader xhrRequest.js),
    // so we can BLOCK a frame request until a bearer token is available.
    //
    // Why this matters (TAVI cold-entry bug): a streaming MPR volume fires
    // hundreds of frame XHRs in a burst. If even a few land while
    // `getToken()` is momentarily empty — e.g. the access token is being
    // refreshed, or the page was hard-reloaded straight into the TAVI
    // deep-link before the Medplum client rehydrated — the OLD code
    // returned `{}` (no Authorization) and those requests got a hard 401
    // with no retry, leaving permanent gray bands in the reformats.
    // Waiting briefly for the token (instead of firing unauthenticated)
    // makes cold-entry deep-links reliable without the "open PACS first"
    // workaround. Bounded so a genuinely logged-out state still fails fast.
    beforeSend: async (
      _xhr: XMLHttpRequest,
      _imageId: string,
      _defaultHeaders: Record<string, string>,
    ): Promise<Record<string, string>> => {
      let token = getToken();
      // LiverRa delta: only enter the token-wait poll AFTER this getter has
      // produced a token at least once. LiverViewer3D configures a deliberate
      // no-auth getter (`() => ''` — the dev proxy injects Basic auth); with
      // MediMind's unconditional poll, EVERY pixel-data request from the case
      // viewer would stall ~3s before firing. A genuine token-refresh gap
      // mid-session (token seen before, momentarily null) still gets the
      // bounded wait below; an unauthenticated cold start fails fast and the
      // frame-retry wrapper (installFrameRetryLoaders) absorbs stragglers.
      if (token) {
        dicomAuthTokenSeen = true;
      }
      if (!token && dicomAuthTokenSeen) {
        // ~3s max (20 × 150ms) — covers a token-refresh / rehydrate gap
        // without hanging the loader if the user is truly unauthenticated.
        for (let i = 0; i < 20 && !token; i++) {
          await new Promise((r) => setTimeout(r, 150));
          token = getToken();
        }
      }
      // Return ONLY Authorization and let the dicom-image-loader keep its
      // own per-endpoint default Accept. Do NOT add a transfer-syntax to
      // the frame Accept: this Orthanc build returns HTTP 500/400 on a
      // multi-range or HTJ2K frame Accept (verified empirically against the
      // live server — every CT frame failed → black viewer). The bytes
      // saving is not worth re-risking the clinical viewer; the cold-load
      // speedup comes from the Bridge auth cache + raised concurrency, not
      // from frame compression. (Reverted optimization B7.)
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
  });
}

/**
 * Clear the DICOM image-loader auth callback (PACS-M2). Call on logout so a
 * subsequent login on the same tab does not leak the prior user's bearer
 * token into image fetches before `configureDicomAuth` is re-run.
 */
export function clearDicomAuth(): void {
  dicomAuthTokenSeen = false;
  try {
    const { setOptions } = cornerstoneDICOMImageLoader.internal;
    // Replace the previous closure with a no-op header-setter.
    setOptions({ beforeSend: () => undefined });
  } catch (error) {
    console.warn('[cornerstoneInit] clearDicomAuth failed (already torn down?):', error);
  }
}

/**
 * Check if Cornerstone3D has been initialized.
 * Useful for components that need to verify readiness before rendering.
 */
export function isCornerstoneInitialized(): boolean {
  return initialized;
}

// ============================================================================
// HTJ2K Progressive Streaming
// ============================================================================
// HTJ2K (High-Throughput JPEG 2000) lets images render progressively — you see
// a low-res preview first that sharpens as more data arrives. Think of it like
// progressive JPEG on the web, but for medical images. Not all PACS servers
// support it, so we always fall back to standard transfer syntax if it fails.
// ============================================================================

/**
 * Update HTJ2K streaming configuration at runtime.
 * Call this to enable/disable HTJ2K without restarting the app.
 *
 * @param config - Partial config to merge with current settings
 */
export function configureHTJ2K(config: Partial<HTJ2KConfig>): void {
  htj2kConfig = { ...htj2kConfig, ...config };
}

/**
 * Get the current HTJ2K configuration.
 */
export function getHTJ2KConfig(): Readonly<HTJ2KConfig> {
  return { ...htj2kConfig };
}

/**
 * Get the preferred transfer syntax UIDs based on current HTJ2K config.
 * Returns an ordered list — the PACS server should use the first one it supports.
 *
 * If HTJ2K is disabled, returns only the standard fallback.
 * If enabled, returns HTJ2K first (lossy or lossless per config) then fallback.
 */
export function getPreferredTransferSyntaxes(): string[] {
  if (!htj2kConfig.enabled) {
    return [EXPLICIT_VR_LITTLE_ENDIAN_UID];
  }

  const primary = htj2kConfig.preferLossless ? HTJ2K_LOSSLESS_UID : HTJ2K_LOSSY_UID;
  const secondary = htj2kConfig.preferLossless ? HTJ2K_LOSSY_UID : HTJ2K_LOSSLESS_UID;

  return [primary, secondary, EXPLICIT_VR_LITTLE_ENDIAN_UID];
}

/**
 * Build the Accept header used for DICOM instance prefetch/retrieve requests.
 * The ordered transfer-syntax parameters are the actual "ask" that makes the
 * HTJ2K preference reach the PACS server; the bare application/dicom fallback
 * keeps older DICOMweb servers working.
 */
export function getDicomInstanceAcceptHeader(): string {
  const preferred = getPreferredTransferSyntaxes().map(
    (uid) => `application/dicom; transfer-syntax=${uid}`
  );
  return [...preferred, 'application/dicom'].join(', ');
}

/**
 * Check if a given transfer syntax UID is an HTJ2K variant.
 * Useful for determining if progressive rendering features should activate.
 */
export function isHTJ2KTransferSyntax(uid: string): boolean {
  return uid === HTJ2K_LOSSLESS_UID || uid === HTJ2K_LOSSY_UID;
}

// ============================================================================
// ToolGroup Management
// ============================================================================

/** Unique ID for the shared ToolGroup */
export const TOOL_GROUP_ID = 'liverra-pacs-toolgroup';

/** Cached ToolGroup reference */
let toolGroup: ReturnType<typeof cornerstoneTools.ToolGroupManager.getToolGroup> = undefined;

// ── Active-tool dedup cache (perf) ──────────────────────────────────────────
// `activateToolOnGroup` rebuilds the entire tool group on every call (loops all
// ~20 tools setting them passive/disabled, then re-activates the target + the 3
// permanent navigation buttons). On the TAVI toolbar that runs on EVERY pill /
// brush / erase click — a synchronous main-thread freeze. We remember the
// last-activated primary tool (key = `${cs3dName}|${keepPassive}`) so an
// identical request short-circuits to a true no-op. This kills the dominant
// cost: rapid re-clicking of the active tool, effect re-runs, and Brush↔Erase
// switching (both use the Brush tool, so the 2nd activation is redundant). A
// single deliberate switch still does the full rebuild once.
//
// The cache is reset whenever a fresh tool group is created/destroyed (its
// bindings are gone with the group) and invalidated by any code that changes
// the primary binding outside this function (marker-place, viewport reconfig).
//
// LiverRa delta (case-viewer uplift): keyed by tool-group id, not a single
// global, so the case viewer's own toolgroup (liverra-cases-axial /
// liverra-mpr-toolgroup) and the shared PACS group track their active tool
// independently. Every existing caller targets the shared group only, so they
// resolve to one stable key — behavior unchanged.
const activePrimaryToolKeyByGroup = new Map<string, string>();

/**
 * Force the next `activateToolOnGroup` call to fully re-run instead of
 * short-circuiting on the dedup cache. Call this whenever the primary mouse
 * binding is changed outside `activateToolOnGroup` (e.g.
 * `activateMarkerPlaceOnToolGroup`) or after the viewport set is reconfigured,
 * so the guard cannot mask a needed re-activation.
 */
export function invalidateActiveToolCache(): void {
  activePrimaryToolKeyByGroup.clear();
}

/**
 * (LiverRa delta) Build a CS3D touch binding. Cornerstone3D 2.x+ ships
 * `{ numTouchPoints: 1 | 2 | 3 }`; wrapped so the module loads even if a
 * future release changes the shape.
 */
function touchBinding(numTouchPoints: 1 | 2 | 3): { numTouchPoints: 1 | 2 | 3 } {
  return { numTouchPoints };
}

/**
 * Get or create the shared ToolGroup — the object that maps mouse buttons
 * to tools for all viewports. Think of it as the "remote control receiver"
 * that Cornerstone3D checks whenever you click/drag on an image.
 *
 * All registered tools start in Enabled state (passive — they show existing
 * annotations but don't respond to mouse). The `activateToolOnGroup` function
 * switches one to Active (responds to mouse input).
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

  // Fresh tool group → no tool is active yet. Clear the dedup cache so the
  // first `activateToolOnGroup` after (re)creation runs in full.
  activePrimaryToolKeyByGroup.delete(TOOL_GROUP_ID);

  // Add all tools to the group in Enabled state (passive — annotations visible but not interactive)
  // Use CS3D tool names (some differ from our app names, e.g., FreehandROI → PlanarFreehandROI)
  for (const appName of Object.keys(TOOL_MAP)) {
    const cs3dName = getCS3DToolName(appName);

    // ArrowAnnotate gets a custom text callback — instead of window.prompt(),
    // we signal the React component to show a polished text input popover
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
    } else if (appName === 'Crosshairs') {
      // Configure the MPR crosshair so it draws colored, controllable,
      // draggable reference lines (CS3D adds it line-less by default).
      // Purely additive — only affects appearance when the crosshair is
      // shown, so Feature 044's MPR viewer benefits too.
      group.addTool(cs3dName, {
        getReferenceLineColor: (viewportId: string) => getCrosshairReferenceColor(viewportId),
        getReferenceLineControllable: () => crosshairLinesInteractive,
        getReferenceLineDraggableRotatable: () => crosshairLinesInteractive,
        getReferenceLineSlabThicknessControlsOn: () => false,
        // Enlarged so the bubble dots on each reference line read as obvious
        // grab handles — the operator drags one to rotate the corresponding
        // plane. CS3D default is 3px (almost invisible); 7px sits between
        // "easy to see" and "doesn't dominate the line".
        handleRadius: 7,
        // Close the dead-zone CS3D leaves at the focal point (default 20px)
        // so the colored reference lines pass through each other and read
        // as a true "+". Rotation interaction is unaffected — the bubble
        // grab handles live further out on each line, not at the center.
        referenceLinesCenterGapRadius: 0,
      });
    } else if (appName === 'OrientationMarker') {
      // The CS3D OrientationMarkerTool renders a 3D AnnotatedCube widget whose
      // hardcoded default face colors are off-palette: xPlus/xMinus (L/R) =
      // '#ffff00' yellow, yPlus/yMinus (P/A) = '#00ffff' cyan, defaultStyle
      // faceColor = '#0000ff' pure blue (OrientationMarkerTool.js:37-54 in
      // @cornerstonejs/tools@4.22.6). Yellow is forbidden by the MediMind
      // palette. We override ONLY the colors here — BaseTool deep-merges this
      // partial config into the tool's defaultToolProps, so the anatomical
      // letters, faceRotation, fontSizeScale and the orientation-widget
      // geometry are preserved. White text on theme-allowed faces. Purely a
      // recolor — applies to Feature 044's PACS viewer and Feature 079's TAVI
      // MPR identically since they share this tool group.
      // Key 1 === OrientationMarkerTool.OVERLAY_MARKER_TYPES.ANNOTATED_CUBE
      // (OverlayMarkerType enum, OrientationMarkerTool.d.ts:3-7). Use the
      // stable literal rather than dereferencing the static so this stays a
      // single-file change and remains safe under the lightweight CS3D test
      // mock (which does not expose the static).
      group.addTool(cs3dName, {
        overlayConfiguration: {
          1: {
            faceProperties: {
              xPlus: { faceColor: '#3182ce', fontColor: '#ffffff' },
              xMinus: { faceColor: '#3182ce', fontColor: '#ffffff' },
              yPlus: { faceColor: '#2b6cb0', fontColor: '#ffffff' },
              yMinus: { faceColor: '#2b6cb0', fontColor: '#ffffff' },
              zPlus: { faceColor: '#1a365d', fontColor: '#ffffff' },
              zMinus: { faceColor: '#1a365d', fontColor: '#ffffff' },
            },
            defaultStyle: {
              faceColor: '#1a365d',
              fontColor: '#ffffff',
              edgeColor: '#ffffff',
            },
          },
        },
      });
    } else if (cs3dName === 'StackScroll') {
      // Coalesce scrolling over not-yet-streamed slices. ToolGroup.addTool
      // instantiates with an empty `{}` config (the constructor's
      // defaultToolProps defaults are bypassed), so StackScroll's own
      // `debounceIfNotLoaded`/`loop` end up undefined and every wheel tick
      // tries to jump to a cold frame → per-tick stall on a ~2000-slice CT.
      // Passing the config explicitly debounces cold-frame navigation and
      // stops wrap-around at the volume ends.
      group.addTool(cs3dName, { debounceIfNotLoaded: true, loop: false });
    } else {
      group.addTool(cs3dName);
    }
  }

  // Add segmentation tools to the group in Passive state (available but not active).
  // BrushTool handles painting, erasing, and threshold — activated only when
  // the user explicitly selects a segmentation tool via useSegmentation.setActiveTool().
  try {
    group.addTool('Brush');
    // 2026-05-20 (Part 3 of Step-3 fix): default the BrushTool strategy to
    // the 3D sphere variant so a single brush stroke (and any erase click)
    // crosses every slice the cursor sphere touches. The TAVI root spans
    // 30-80 axial slices; the previous default `FILL_INSIDE_CIRCLE` (2D
    // single-slice) made cleanup unusable. The Step-3 panel exposes a
    // runtime toggle (`setBrushStrategy('2d')`) for power-users.
    try {
      (group as unknown as {
        setToolConfiguration?: (toolName: string, config: Record<string, unknown>) => void;
      }).setToolConfiguration?.('Brush', { activeStrategy: 'FILL_INSIDE_SPHERE' });
    } catch (configErr) {
      console.warn('[PACS] brush tool configuration failed:', configErr);
    }
  } catch (err) {
    console.warn('[PACS] brush tool registration failed:', err);
    // BrushTool may not be registered (e.g., in unit tests)
  }

  // Default: StackScroll active on left mouse button (arrow cursor, scroll through slices)
  group.setToolActive('StackScroll', { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }] });

  // Enable orientation marker and scale overlay as always-on passive overlays.
  // "Enabled" mode means they render on every viewport without responding to mouse input.
  try {
    group.setToolEnabled('OrientationMarker');
  } catch (err) {
    console.warn('[PACS] orientation marker enable failed:', err);
    // Tool may not be available on all platforms
  }
  try {
    // ScaleOverlayTool._init reads enabledElements[0].viewport — it throws
    // "Cannot destructure property 'viewport' of enabledElements[0]" when the
    // group has NO viewports yet (this runs at group CREATION, before the
    // viewports are added). Only enable once ≥1 viewport is attached; otherwise
    // activateToolOnGroup re-asserts it after the panes register.
    const vpCount = getToolGroupViewportIds(group).length;
    if (vpCount >= 1) {
      group.setToolEnabled('ScaleOverlay');
    }
  } catch (err) {
    console.warn('[PACS] scale overlay enable failed:', err);
    // Tool may not be available on all platforms
  }

  // VolumeCroppingControlTool: renders min/max reference lines on each MPR
  // pane. Shares ClippingPlane[] state with VolumeCroppingTool (added to the
  // VR group). With setToolEnabled the lines are visible (and the operator
  // can drag them when the toolbar's "Crop" mode is active — the active/
  // passive switch happens at the call site in PACSViewer). Wrapped in a
  // try so unit tests with the CS3D mock don't fail if the tool name
  // isn't registered (the mock doesn't ship VolumeCropping).
  try {
    group.addTool(cornerstoneTools.VolumeCroppingControlTool.toolName);
    group.setToolEnabled(cornerstoneTools.VolumeCroppingControlTool.toolName);
  } catch (err) {
    console.warn('[PACS] volume cropping control enable failed:', err);
  }

  // ── LiverRa delta: SegmentationDisplay overlay (labelmap rendering) ──
  try {
    group.addTool('SegmentationDisplay');
    group.setToolEnabled('SegmentationDisplay');
  } catch (err) {
    // CS3D 2.x+ folds this into the segmentation state helper; not fatal.
    silentLog('cornerstoneInit', 'segmentationDisplayEnable', err);
  }

  // ── LiverRa delta: default touch bindings (plan §Mobile & touch) ────────
  // These coexist with mouse bindings: a tool can be bound to BOTH a
  // mouseButton and a numTouchPoints tuple simultaneously. Pinned here so
  // the gestures work regardless of which "active tool" is selected.
  try {
    // Pinch = Zoom (two-finger pinch in/out)
    group.setToolActive('Zoom', { bindings: [touchBinding(2)] });
  } catch (err) {
    silentLog('cornerstoneInit', 'touchZoom', err);
  }
  try {
    // Single-finger drag = Pan (slide the image around). The active primary
    // tool re-claims 1-finger in activateToolOnGroup; this is the neutral
    // pre-activation default.
    group.setToolActive('Pan', { bindings: [touchBinding(1)] });
  } catch (err) {
    silentLog('cornerstoneInit', 'touchPan', err);
  }
  try {
    // 3-finger drag = WindowLevel (contrast by vertical drag) — 3 points
    // avoids colliding with the 2-finger pinch binding.
    group.setToolActive('WindowLevel', { bindings: [touchBinding(3)] });
  } catch (err) {
    silentLog('cornerstoneInit', 'touchWindowLevel', err);
  }
  try {
    // TrackballRotate registered Passive; enable3DRotateGesture() activates
    // the two-finger rotate on 3D viewports only.
    group.setToolPassive('TrackballRotate');
  } catch (err) {
    silentLog('cornerstoneInit', 'touchTrackball', err);
  }

  toolGroup = group;
  return group;
}

/**
 * (LiverRa delta) Enable TrackballRotate with a two-finger rotate gesture on
 * a given 3D viewport (call after the 3D viewport is created and added to
 * the shared group). Kept separate from the default gesture bindings because
 * TrackballRotate only makes sense on volume viewports — applying it to 2D
 * axial/coronal/sagittal viewports produces jarring "free rotation".
 */
export function enable3DRotateGesture(): void {
  const group = getOrCreateToolGroup();
  try {
    group.setToolActive('TrackballRotate', {
      bindings: [touchBinding(2)],
    });
  } catch (err) {
    silentLog('cornerstoneInit', 'enable3DRotateGesture', err);
  }
}

/**
 * Unique ID for the VR (VOLUME_3D) tool group — separate from the MPR
 * tool group so 3D rotation never accidentally binds to a 2D slice viewport.
 */
export const VR_TOOL_GROUP_ID = 'liverra-pacs-vr-toolgroup';

/**
 * Get or create the VR-only tool group used by VOLUME_3D viewports.
 *
 * Mouse bindings:
 *   - Left drag → TrackballRotate (the headline 3D interaction)
 *   - Right drag → Zoom (drag up = zoom in)
 *   - Mouse wheel → Zoom (universal "get closer" gesture)
 *   - Middle drag → Pan
 *
 * This is intentionally a parallel tool group to TOOL_GROUP_ID. The MPR
 * group binds Crosshairs to LMB; if we'd added TrackballRotate there it
 * would either steal the LMB on MPR (breaks crosshair navigation) or
 * never fire (loses to Crosshairs). Two groups, no conflict.
 */
export function getOrCreateVrToolGroup(): cornerstoneTools.Types.IToolGroup {
  const existing = cornerstoneTools.ToolGroupManager.getToolGroup(VR_TOOL_GROUP_ID);
  if (existing) return existing;

  const group = cornerstoneTools.ToolGroupManager.createToolGroup(VR_TOOL_GROUP_ID);
  if (!group) {
    throw new Error('Failed to create VR ToolGroup');
  }

  const TR = cornerstoneTools.TrackballRotateTool.toolName;
  const ZM = cornerstoneTools.ZoomTool.toolName;
  const PN = cornerstoneTools.PanTool.toolName;
  group.addTool(TR);
  group.addTool(ZM);
  group.addTool(PN);

  const MB = cornerstoneTools.Enums.MouseBindings;
  // Primary (left drag) → rotate
  group.setToolActive(TR, { bindings: [{ mouseButton: MB.Primary }] });
  // Secondary (right drag) → zoom. Wheel-to-zoom on VOLUME_3D works via
  // VTK's default vtkRenderWindowInteractor (always on) — no extra binding
  // needed and binding `MouseBindings.Wheel` here would either no-op or
  // throw on versions that lack the enum value.
  group.setToolActive(ZM, { bindings: [{ mouseButton: MB.Secondary }] });
  // Auxiliary (middle drag) → pan
  group.setToolActive(PN, { bindings: [{ mouseButton: MB.Auxiliary }] });

  // ── Advanced VR tools (Wave 1 of the 3mensio-grade VR upgrade) ──────────
  // VolumeCroppingTool: handles (6 face + 8 corner spheres + 12 edge lines)
  // are visible on the 3D pane when this tool is at least `enabled`. The
  // active/passive switch — which makes LMB drag the handles vs. trackball-
  // rotate — happens at the call site in PACSViewer when the operator
  // toggles between Rotate and Crop mode.
  //
  // OrientationControllerTool: clickable orientation cube rendered in the
  // 3D pane corner. Operator clicks A/P/L/R/S/I to snap the camera.
  // setToolEnabled means it renders + responds to clicks but never claims
  // a global mouse binding — perfect for an always-visible widget.
  try {
    const VC = cornerstoneTools.VolumeCroppingTool.toolName;
    group.addTool(VC);
    group.setToolEnabled(VC);
  } catch (err) {
    silentLog('cornerstoneInit', 'enableVolumeCropping', err);
  }
  try {
    const OC = cornerstoneTools.OrientationControllerTool.toolName;
    group.addTool(OC);
    group.setToolEnabled(OC);
  } catch (err) {
    silentLog('cornerstoneInit', 'enableOrientationController', err);
  }

  return group;
}

/**
 * Switch the active tool — deactivates the current tool and activates the new one.
 * The active tool is the one that responds to left-click drag on the viewport.
 *
 * @param toolName - The tool to activate (e.g., 'Zoom', 'Pan', 'Length')
 * @param opts.keepCrosshairsPassive - When true, and the active tool is
 *   NOT Crosshairs, leave Crosshairs in PASSIVE mode (visible + its
 *   handles draggable) instead of fully disabled. Lets the MPR crosshair
 *   coexist with another LMB tool (e.g. the Brush in TAVI Step 3). ONLY
 *   pass this from layouts with ≥2 viewports — CrosshairsTool's mouse
 *   handlers crash on <2-viewport layouts (the reason the default still
 *   disables it). Omitting opts preserves the exact prior behavior, so
 *   every other caller (incl. the Feature-044 PACS viewer) is unaffected.
 * @param opts.toolGroup - (LiverRa case-viewer uplift) target a specific tool
 *   group instead of the shared one. The case viewer drives its own
 *   liverra-cases-axial / liverra-mpr-toolgroup so its tool state never leaks
 *   into the shared PACS group. Omitting it preserves prior behavior (shared
 *   group), so every existing caller is unaffected.
 */
export function activateToolOnGroup(
  toolName: string,
  opts?: { keepCrosshairsPassive?: boolean; toolGroup?: cornerstoneTools.Types.IToolGroup }
): void {
  const group = opts?.toolGroup ?? getOrCreateToolGroup();
  const groupId = (group as unknown as { id?: string }).id ?? TOOL_GROUP_ID;
  const cs3dName = getCS3DToolName(toolName);
  const keepCrosshairsPassive = opts?.keepCrosshairsPassive === true;

  // Perf: skip the full tool-group rebuild when the requested tool (and its
  // crosshair-passive variant) is already the active primary tool. This makes
  // rapid TAVI toolbar / brush-erase clicking a true no-op instead of looping
  // ~20 tools + re-binding navigation on every click. `getOrCreateToolGroup`
  // above resets the cache to null whenever a fresh group was created, so a
  // first activation after (re)mount always runs in full. Callers that change
  // the primary binding by other means (marker-place, viewport reconfiguration)
  // call `invalidateActiveToolCache()` so this guard cannot mask them.
  const requestedKey = `${cs3dName}|${keepCrosshairsPassive}`;
  if (requestedKey === activePrimaryToolKeyByGroup.get(groupId)) {
    return;
  }

  // ── Targeted tool switch (perf, 2026-05-29) ─────────────────────────────
  // Cornerstone fires `_renderViewports()` (ALL MPR panes) + an event on EVERY
  // setToolActive/Passive/Disabled, with NO no-op guard (verified in
  // @cornerstonejs/tools ToolGroup.js). The old path re-flipped all 23 TOOL_MAP
  // tools + re-bound the 3 nav tools on every click → ~31 wasted renders/events
  // per click → multi-second freeze on a large (degraded) volume. Instead we
  // touch ONLY what actually changes: (A) demote whichever tool currently owns
  // the Primary (LMB) binding, (B) fix Crosshairs to its required non-active
  // state, (C) activate the target, (D) (re)bind nav buttons only when not
  // already bound. Behavior-preserving (every skipped call would be a no-op);
  // a steady-state switch drops from ~31 setTool* calls to ~3.
  const { MouseBindings } = cornerstoneTools.Enums;
  const PRIMARY_BTN = MouseBindings.Primary;
  // Overlay tools stay Enabled; nav tools' permanent Secondary/Auxiliary/Wheel
  // bindings are managed in Step D (never demoted in Step A).
  const ALWAYS_ON_TOOLS = new Set(['OrientationMarker', 'ScaleOverlay']);
  const NAV_TOOLS = new Set(['Zoom', 'Pan', 'StackScroll']);
  const rawToolOptions = (group as unknown as { toolOptions?: unknown }).toolOptions;
  const toolOptions: Record<string, unknown> = isRecord(rawToolOptions) ? rawToolOptions : {};

  // Re-assert ScaleOverlay now that viewports may exist. getOrCreateToolGroup
  // skips enabling it at group creation (0 viewports → ScaleOverlay._init crashes
  // destructuring enabledElements[0]); this runs after the panes register, so it
  // turns the overlay on at the right time. Idempotent — skip if already Enabled.
  {
    const vpCount = getToolGroupViewportIds(group).length;
    const soMode = isRecord(toolOptions['ScaleOverlay']) ? toolOptions['ScaleOverlay'].mode : undefined;
    if (vpCount >= 1 && soMode !== 'Enabled') {
      try { group.setToolEnabled('ScaleOverlay'); } catch (err) { silentLog('cornerstoneInit', 'scaleOverlayReassert', err); }
    }
  }
  const ownsPrimaryActive = (opts: unknown): boolean => {
    if (!isRecord(opts) || opts.mode !== 'Active') return false;
    const bindings = Array.isArray(opts.bindings) ? opts.bindings : [];
    return bindings.some((b) => isRecord(b) && b.mouseButton === PRIMARY_BTN);
  };

  // ── A. Demote only the tool(s) that currently own the Primary (LMB) binding
  // (usually exactly one). Iterating `toolOptions` rather than TOOL_MAP also
  // covers Brush (Step 3) and MarkerPlace (steps 4-7) — both live in toolOptions
  // but not TOOL_MAP, so the old loop never demoted them. Crosshairs and nav
  // tools are intentionally excluded here (handled in Steps B and D).
  for (const name of Object.keys(toolOptions)) {
    if (name === cs3dName) continue;
    if (ALWAYS_ON_TOOLS.has(name)) continue;
    if (name === 'Crosshairs') continue;
    if (NAV_TOOLS.has(name)) continue;
    if (!ownsPrimaryActive(toolOptions[name])) continue;
    try {
      group.setToolPassive(name);
    } catch (err) {
      silentLog('cornerstoneInit', 'demoteTool', err);
    }
  }

  // ── B. Crosshairs → its required non-active state (guarded; skip when already
  // there to avoid a wasted render). On a ≥2-pane MPR with another LMB tool we
  // keep it PASSIVE (reference lines visible, handles draggable); otherwise it
  // MUST be DISABLED — its mouseMove handler reads viewportsInfo.length and
  // crashes on <2-viewport layouts (the TAVI step-3 regression). When the
  // target IS Crosshairs ('navigate'), Step C activates it on Primary instead.
  // (Brush/MarkerPlace, if they owned Primary, were already demoted in Step A.)
  if (cs3dName !== 'Crosshairs') {
    // 2026-05-30 crash fix: Passive Crosshairs keeps a mouseMove listener whose
    // callback reads `viewportsInfo.length` — it throws (uncaught) on every
    // mousemove when <2 viewports are actually registered, killing the renderer.
    // The caller's `keepCrosshairsPassive` is derived from the LAYOUT's intended
    // pane count, but during the Step 7→8 / post-refresh mount the viewports are
    // added to the group AFTER this runs, so the real count can still be <2.
    // Gate on the group's ACTUAL registered viewports, not the caller's intent;
    // TaviViewportGrid re-runs activateToolOnGroup once the panes finish
    // registering (invalidateActiveToolCache) so Crosshairs is promoted back to
    // Passive then.
    const liveViewportCount = getToolGroupViewportIds(group).length;
    const canKeepPassive = keepCrosshairsPassive && liveViewportCount >= 2;
    const chOpts = toolOptions['Crosshairs'];
    const chMode = isRecord(chOpts) ? chOpts.mode : undefined;
    try {
      if (canKeepPassive) {
        if (chMode !== 'Passive') group.setToolPassive('Crosshairs');
      } else if (chMode !== 'Disabled') {
        group.setToolDisabled('Crosshairs');
      }
    } catch (err) {
      silentLog('cornerstoneInit', 'crosshairsState', err);
    }
  }

  // Activate the requested tool on left mouse button.
  //
  // CRITICAL: Cornerstone3D's `setToolActive` does NOT replace an existing
  // binding when the tool is currently Passive — it merges, and the old
  // binding wins. So a tool that was previously Active on (e.g.) RMB via
  // the permanent navigation row below stays on RMB even when we ask for
  // it on LMB, leaving the user's LMB click unbound. `setToolDisabled`
  // CLEARS the binding completely; the subsequent `setToolActive` then
  // installs the requested binding fresh.
  // Symptom this fixes: the TAVI Toolbar Zoom/Pan/W-L pills appeared to
  // "do nothing" — clicking them moved the mode pill UI but the actual
  // LMB drag was still consumed by Brush (Step 3) / nothing.
  try {
    group.setToolDisabled(cs3dName);
  } catch (err) {
    silentLog('cornerstoneInit', 'preActivateDisable', err);
  }
  try {
    group.setToolActive(cs3dName, {
      bindings: [
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary },
        // LiverRa delta: the primary tool also claims 1-finger touch so
        // tap/drag drives it on tablets (plan §Mobile & touch strategy).
        touchBinding(1),
      ],
    });
  } catch {
    // Fall back to WindowLevel if the tool doesn't exist
    try {
      group.setToolDisabled('WindowLevel');
    } catch (err) {
      silentLog('cornerstoneInit', 'fallbackDisable', err);
    }
    try {
      group.setToolActive('WindowLevel', {
        bindings: [
          { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary },
          touchBinding(3),
        ],
      });
    } catch (err) {
      console.warn('[cornerstoneInit] best-effort PACS operation failed:', err);
      // ToolGroup is broken — nothing we can do
    }
  }

  // ── D. Permanent navigation bindings — RMB→Zoom, MMB→Pan, Wheel→StackScroll.
  // They survive every switch because Step A never demotes nav tools and
  // setToolPassive keeps non-Primary bindings — so (re)bind a nav tool ONLY
  // when it does not already own its button in Active mode, OR it still holds
  // Primary (e.g. StackScroll right after group creation, or a nav tool that
  // was the previous LMB target). Skipping the common already-bound case avoids
  // ~6 wasted setTool* calls per click. The tool that IS the LMB target is
  // skipped (it owns Primary now and regains its nav button on the next switch
  // — unchanged prior behavior). The disable-before-activate handles the
  // binding-merge quirk for the tools we do (re)bind.
  const navBindings: Array<[string, number]> = [
    ['Zoom', MouseBindings.Secondary],
    ['Pan', MouseBindings.Auxiliary],
    ['StackScroll', MouseBindings.Wheel],
  ];
  for (const [navTool, button] of navBindings) {
    if (cs3dName === navTool) continue;
    const opts = toolOptions[navTool];
    const bindings = isRecord(opts) && Array.isArray(opts.bindings) ? opts.bindings : [];
    const alreadyBound =
      isRecord(opts) &&
      opts.mode === 'Active' &&
      bindings.some((b) => isRecord(b) && b.mouseButton === button) &&
      !bindings.some((b) => isRecord(b) && b.mouseButton === PRIMARY_BTN);
    if (alreadyBound) continue;
    try {
      group.setToolDisabled(navTool);
    } catch (err) {
      silentLog('cornerstoneInit', `navBinding-disable-${navTool}`, err);
    }
    try {
      // LiverRa delta: Zoom keeps its pinch gesture alongside the RMB
      // binding so two-finger pinch-zoom always works on tablets.
      const navTouch = navTool === 'Zoom' ? [touchBinding(2)] : [];
      group.setToolActive(navTool, {
        bindings: [{ mouseButton: button }, ...navTouch],
      });
    } catch (err) {
      silentLog('cornerstoneInit', `navBinding-${navTool}`, err);
      // Tool may not be registered (unlikely — TOOL_MAP contains all three)
    }
  }

  // LiverRa delta: re-assert the sticky 3-finger WindowLevel gesture when
  // some other tool took the primary binding (W/L by touch must always be
  // reachable on tablets). Skipped when WindowLevel IS the primary tool —
  // it already holds Primary + touch(1) from Step C.
  if (cs3dName !== 'WindowLevel') {
    const wlOpts = toolOptions['WindowLevel'];
    const wlBindings = isRecord(wlOpts) && Array.isArray(wlOpts.bindings) ? wlOpts.bindings : [];
    const wlHasTouch3 = wlBindings.some(
      (b) => isRecord(b) && (b as { numTouchPoints?: number }).numTouchPoints === 3
    );
    if (!wlHasTouch3) {
      try {
        group.setToolActive('WindowLevel', { bindings: [touchBinding(3)] });
      } catch (err) {
        silentLog('cornerstoneInit', 'stickyWindowLevelTouch', err);
      }
    }
  }

  // Remember what we just activated so an identical follow-up request (rapid
  // re-click, effect re-run, Brush↔Erase) short-circuits at the top of this fn.
  activePrimaryToolKeyByGroup.set(groupId, requestedKey);
}

// ============================================================================
// Per-Annotation Visibility & Locking
// ============================================================================
// Cornerstone3D annotations have `isVisible` and `isLocked` fields.
// Toggling visibility hides/shows the annotation drawing on the viewport.
// Toggling lock prevents the annotation from being moved or edited.
// Think of visibility as "ghosting" the annotation, and locking as "pinning" it.
// ============================================================================

/**
 * Toggle an annotation's visibility on the viewport.
 * Hidden annotations are still stored — they just aren't drawn.
 *
 * @param annotationUID - The unique annotation ID from Cornerstone3D
 * @returns The new visibility state, or null if annotation not found
 */
export function toggleAnnotationVisibility(annotationUID: string): boolean | null {
  try {
    const ann = cornerstoneTools.annotation.state.getAnnotation(annotationUID);
    if (!ann) {
      return null;
    }
    ann.isVisible = ann.isVisible === false ? true : false;

    // Re-render all viewports so the change takes effect
    renderingEngine?.renderViewports(
      renderingEngine.getViewports().map((vp) => vp.id)
    );

    return ann.isVisible;
  } catch (err) {
    silentLog('cornerstoneInit', 'toggleAnnotationVisibility', err);
    return null;
  }
}

/**
 * Toggle an annotation's lock state.
 * Locked annotations can't be moved, resized, or deleted by the user.
 *
 * @param annotationUID - The unique annotation ID from Cornerstone3D
 * @returns The new lock state, or null if annotation not found
 */
export function toggleAnnotationLock(annotationUID: string): boolean | null {
  try {
    const ann = cornerstoneTools.annotation.state.getAnnotation(annotationUID);
    if (!ann) {
      return null;
    }
    ann.isLocked = !ann.isLocked;

    // Re-render so lock indicators update on the viewport
    renderingEngine?.renderViewports(
      renderingEngine.getViewports().map((vp) => vp.id)
    );

    return ann.isLocked;
  } catch (err) {
    silentLog('cornerstoneInit', 'toggleAnnotationLock', err);
    return null;
  }
}

// ============================================================================
// Cancel In-Progress Annotations
// ============================================================================
// When a user is mid-draw (e.g., placed first point of a Length tool but hasn't
// placed the second), pressing Escape should discard that incomplete annotation.
// Think of it like pressing Escape while dragging a file — cancels the operation.
// ============================================================================

/**
 * Cancel any in-progress (incomplete) annotation on the active viewport.
 *
 * This works by finding the viewport's DOM element and dispatching a
 * cancelActiveManipulations call, which tells Cornerstone3D to remove
 * any annotation that hasn't been completed yet.
 *
 * @returns true if a cancel was attempted, false if no viewport was found
 */
export function cancelActiveAnnotation(): boolean {
  try {
    if (!renderingEngine || renderingEngine.hasBeenDestroyed) {
      return false;
    }

    const viewports = renderingEngine.getViewports();
    if (viewports.length === 0) {
      return false;
    }

    // Cancel on all viewports — safe because only one can have an active draw
    for (const viewport of viewports) {
      const element = viewport.element;
      if (element) {
        cornerstoneTools.cancelActiveManipulations(element);
      }
    }

    // Re-render to clear any partial drawing artifacts
    renderingEngine.renderViewports(viewports.map((vp) => vp.id));

    return true;
  } catch (err) {
    silentLog('cornerstoneInit', 'cancelActiveAnnotation', err);
    return false;
  }
}

const CALIBRATION_POLL_SESSION_GAP_MS = 1500;
let calibrationBaselineLengthUids: Set<string> | null = null;
let activeCalibrationLengthUid: string | null = null;
let lastCalibrationLengthPollAt = 0;

interface ViewportWithPixelTransform {
  id?: string;
  worldToCanvas?: (point: [number, number, number]) => unknown;
  getCurrentImageId?: () => string | undefined;
  getFrameOfReferenceUID?: () => string | undefined;
}

function getLengthAnnotationUid(annotation: CornerstoneAnnotation, index: number): string {
  return annotation.annotationUID || `length-index-${index}`;
}

function isVisibleLengthAnnotation(value: unknown): value is CornerstoneAnnotation {
  const ann = value as CornerstoneAnnotation;
  return ann.metadata?.toolName === 'Length' && ann.isVisible !== false;
}

function pointToNumbers(point: unknown): [number, number, number] | null {
  if (Array.isArray(point)) {
    const [x, y, z = 0] = point;
    return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? [x, y, z] : null;
  }
  if (isRecord(point)) {
    const x = point.x;
    const y = point.y;
    const z = point.z ?? 0;
    return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? [x, y, z] : null;
  }
  return null;
}

function pointToCanvasNumbers(point: unknown): [number, number] | null {
  if (Array.isArray(point)) {
    const [x, y] = point;
    return typeof x === 'number' && typeof y === 'number' ? [x, y] : null;
  }
  if (isRecord(point)) {
    const x = point.x;
    const y = point.y;
    return typeof x === 'number' && typeof y === 'number' ? [x, y] : null;
  }
  return null;
}

function getAnnotationMetadataString(annotation: CornerstoneAnnotation, ...keys: string[]): string | undefined {
  const metadata = annotation.metadata as Record<string, unknown> | undefined;
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function viewportMatchesAnnotation(viewport: ViewportWithPixelTransform, annotation: CornerstoneAnnotation): boolean {
  const annotationViewportId = getAnnotationMetadataString(annotation, 'viewportId');
  if (annotationViewportId && viewport.id && viewport.id !== annotationViewportId) {
    return false;
  }

  const annotationImageId = getAnnotationMetadataString(annotation, 'referencedImageId', 'imageId');
  const viewportImageId = viewport.getCurrentImageId?.();
  if (annotationImageId && viewportImageId && viewportImageId !== annotationImageId) {
    return false;
  }

  const annotationFrameOfReferenceUid = getAnnotationMetadataString(
    annotation,
    'FrameOfReferenceUID',
    'frameOfReferenceUID'
  );
  const viewportFrameOfReferenceUid = viewport.getFrameOfReferenceUID?.();
  if (
    annotationFrameOfReferenceUid &&
    viewportFrameOfReferenceUid &&
    viewportFrameOfReferenceUid !== annotationFrameOfReferenceUid
  ) {
    return false;
  }

  return true;
}

function getHandlePixelLength(annotation: CornerstoneAnnotation): number | null {
  const points = annotation.data?.handles?.points;
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }
  if (!renderingEngine || renderingEngine.hasBeenDestroyed) {
    return null;
  }

  const p0World = pointToNumbers(points[0]);
  const p1World = pointToNumbers(points[1]);
  if (!p0World || !p1World) {
    return null;
  }

  const viewports = renderingEngine.getViewports().map((viewport) => viewport as ViewportWithPixelTransform);
  for (const viewport of viewports) {
    if (!viewportMatchesAnnotation(viewport, annotation)) {
      continue;
    }

    const imageData = (viewport as {
      getImageData?: () =>
        | {
            imageData?: { worldToIndex?: (point: [number, number, number]) => unknown };
            worldToIndex?: (point: [number, number, number]) => unknown;
          }
        | undefined;
    }).getImageData?.();
    const worldToIndex = imageData?.imageData?.worldToIndex ?? imageData?.worldToIndex;
    if (typeof worldToIndex !== 'function') {
      throw new Error('Stable image-space transform unavailable for Length annotation pixel measurement');
    }
    const p0Index = pointToCanvasNumbers(worldToIndex(p0World));
    const p1Index = pointToCanvasNumbers(worldToIndex(p1World));
    if (!p0Index || !p1Index) {
      throw new Error('Length annotation image-space transform returned invalid coordinates');
    }

    const dx = p1Index[0] - p0Index[0];
    const dy = p1Index[1] - p0Index[1];
    const length = Math.sqrt(dx * dx + dy * dy);
    if (Number.isFinite(length) && length > 0) {
      return length;
    }
  }

  return null;
}

function getLengthAnnotationPixels(annotation: CornerstoneAnnotation): number | null {
  const cachedStats = annotation.data?.cachedStats;
  if (cachedStats) {
    const statsValues = Object.values(cachedStats);
    for (const stats of statsValues) {
      const unit = stats.unit?.trim().toLowerCase();
      if (unit !== 'px' && unit !== 'pixel' && unit !== 'pixels') {
        continue;
      }
      if (typeof stats.length === 'number' && stats.length > 0) {
        return stats.length;
      }
    }
  }
  return getHandlePixelLength(annotation);
}

function markCalibrationLengthAnnotation(annotation: CornerstoneAnnotation): void {
  annotation.metadata ??= {};
  annotation.metadata.purpose = 'calibration';
  annotation.metadata.calibrationPurpose = 'catheter';
  annotation.data ??= {};
  annotation.data.purpose = 'calibration';
  annotation.data.calibrationPurpose = 'catheter';
}

interface StenosisImageIdentity {
  imageId?: string;
  viewportId?: string;
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  frameNumber?: string;
  frameOfReferenceUID?: string;
}

function parseWadoImageIdentity(imageId: string | undefined): Partial<StenosisImageIdentity> {
  if (!imageId) {
    return {};
  }
  const match = imageId.match(/(?:\/studies\/([^/?#]+))?\/series\/([^/?#]+)\/instances\/([^/?#]+)(?:\/frames\/([^/?#]+))?/);
  return {
    studyInstanceUID: match?.[1] ? decodeURIComponent(match[1]) : undefined,
    seriesInstanceUID: match?.[2] ? decodeURIComponent(match[2]) : undefined,
    sopInstanceUID: match?.[3] ? decodeURIComponent(match[3]) : undefined,
    frameNumber: match?.[4],
  };
}

function readMetadataString(imageId: string, moduleTypes: string[], keys: string[]): string | undefined {
  const metadata = cornerstone.metaData as { get?: (type: string, imageId: string) => unknown };
  for (const moduleType of moduleTypes) {
    try {
      const value = metadata.get?.(moduleType, imageId);
      if (!isRecord(value)) {
        continue;
      }
      for (const key of keys) {
        const candidate = value[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim();
        }
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
          return String(candidate);
        }
      }
    } catch (err) {
      silentLog('cornerstoneInit', 'readStenosisMetadata', err);
    }
  }
  return undefined;
}

function getViewportCurrentImageId(viewport: unknown): string | undefined {
  if (!isRecord(viewport)) {
    return undefined;
  }
  const getCurrentImageId = viewport.getCurrentImageId;
  if (typeof getCurrentImageId === 'function') {
    const imageId = getCurrentImageId.call(viewport);
    if (typeof imageId === 'string' && imageId) {
      return imageId;
    }
  }
  const getImageIds = viewport.getImageIds;
  if (typeof getImageIds === 'function') {
    const imageIds = getImageIds.call(viewport);
    if (Array.isArray(imageIds) && imageIds.every((id) => typeof id === 'string')) {
      const getCurrentImageIdIndex = viewport.getCurrentImageIdIndex;
      const index = typeof getCurrentImageIdIndex === 'function' ? getCurrentImageIdIndex.call(viewport) : 0;
      return imageIds[typeof index === 'number' && index >= 0 ? index : 0];
    }
  }
  return undefined;
}

function getActiveStenosisImageIdentity(): StenosisImageIdentity | null {
  const engine = renderingEngine && !renderingEngine.hasBeenDestroyed ? renderingEngine : null;
  const viewports = engine?.getViewports?.() ?? [];
  if (!engine || viewports.length === 0) {
    return null;
  }
  const activeElement = typeof document !== 'undefined'
    ? document.querySelector('.pacs-viewport-cell[data-active="true"] .pacs-viewport-canvas')
    : null;
  const activeViewportElement = activeElement as HTMLElement | null;
  const activeViewportId = activeViewportElement
    ? activeViewportElement.dataset.viewportId || activeViewportElement.id.replace(/^cs3d-/, '')
    : undefined;
  const viewport =
    (activeViewportId ? engine.getViewport(activeViewportId) : undefined) ??
    (viewports.length === 1 ? viewports[0] : undefined);
  if (!viewport) {
    return null;
  }
  const viewportId = (viewport as { id?: string }).id ?? activeViewportId;
  const imageId = getViewportCurrentImageId(viewport);
  if (!imageId) {
    return null;
  }
  const parsed = parseWadoImageIdentity(imageId);
  return {
    imageId,
    viewportId,
    studyInstanceUID: readMetadataString(imageId, ['generalStudyModule', 'StudyData', 'ImageData'], ['StudyInstanceUID', 'studyInstanceUID']) ?? parsed.studyInstanceUID,
    seriesInstanceUID: readMetadataString(imageId, ['generalSeriesModule', 'SeriesData', 'ImageData'], ['SeriesInstanceUID', 'seriesInstanceUID']) ?? parsed.seriesInstanceUID,
    sopInstanceUID: readMetadataString(imageId, ['sopCommonModule', 'ImageData', 'instance'], ['SOPInstanceUID', 'sopInstanceUID']) ?? parsed.sopInstanceUID,
    frameNumber: readMetadataString(imageId, ['ImageData', 'instance'], ['FrameNumber', 'frameNumber']) ?? parsed.frameNumber,
    frameOfReferenceUID: readMetadataString(imageId, ['frameOfReferenceModule', 'imagePlaneModule', 'ImageData'], ['FrameOfReferenceUID', 'frameOfReferenceUID']),
  };
}

function getAnnotationString(annotation: CornerstoneAnnotation, fields: string[]): string | undefined {
  const direct = annotation as unknown as Record<string, unknown>;
  const metadata = annotation.metadata as Record<string, unknown> | undefined;
  const data = annotation.data as Record<string, unknown> | undefined;
  for (const field of fields) {
    const value = direct[field] ?? metadata?.[field] ?? data?.[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function getAnnotationImageIdentity(annotation: CornerstoneAnnotation): StenosisImageIdentity {
  const imageId = getAnnotationString(annotation, ['referencedImageId', 'imageId']);
  const parsed = parseWadoImageIdentity(imageId);
  return {
    imageId,
    viewportId: getAnnotationString(annotation, ['viewportId']),
    studyInstanceUID: getAnnotationString(annotation, ['StudyInstanceUID', 'studyInstanceUID', 'studyInstanceUid']) ?? parsed.studyInstanceUID,
    seriesInstanceUID: getAnnotationString(annotation, ['SeriesInstanceUID', 'seriesInstanceUID', 'seriesInstanceUid']) ?? parsed.seriesInstanceUID,
    sopInstanceUID: getAnnotationString(annotation, ['SOPInstanceUID', 'sopInstanceUID', 'sopInstanceUid']) ?? parsed.sopInstanceUID,
    frameNumber: getAnnotationString(annotation, ['FrameNumber', 'frameNumber']) ?? parsed.frameNumber,
    frameOfReferenceUID: getAnnotationString(annotation, ['FrameOfReferenceUID', 'frameOfReferenceUID']),
  };
}

function stenosisIdentityKey(identity: StenosisImageIdentity): string | undefined {
  if (identity.studyInstanceUID && identity.seriesInstanceUID && identity.sopInstanceUID) {
    return [
      identity.studyInstanceUID,
      identity.seriesInstanceUID,
      identity.sopInstanceUID,
      identity.frameNumber ?? '',
    ].join('|');
  }
  return identity.imageId ? `image:${identity.imageId}` : undefined;
}

function getStenosisCalibrationKey(annotation: CornerstoneAnnotation): string {
  const explicit = getAnnotationString(annotation, ['calibrationId', 'calibrationUID', 'calibrationUid']);
  if (explicit) {
    return explicit;
  }
  const units = annotation.data?.cachedStats
    ? Object.values(annotation.data.cachedStats).map((stats) => stats.unit?.trim().toLowerCase() || 'px').sort().join(',')
    : 'px';
  return `units:${units}`;
}

function stampStenosisAnnotation(annotation: CornerstoneAnnotation, identity: StenosisImageIdentity): void {
  annotation.metadata ??= {};
  annotation.metadata.purpose = 'stenosis';
  if (identity.imageId) {
    annotation.metadata.referencedImageId = identity.imageId;
  }
  if (identity.viewportId) {
    annotation.metadata.viewportId = identity.viewportId;
  }
  if (identity.studyInstanceUID) {
    annotation.metadata.StudyInstanceUID = identity.studyInstanceUID;
  }
  if (identity.seriesInstanceUID) {
    annotation.metadata.SeriesInstanceUID = identity.seriesInstanceUID;
  }
  if (identity.sopInstanceUID) {
    annotation.metadata.SOPInstanceUID = identity.sopInstanceUID;
  }
  if (identity.frameOfReferenceUID) {
    annotation.metadata.FrameOfReferenceUID = identity.frameOfReferenceUID;
  }
  if (identity.frameNumber) {
    annotation.metadata.frameNumber = identity.frameNumber;
  }
  annotation.data ??= {};
  annotation.data.purpose = 'stenosis';
  if (identity.imageId) {
    annotation.data.referencedImageId = identity.imageId;
  }
  if (identity.viewportId) {
    annotation.data.viewportId = identity.viewportId;
  }
  if (identity.studyInstanceUID) {
    annotation.data.StudyInstanceUID = identity.studyInstanceUID;
  }
  if (identity.seriesInstanceUID) {
    annotation.data.SeriesInstanceUID = identity.seriesInstanceUID;
  }
  if (identity.sopInstanceUID) {
    annotation.data.SOPInstanceUID = identity.sopInstanceUID;
  }
  if (identity.frameOfReferenceUID) {
    annotation.data.FrameOfReferenceUID = identity.frameOfReferenceUID;
  }
  if (identity.frameNumber) {
    annotation.data.frameNumber = identity.frameNumber;
  }
}

function isCalibrationLengthAnnotation(annotation: CornerstoneAnnotation): boolean {
  const metadataPurpose = annotation.metadata?.purpose?.toLowerCase();
  const dataPurpose = annotation.data?.purpose?.toLowerCase();
  const metadataCalibrationPurpose = annotation.metadata?.calibrationPurpose?.toLowerCase();
  const dataCalibrationPurpose = annotation.data?.calibrationPurpose?.toLowerCase();
  return (
    metadataPurpose === 'calibration' ||
    dataPurpose === 'calibration' ||
    metadataCalibrationPurpose === 'catheter' ||
    dataCalibrationPurpose === 'catheter'
  );
}

/**
 * Get the pixel length of the most recent Length annotation in the CS3D state.
 * Used by the calibration workflow to know when the user has finished drawing
 * a line across a catheter.
 *
 * @returns pixel length of the latest Length annotation, or null if none exists
 */
export function getLatestLengthAnnotationPixels(): number | null {
  try {
    const allAnnotations = cornerstoneTools.annotation.state.getAllAnnotations?.() ?? [];
    // Cast: the runtime guard validates the shape, but CS3D's `Annotation`
    // type and our looser `CornerstoneAnnotation` have structurally
    // incompatible `cachedStats` records, so TS can't apply the predicate
    // narrowing through `.filter()`.
    const lengthAnnotations = allAnnotations.filter(
      isVisibleLengthAnnotation
    ) as unknown as CornerstoneAnnotation[];
    if (lengthAnnotations.length === 0) {
      return null;
    }

    const now = Date.now();
    const isNewPollingSession =
      calibrationBaselineLengthUids === null ||
      now - lastCalibrationLengthPollAt > CALIBRATION_POLL_SESSION_GAP_MS;
    lastCalibrationLengthPollAt = now;

    if (isNewPollingSession) {
      calibrationBaselineLengthUids = new Set(
        lengthAnnotations.map((annotation, index) => getLengthAnnotationUid(annotation, index))
      );
      activeCalibrationLengthUid = null;
      return null;
    }

    if (activeCalibrationLengthUid) {
      const active = lengthAnnotations.find(
        (annotation, index) => getLengthAnnotationUid(annotation, index) === activeCalibrationLengthUid
      );
      if (active) {
        return getLengthAnnotationPixels(active);
      }
      activeCalibrationLengthUid = null;
    }

    for (let i = lengthAnnotations.length - 1; i >= 0; i--) {
      const annotation = lengthAnnotations[i];
      const uid = getLengthAnnotationUid(annotation, i);
      if (calibrationBaselineLengthUids?.has(uid)) {
        continue;
      }
      const pixels = getLengthAnnotationPixels(annotation);
      if (pixels !== null) {
        markCalibrationLengthAnnotation(annotation);
        activeCalibrationLengthUid = uid;
        return pixels;
      }
    }
    return null;
  } catch (err) {
    silentLog('cornerstoneInit', 'getLatestLengthAnnotationPixels', err);
    return null;
  }
}

/**
 * Get the pixel lengths of the most recent N Length annotations.
 * Used by the stenosis workflow: first annotation = RVD (reference vessel diameter),
 * second = MLD (minimum lumen diameter).
 *
 * @param count - How many recent annotations to return (e.g., 2 for stenosis)
 * @returns Array of pixel lengths, ordered oldest-to-newest, up to `count` items
 */
export function getRecentLengthAnnotationPixels(count: number): number[] {
  try {
    const activeIdentity = getActiveStenosisImageIdentity();
    const activeKey = activeIdentity ? stenosisIdentityKey(activeIdentity) : undefined;
    if (!activeIdentity || !activeKey) {
      return [];
    }
    const allAnnotations = cornerstoneTools.annotation.state.getAllAnnotations?.() ?? [];
    const lengthAnnotations = allAnnotations.filter(
      (a: unknown) => {
        const ann = a as CornerstoneAnnotation;
        if (ann.metadata?.toolName !== 'Length' || ann.isVisible === false || isCalibrationLengthAnnotation(ann)) {
          return false;
        }
        const purpose = ann.metadata?.purpose ?? ann.data?.purpose;
        if (purpose && purpose !== 'stenosis') {
          return false;
        }
        const identity = getAnnotationImageIdentity(ann);
        if (stenosisIdentityKey(identity) !== activeKey) {
          return false;
        }
        if (
          identity.frameOfReferenceUID &&
          activeIdentity.frameOfReferenceUID &&
          identity.frameOfReferenceUID !== activeIdentity.frameOfReferenceUID
        ) {
          return false;
        }
        stampStenosisAnnotation(ann, activeIdentity);
        return true;
      }
    );
    if (lengthAnnotations.length < count) {
      return [];
    }
    // Take the last N annotations
    const recent = lengthAnnotations.slice(-count);
    if (recent.length >= 2) {
      const [first, second] = recent;
      const firstIdentity = stenosisIdentityKey(getAnnotationImageIdentity(first as CornerstoneAnnotation));
      const secondIdentity = stenosisIdentityKey(getAnnotationImageIdentity(second as CornerstoneAnnotation));
      if (firstIdentity !== activeKey || secondIdentity !== activeKey) {
        return [];
      }
      if (
        getStenosisCalibrationKey(first as CornerstoneAnnotation) !==
        getStenosisCalibrationKey(second as CornerstoneAnnotation)
      ) {
        return [];
      }
    }
    const results: number[] = [];
    for (const ann of recent) {
      const typed = ann as CornerstoneAnnotation;
      const pixels = getLengthAnnotationPixels(typed);
      if (pixels !== null) {
        results.push(pixels);
      }
    }
    return results;
  } catch (err) {
    silentLog('cornerstoneInit', 'getRecentLengthAnnotationPixels', err);
    return [];
  }
}

// ============================================================================
// Annotation Deletion & Restoration
// ============================================================================
// Functions to remove annotations from Cornerstone3D's in-memory state and
// to restore annotations from a JSON snapshot (used by undo/redo).
// ============================================================================

/**
 * Remove the currently selected annotation from the viewport.
 * Think of it like pressing Delete on a selected object in PowerPoint.
 *
 * @returns The UID of the removed annotation, or null if nothing was selected
 */
export function removeSelectedAnnotation(): string | null {
  try {
    const selectedUIDs = cornerstoneTools.annotation.selection.getAnnotationsSelected() ?? [];
    if (selectedUIDs.length === 0) {
      return null;
    }

    // Remove the first selected annotation
    const uid = selectedUIDs[0];
    cornerstoneTools.annotation.state.removeAnnotation(uid);

    // Re-render all viewports so the annotation disappears
    if (renderingEngine && !renderingEngine.hasBeenDestroyed) {
      renderingEngine.renderViewports(
        renderingEngine.getViewports().map((vp) => vp.id)
      );
    }

    return uid;
  } catch (err) {
    silentLog('cornerstoneInit', 'removeSelectedAnnotation', err);
    return null;
  }
}

/**
 * Remove all annotations from Cornerstone3D's in-memory state.
 * Like clicking "Clear All" in a drawing app.
 *
 * @returns Number of annotations removed
 */
/**
 * Find the annotation UID nearest a canvas point on a viewport host element.
 * Used by the right-click context menu to know WHICH measurement was clicked.
 *
 * @param element - the `cs3d-<viewportId>` host div
 * @param canvasX/canvasY - cursor position relative to the element
 * @param proximity - hit radius in px (default 12 — comfortable for handles)
 * @returns the annotationUID under the cursor, or null
 */
export function getAnnotationUidNearPoint(
  element: HTMLDivElement,
  canvasX: number,
  canvasY: number,
  proximity = 12
): string | null {
  try {
    const near = cornerstoneTools.utilities.getAnnotationNearPoint(
      element,
      [canvasX, canvasY],
      proximity
    ) as { annotationUID?: string } | null;
    return near?.annotationUID ?? null;
  } catch (err) {
    silentLog('cornerstoneInit', 'getAnnotationUidNearPoint', err);
    return null;
  }
}

/**
 * Remove a single annotation by its UID and re-render. Returns true on success.
 */
export function removeAnnotationByUid(annotationUID: string): boolean {
  try {
    cornerstoneTools.annotation.state.removeAnnotation(annotationUID);
    if (renderingEngine && !renderingEngine.hasBeenDestroyed) {
      renderingEngine.renderViewports(renderingEngine.getViewports().map((vp) => vp.id));
    }
    return true;
  } catch (err) {
    silentLog('cornerstoneInit', 'removeAnnotationByUid', err);
    return false;
  }
}

/**
 * Read whether an annotation is currently locked / hidden so the context menu
 * can label its toggle correctly. Returns `null` when the annotation is gone.
 */
export function getAnnotationFlags(
  annotationUID: string
): { isLocked: boolean; isVisible: boolean } | null {
  try {
    const ann = cornerstoneTools.annotation.state.getAnnotation(annotationUID) as
      | { isLocked?: boolean; isVisible?: boolean }
      | undefined;
    if (!ann) return null;
    return { isLocked: ann.isLocked === true, isVisible: ann.isVisible !== false };
  } catch (err) {
    silentLog('cornerstoneInit', 'getAnnotationFlags', err);
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

    // Re-render all viewports
    if (renderingEngine && !renderingEngine.hasBeenDestroyed) {
      renderingEngine.renderViewports(
        renderingEngine.getViewports().map((vp) => vp.id)
      );
    }

    return count;
  } catch (err) {
    silentLog('cornerstoneInit', 'removeAllAnnotations', err);
    return 0;
  }
}

/**
 * Restore annotations from a JSON snapshot into Cornerstone3D's in-memory state.
 * Used by undo/redo to visually restore the viewport after changing the saved state.
 *
 * How it works:
 * 1. Clears all current annotations from CS3D state
 * 2. Parses the JSON snapshot
 * 3. Re-adds each annotation to CS3D state
 * 4. Re-renders viewports
 *
 * @param json - The annotation JSON snapshot to restore
 */
export function restoreAnnotationsFromJson(json: string): void {
  try {
    const isAnnotationSnapshot = (value: unknown): value is Record<string, unknown> =>
      isRecord(value) && ('annotationUID' in value || 'metadata' in value || 'data' in value);

    const collectAnnotations = (value: unknown, out: unknown[]): boolean => {
      if (Array.isArray(value)) {
        let found = false;
        for (const ann of value) {
          if (isAnnotationSnapshot(ann)) {
            out.push(ann);
            found = true;
          }
        }
        return found;
      }
      if (!isRecord(value)) {
        return false;
      }
      let found = false;
      for (const child of Object.values(value)) {
        found = collectAnnotations(child, out) || found;
      }
      return found;
    };

    const annotations: unknown[] = [];
    if (json) {
      const parsed = JSON.parse(json);
      if (!collectAnnotations(parsed, annotations) && !(Array.isArray(parsed) && parsed.length === 0)) {
        return;
      }
    }

    // Step 1: Clear all existing annotations after the snapshot is validated
    const existing = cornerstoneTools.annotation.state.getAllAnnotations?.() ?? [];
    for (const ann of existing) {
      const typed = ann as { annotationUID?: string };
      if (typed.annotationUID) {
        cornerstoneTools.annotation.state.removeAnnotation(typed.annotationUID);
      }
    }

    // Step 2: Parse the JSON and re-add annotations
    for (const ann of annotations) {
      if (ann && typeof ann === 'object') {
        cornerstoneTools.annotation.state.addAnnotation(ann);
      }
    }

    // Step 3: Re-render all viewports
    if (renderingEngine && !renderingEngine.hasBeenDestroyed) {
      renderingEngine.renderViewports(
        renderingEngine.getViewports().map((vp) => vp.id)
      );
    }
  } catch (err) {
    silentLog('cornerstoneInit', 'restoreAnnotations', err);
    // Failed to restore — viewport may show stale data until next render
  }
}

/**
 * Get all current annotations as a JSON string.
 * Used to capture the current state for saving after deletions.
 *
 * Calibration helper lines (the Length line drawn across a French catheter to
 * derive mm/px) are NOT clinical measurements and must never be persisted as
 * such — they are filtered out here so the saved FHIR annotation cache only
 * carries real clinical annotations.
 */
export function getCurrentAnnotationsJson(): string {
  try {
    const allAnnotations = cornerstoneTools.annotation.state.getAllAnnotations?.() ?? [];
    const clinicalAnnotations = allAnnotations.filter(
      (ann: unknown) => !isCalibrationLengthAnnotation(ann as CornerstoneAnnotation)
    );
    return JSON.stringify(clinicalAnnotations);
  } catch (err) {
    silentLog('cornerstoneInit', 'getCurrentAnnotationsJson', err);
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

// ---------------------------------------------------------------------------
// Affine math (private to this module — used by createLabelmapFromNifti).
// ---------------------------------------------------------------------------

/** Invert a 4×4 affine matrix whose last row is `[0,0,0,1]`.
 *  `[R t; 0 1]^-1 = [R^-1   -R^-1·t; 0 1]`. Returns null if the 3×3 is singular. */
function invert4x4Affine(m: number[][]): number[][] | null {
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  // Cofactor / adjugate inverse for the rotation/scale 3×3.
  const i00 = (e * i - f * h) * invDet;
  const i01 = (c * h - b * i) * invDet;
  const i02 = (b * f - c * e) * invDet;
  const i10 = (f * g - d * i) * invDet;
  const i11 = (a * i - c * g) * invDet;
  const i12 = (c * d - a * f) * invDet;
  const i20 = (d * h - e * g) * invDet;
  const i21 = (b * g - a * h) * invDet;
  const i22 = (a * e - b * d) * invDet;
  // Translation: -R^-1 · t.
  const tx = m[0][3], ty = m[1][3], tz = m[2][3];
  return [
    [i00, i01, i02, -(i00 * tx + i01 * ty + i02 * tz)],
    [i10, i11, i12, -(i10 * tx + i11 * ty + i12 * tz)],
    [i20, i21, i22, -(i20 * tx + i21 * ty + i22 * tz)],
    [0, 0, 0, 1],
  ];
}

/** Apply the rotation/scale part of a 4×4 affine to a 3-vector (no translation). */
function mat3VecApply(m: number[][], v: ArrayLike<number>): [number, number, number] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** Apply a full 4×4 affine to a 3-point (treating the point as homogeneous w=1). */
function applyAffinePoint(m: number[][], p: ArrayLike<number>): [number, number, number] {
  return [
    m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3],
    m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3],
    m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3],
  ];
}

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
      // CS3D 4.x — the live underlying buffer. Writes here are visible
      // to the renderer immediately. Returned by getScalarData(), and also
      // exposed as the `scalarData` property on the VM instance.
      getScalarData?: () => Uint8Array;
      scalarData?: Uint8Array;
      // Snapshot-only methods that return a COPY (verified empirically:
      // writes to the returned array are NOT visible to the VM). Kept here
      // only as a fallback for hypothetical older minor versions.
      getCompleteScalarDataArray?: () => ArrayLike<number>;
      setCompleteScalarDataArray?: (data: ArrayLike<number>) => void;
      setScalarData?: (data: ArrayLike<number>) => void;
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

  // CS3D 4.21.x VoxelManager API for derived labelmap volumes (verified
  // empirically via Playwright on 2026-05-11):
  //   1. createAndCacheDerivedLabelmapVolume() builds a per-slice voxel
  //      manager backed by N derived images (one per CT slice). The GPU
  //      reads from those PER-IMAGE buffers via vtkSharedVolumeMapper.
  //   2. getCompleteScalarDataArray() ALLOCATES a fresh aggregated Uint8Array
  //      and copies the per-image buffers into it. Writes to this snapshot
  //      do NOT auto-flow back to the per-image buffers.
  //   3. setCompleteScalarDataArray(arr) IS the correct commit — it walks
  //      each slice and writes arr.subarray(sliceStart..sliceEnd) into the
  //      corresponding image's voxelManager.scalarData (and marks
  //      modifiedSlices). This is what the GPU eventually sees.
  //   4. setScalarData(arr) IS A TRAP for derived labelmaps — it only sets
  //      vm.scalarData on the TOP-LEVEL voxel manager (a property unused by
  //      the renderer); the per-image buffers stay zero, so the labelmap
  //      remains invisible. Earlier code path used setScalarData and shipped
  //      "fixed" labelmaps with all-zero per-image data — overlays never
  //      painted on the CT despite getScalarData() returning the right blob.
  // Pattern: get snapshot → write → setCompleteScalarDataArray → fire
  // SegmentationDataModified.
  const rawScalar = voxelManager?.getCompleteScalarDataArray?.();
  if (!rawScalar) {
    throw new Error(
      '[cornerstoneInit] createLabelmapFromNifti: voxelManager has no getCompleteScalarDataArray()',
    );
  }
  const scalar = rawScalar as Uint8Array;

  // ────────────────────────────────────────────────────────────────────────
  // Affine-aware nearest-neighbor resample.
  //
  // Plain-English: TotalSegmentator (and most NIfTI writers) save masks in
  // **RAS+** orientation per the NIfTI standard. Cornerstone3D loads CT
  // volumes from DICOM in **LPS+** (the DICOM patient coordinate system).
  // The two frames differ by `diag(-1, -1, +1)` — RAS X = -LPS X, RAS Y =
  // -LPS Y, RAS Z = LPS Z. Ignoring this mismatch makes the liver mask
  // appear anatomically displaced (e.g. green outline in the mediastinum on
  // sagittal, pelvis on coronal — exactly the user-reported bug).
  //
  // Algorithm:
  //   for each CT voxel (i,j,k):
  //     ctWorldLPS = ctOrigin + ctDir · diag(ctSpacing) · (i,j,k)
  //     maskVox = inv(maskAffineLPS) · ctWorldLPS
  //     scalar[i,j,k] = nifti.voxels[round(maskVox)]
  // where `maskAffineLPS = diag(-1,-1,+1) · maskAffineRAS` (flip the first
  // two rows so the mask's voxel→world map produces LPS-frame coords that
  // line up with the CT).
  //
  // A `VITE_LIVERRA_AFFINE_RESAMPLE=false` env flag disables this and falls
  // back to grid-fraction (kept only as a diagnostic escape hatch — the
  // grid-fraction fallback is geometrically WRONG for cascade NIfTI output).
  // ────────────────────────────────────────────────────────────────────────
  const affineDisabled =
    typeof import.meta !== 'undefined' &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_LIVERRA_AFFINE_RESAMPLE === 'false';
  const affineEnabled = !affineDisabled;

  const refVolFull = cornerstone.cache.getVolume(referenceVolumeId) as unknown as {
    origin?: [number, number, number];
    direction?: ArrayLike<number>;
    spacing?: [number, number, number];
  } | undefined;
  const ctOrigin = refVolFull?.origin;
  const ctDirRaw = refVolFull?.direction;
  const ctSpacing = refVolFull?.spacing;
  const ctDir =
    ctDirRaw && ctDirRaw.length >= 9
      ? [
          ctDirRaw[0], ctDirRaw[1], ctDirRaw[2],
          ctDirRaw[3], ctDirRaw[4], ctDirRaw[5],
          ctDirRaw[6], ctDirRaw[7], ctDirRaw[8],
        ]
      : null;

  // Convert mask RAS affine → LPS affine by negating row-0 and row-1.
  // The translation column (index 3) MUST also flip — these are world
  // positions, not direction vectors.
  let maskAffineLPS: number[][] | null = null;
  if (nifti.affine && nifti.affine.length >= 3) {
    const a = nifti.affine;
    maskAffineLPS = [
      [-a[0][0], -a[0][1], -a[0][2], -a[0][3]],
      [-a[1][0], -a[1][1], -a[1][2], -a[1][3]],
      [ a[2][0],  a[2][1],  a[2][2],  a[2][3]],
      [0, 0, 0, 1],
    ];
  }
  const invMask = affineEnabled && maskAffineLPS ? invert4x4Affine(maskAffineLPS) : null;

  if (affineEnabled && invMask && ctOrigin && ctDir && ctSpacing) {
    // CT axis step vectors in WORLD coordinates: world delta when CT voxel
    // index is incremented by 1 along i / j / k.
    const wsx = [ctDir[0] * ctSpacing[0], ctDir[3] * ctSpacing[0], ctDir[6] * ctSpacing[0]];
    const wsy = [ctDir[1] * ctSpacing[1], ctDir[4] * ctSpacing[1], ctDir[7] * ctSpacing[1]];
    const wsz = [ctDir[2] * ctSpacing[2], ctDir[5] * ctSpacing[2], ctDir[8] * ctSpacing[2]];

    // Same step vectors mapped through `invMask` into MASK voxel coordinates.
    const msx = mat3VecApply(invMask, wsx);
    const msy = mat3VecApply(invMask, wsy);
    const msz = mat3VecApply(invMask, wsz);
    const startMask = applyAffinePoint(invMask, ctOrigin);

    for (let z = 0; z < refZ; z++) {
      const slStartX = startMask[0] + z * msz[0];
      const slStartY = startMask[1] + z * msz[1];
      const slStartZ = startMask[2] + z * msz[2];
      const refSliceBase = z * refX * refY;
      for (let y = 0; y < refY; y++) {
        let mx = slStartX + y * msy[0];
        let my = slStartY + y * msy[1];
        let mz = slStartZ + y * msy[2];
        const refRowBase = refSliceBase + y * refX;
        for (let x = 0; x < refX; x++) {
          const mxi = Math.round(mx);
          const myi = Math.round(my);
          const mzi = Math.round(mz);
          if (mxi >= 0 && mxi < niX && myi >= 0 && myi < niY && mzi >= 0 && mzi < niZ) {
            scalar[refRowBase + x] = nifti.voxels[mzi * niX * niY + myi * niX + mxi];
          }
          // outside mask box → leave as 0 (cleared by allocator)
          mx += msx[0];
          my += msx[1];
          mz += msx[2];
        }
      }
    }
  } else {
    // Fallback: original proportional grid-fraction mapping. Used when the
    // affine flag is off, the mask has no usable affine, or the CT volume's
    // geometry isn't yet exposed via the cache (very early in load).
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
  }

  // Commit the snapshot buffer back to the VM's per-image buffers. MUST be
  // setCompleteScalarDataArray() — that's the method that distributes the
  // aggregated array to each slice's image-level voxelManager (which is
  // where vtkSharedVolumeMapper reads from for GPU upload).
  //
  // Earlier theory: setCompleteScalarDataArray was a "no-op" because reading
  // back via vm.getScalarData() returned empty. That was a different bug —
  // getScalarData() reads from vm.scalarData (the top-level property), but
  // setCompleteScalarDataArray writes to the PER-IMAGE buffers (the GPU's
  // data source). setScalarData(arr) is the wrong API for derived labelmaps:
  // it only sets vm.scalarData and never reaches the renderer.
  // (Verified empirically 2026-05-11 via Playwright — labelmap rendered red
  // on the CT only after switching back to setCompleteScalarDataArray.)
  if (typeof voxelManager?.setCompleteScalarDataArray === 'function') {
    voxelManager.setCompleteScalarDataArray(scalar);
  } else if (typeof voxelManager?.setScalarData === 'function') {
    voxelManager.setScalarData(scalar);
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

  // CS3D 4.x — the segmentation renderer subscribes to a dedicated event,
  // NOT vtk.js's volume.modified(). After writing voxel data we MUST fire
  // triggerSegmentationDataModified for the GPU to re-upload the labelmap
  // texture. Without this the labelmap stays as the initial all-zeros
  // buffer the allocator created, the segmentation IS registered, but the
  // overlay is invisible — which is exactly the bug we hit (T-VIEW-overlay).
  // Fire AFTER addSegmentations() the first time (so it has a state to
  // notify); on subsequent re-writes for the same segId it's a fast no-op.
  // We dispatch immediately AND on the next animation frame to cover the
  // case where the segmentation isn't yet registered when the labelmap
  // finishes writing.
  const fireDataModified = (): void => {
    try {
      (cornerstoneTools.segmentation as unknown as {
        triggerSegmentationEvents?: {
          triggerSegmentationDataModified?: (segId: string) => void;
        };
      }).triggerSegmentationEvents?.triggerSegmentationDataModified?.(segmentationId);
    } catch {
      /* event not in this CS3D minor; renderer will fall back to next paint */
    }
  };
  fireDataModified();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(fireDataModified);
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

  // Final nudge: fire SegmentationDataModified now that the representation
  // is attached. Some CS3D 4.x paths skip the texture upload if the event
  // fires BEFORE the viewport has a representation registered, so we re-fire
  // here to be safe. Belt + braces (the same event was also dispatched at
  // the end of createLabelmapFromNifti).
  try {
    (segNs as unknown as {
      triggerSegmentationEvents?: {
        triggerSegmentationDataModified?: (segId: string) => void;
      };
    }).triggerSegmentationEvents?.triggerSegmentationDataModified?.(segmentationId);
  } catch {
    /* non-fatal */
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
  // Unconditional teardown — tests want a clean slate regardless of refcount.
  engineRefcount = 0;
  destroyCornerstoneNow();
  // Tests want a fully-clean slate, so purge the cache explicitly here.
  // Production code paths do NOT purge on destroy (see destroyCornerstoneNow).
  purgeCornerstoneCache();
  initialized = false;
  dicomAuthTokenSeen = false;
  // Reset HTJ2K config to defaults
  htj2kConfig = { enabled: true, preferLossless: false };
}
