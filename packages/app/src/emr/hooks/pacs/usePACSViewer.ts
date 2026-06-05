// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// usePACSViewer Hook
// ============================================================================
// React hook that acts as the "remote control" for the PACS medical image viewer.
// Manages the viewer lifecycle: initialize Cornerstone3D, load a study from the
// PACS server, switch tools, change layouts, adjust contrast, and clean up GPU
// resources when the component unmounts.
//
// Dependencies:
//   - cornerstoneInit (T009): Initializes Cornerstone3D engine and tools
//   - dicomwebClient (T010): Fetches study/series/instance data from PACS
// ============================================================================

import { useState, useCallback, useRef, useEffect } from 'react';
import { Enums as csEnums } from '@cornerstonejs/core';
import {
  synchronizers as csSynchronizers,
  SynchronizerManager,
  Synchronizer,
  Enums as csToolsEnums,
} from '@cornerstonejs/tools';
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';
import type {
  PACSViewerState,
  PACSViewerTool,
  ViewportLayout,
  ViewportState,
  ImagingStudyListItem,
  TransferFunctionPreset,
  HangingProtocolRule,
  RenderingMode,
  VrInteractionMode,
  MammoImageDescriptor,
} from '../../types/pacs';
import {
  initCornerstone,
  getOrCreateRenderingEngine,
  RENDERING_ENGINE_ID,
  WINDOW_LEVEL_PRESETS,
  isCornerstoneInitialized,
  configureDicomAuth,
  matchProtocol,
  applyProtocol,
  loadUserProtocols,
  findPriorStudy,
  getDicomInstanceAcceptHeader,
} from '../../services/pacs';
import type { ViewerConfiguration, PriorStudyResult } from '../../services/pacs';
// H-PACS-1 (LiverRa): the rendering engine is REFCOUNTED — this hook acquires
// a ref on mount and releases it where MediMind called destroyRenderingEngine()
// unconditionally, so multi-tab / comparison-view scenarios don't tear the
// engine down while another viewport still needs it.
import { acquireCornerstoneRef } from '../../services/pacs/cornerstoneInit';
import type { DicomWebClientHandle } from '../../services/pacs/dicomwebClient';
// LiverRa: the auth-wired DICOMweb client handle comes from the canonical root
// hook (Cognito token + tenant context) instead of MediMind's inline
// `new DicomWebClient(DICOMWEB_URL, () => medplum.getAccessToken() ?? '', medplum)`.
import { useDicomWebClient } from '../useDicomWebClient';
import { useLiverraFhir } from '../useLiverraFhir';
import { getCurrentAccessToken } from '../../services/auth';
import {
  firstImageTimer,
  mprTimer,
  cornerstoneInitTimer,
} from '../../services/pacs/pacsPerformance';
import { isDicomJsonObject } from '../../services/pacs/dicomwebClient';
import { silentLog } from '../../utils/silentLog';
import { fetchImageIds, fetchSeriesLevelMeta } from './usePACSViewer.dicom';
import type { ExtractedSeriesItem } from './usePACSViewer.dicom';
import { selectPrimarySeriesUidFromSeriesMeta } from '../../services/pacs/seriesSelectionSvc';
import { VOLUME_PRESET_VTK_NAME } from '../../services/pacs/volumePresetNames';
import { useProgressiveLoader } from './useProgressiveLoader';
import type { LoadProgress } from '../../services/pacs/progressiveLoader';
import { createViewportsForLayout } from './usePACSViewer.layout';

/** Unique IDs for the hook-level synchronizer instances */
const HOOK_SCROLL_SYNC_ID = 'pacs-viewer-scroll-sync';
const HOOK_VOI_SYNC_ID = 'pacs-viewer-voi-sync';
const NO_IMAGES_RETURNED_ERROR = 'pacs.viewer.noImagesReturned';

// ============================================================================
// Minimal Cornerstone3D runtime types not exposed on the public IViewport API.
// We narrow to local shapes instead of using untyped escape hatches.
// ============================================================================

interface CS3DVolumeViewport {
  setProperties: (properties: { preset: string }) => void;
}

function isVolumeViewport(viewport: unknown): viewport is CS3DVolumeViewport & CS3DViewportRenderable {
  const candidate = viewport as Partial<CS3DVolumeViewport & CS3DViewportRenderable>;
  return typeof candidate.setProperties === 'function' && typeof candidate.render === 'function';
}

// Slab-projection-capable volume viewport (orthographic MPR panes + VR). Both
// expose setBlendMode/setSlabThickness on Cornerstone3D's BaseVolumeViewport,
// which aren't on the public IViewport surface — so we narrow to a local shape
// instead of an untyped escape hatch.
interface CS3DSlabViewport {
  setBlendMode: (blendMode: number) => void;
  setSlabThickness: (slabThickness: number) => void;
  render: () => void;
  id?: string;
}


// ============================================================================
// Render Coalescing (M46, audit-2026-05-06)
// ============================================================================
// Fast tool sequences (rotate / flip / preset switch / WL drag) can fire many
// `viewport.render()` calls in the same tick — each forces a full GPU repaint.
// `scheduleRender` collapses bursts into a single rAF-aligned render so the
// browser only repaints once per display frame.
//
// Plain-English: think of it as a thermostat that only triggers the heater
// once per cycle no matter how many times you bump the dial.
// ============================================================================
interface CS3DViewportRenderable {
  render: () => void;
  id?: string;
}

// LiverRa: rotation/flip display properties live on StackViewport /
// BaseVolumeViewport, not the base IViewport surface this Cornerstone build
// exports from getViewport() — narrow to a local shape (same pattern as
// CS3DSlabViewport above).
interface CS3DDisplayPropertiesViewport {
  resetCamera: () => void;
  setProperties: (properties: {
    rotation?: number;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
  }) => void;
}

const pendingRenders = new WeakSet<CS3DViewportRenderable>();

function scheduleRender(viewport: CS3DViewportRenderable | null | undefined): void {
  if (!viewport) return;
  if (pendingRenders.has(viewport)) return;
  pendingRenders.add(viewport);
  requestAnimationFrame(() => {
    pendingRenders.delete(viewport);
    try {
      viewport.render();
    } catch (err) {
      console.warn('[PACS] viewport render failed:', err);
      // Viewport may have been destroyed between schedule and rAF callback.
    }
  });
}

// ============================================================================
// PACS-VR-LOD: interactive level-of-detail for the 3D volume render
// ============================================================================
// Cornerstone3D 4.22.6 renders through an OFFSCREEN interactor that never
// "animates", so VTK's automatic LOD (setAutoAdjustSampleDistances /
// interactionSampleDistanceFactor) is permanently dormant in this app. We drive
// the volume mapper's sample distance ourselves: coarsen DURING a drag (fewer
// samples per ray → faster ray-cast), restore full quality on release. The same
// mechanism covers both trackball rotate AND the crop box (same VR-pane LMB).
const VR_INTERACTIVE_LOD_FACTOR = 3; // coarsen the ray-cast ~3x DURING interaction (relative to native)
const VR_FULL_SAMPLE_DISTANCE = 1.0; // last-resort fallback ONLY if the native distance is unreadable

interface VrMapperLike {
  setSampleDistance?: (n: number) => void;
  getSampleDistance?: () => number;
}
interface VrActorEntryLike {
  actor?: { getMapper?: () => VrMapperLike | undefined };
}
/** Best-effort resolve of the VTK volume mapper backing a VOLUME_3D viewport. */
function getVrMapper(viewport: unknown): VrMapperLike | undefined {
  try {
    const vp = viewport as { getActors?: () => VrActorEntryLike[] } | undefined;
    const actors = vp?.getActors?.();
    return actors && actors.length > 0 ? actors[0]?.actor?.getMapper?.() : undefined;
  } catch (err) {
    console.warn('[PACS] resolve VR mapper failed:', err);
    silentLog('usePACSViewer', 'getVrMapper', err);
    return undefined;
  }
}

// ============================================================================
// PACS-P1.2: Prior-study first-series prefetch
// ============================================================================
// Warms the browser HTTP cache for the lowest-index series of the matched
// prior study. When the user clicks Compare (or a hanging protocol auto-loads
// the prior into a side viewport), Cornerstone's WADO-RS fetches hit the
// browser cache instead of the network — turning a 5-10s wait into <1s.
//
// Best-effort: any failure (no series, fetch error, abort) is silently
// swallowed. The main viewer must never block on prior prefetch.
// ============================================================================
const PRIOR_PREFETCH_MAX_FRAMES = 50; // matches progressiveLoader's initialBatchSize
const SOP_INSTANCE_UID_TAG_LOCAL = '00080018';
const NUMBER_OF_FRAMES_TAG_LOCAL = '00280008';

function readDicomTagValue(obj: unknown, tag: string): string {
  if (!isDicomJsonObject(obj)) return '';
  const entry = obj[tag];
  const value = entry?.Value?.[0];
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return '';
}

function prefetchPriorStudyFirstSeries(
  client: DicomWebClientHandle,
  studyInstanceUid: string,
  signal: AbortSignal
): void {
  // Fire-and-forget: no await, no throw. Caller is the prior-study `.then`.
  void (async (): Promise<void> => {
    try {
      const seriesList = await client.searchSeries(studyInstanceUid, undefined, signal);
      if (signal.aborted || seriesList.length === 0) return;

      // First series in the search response — typically the localizer / primary.
      const firstSeries = seriesList[0];
      const seriesUid = readDicomTagValue(firstSeries, '0020000E');
      if (!seriesUid) return;

      const metadata = await client.retrieveSeriesMetadata(studyInstanceUid, seriesUid, signal);
      if (signal.aborted) return;

      // Build the wadors: URL list, capping at PRIOR_PREFETCH_MAX_FRAMES.
      const urls: string[] = [];
      for (const instanceMeta of metadata) {
        if (urls.length >= PRIOR_PREFETCH_MAX_FRAMES) break;
        const sopUid = readDicomTagValue(instanceMeta, SOP_INSTANCE_UID_TAG_LOCAL);
        if (!sopUid) continue;
        const numFrames = Math.max(
          1,
          parseInt(
            readDicomTagValue(instanceMeta, NUMBER_OF_FRAMES_TAG_LOCAL) || '1',
            10
          )
        );
        for (let frame = 1; frame <= numFrames && urls.length < PRIOR_PREFETCH_MAX_FRAMES; frame++) {
          urls.push(client.getInstanceUrl(studyInstanceUid, seriesUid, sopUid, frame));
        }
      }

      // Issue plain HTTP fetches with Bearer auth — same shape as progressiveLoader.
      const instanceUrls = urls.filter((rawUrl) => !rawUrl.includes('/frames/'));
      if (instanceUrls.length === 0) return;
      const token = client.getAuthToken();
      const headers: Record<string, string> = { Accept: getDicomInstanceAcceptHeader() };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      await Promise.all(
        instanceUrls.map(async (rawUrl) => {
          const url = rawUrl.startsWith('wadors:') ? rawUrl.slice('wadors:'.length) : rawUrl;
          try {
            const response = await fetch(url, { headers, signal });
            if (!response.ok) {
              throw new Error(`DICOM prefetch failed (${response.status})`);
            }
          } catch (err) {
            silentLog('usePACSViewer', 'prior prefetch frame failed (non-fatal)', err);
            // Per-frame failures are non-fatal — Cornerstone's on-demand fetch is the
            // backstop. Intentionally not console-warned per-frame: a single bad prior study
            // would otherwise flood the console with one warn per frame (the 400 spam).
          }
        })
      );
    } catch (err) {
      console.warn('[PACS] prior study prefetch failed:', err);
      // All errors (including AbortError on study switch) are non-fatal.
    }
  })();
}

// ============================================================================
// Types
// ============================================================================

/** Status of the viewer lifecycle */
export type ViewerStatus = 'idle' | 'initializing' | 'loading' | 'ready' | 'error' | 'load-failed';

/** Return value of the usePACSViewer hook */
export interface UsePACSViewerReturn {
  /** Current lifecycle status */
  status: ViewerStatus;
  /** Error message if status === 'error' */
  error: string | null;
  /** Full viewer state (layout, viewports, active tool, etc.) */
  viewerState: PACSViewerState | null;
  /** Load an imaging study by its FHIR ImagingStudy ID, with optional study metadata for protocol matching */
  loadStudy: (studyId: string, studyInfo?: ImagingStudyListItem) => Promise<void>;
  /** Switch the active tool (e.g., 'Zoom', 'Pan', 'Length') */
  setActiveTool: (tool: PACSViewerTool) => void;
  /** Change viewport layout (e.g., '1x1', '2x2', '1x3-mpr') */
  setViewportLayout: (layout: ViewportLayout) => void;
  /** Set window/level (contrast) for the active viewport */
  setWindowLevel: (center: number, width: number) => void;
  /** Apply a named window/level preset (e.g., 'lung', 'bone', 'brain') */
  applyPreset: (presetName: string) => void;
  /** Reset the active viewport to default zoom, pan, rotation */
  resetView: () => void;
  /** Flip the active viewport horizontally or vertically */
  flip: (direction: 'horizontal' | 'vertical') => void;
  /** Rotate the active viewport by degrees (positive = clockwise) */
  rotate: (degrees: number) => void;
  /** Set which viewport is active/focused */
  setActiveViewport: (viewportId: string) => void;
  /** Clean up all resources (called automatically on unmount) */
  cleanup: () => void;
  /** Whether MPR mode is currently active */
  isMPRActive: boolean;
  /** Activate MPR mode — creates 3 volume viewports (axial/sagittal/coronal) with crosshair sync */
  activateMPR: () => void;
  /** Deactivate MPR mode — returns to 1x1 stack layout */
  deactivateMPR: () => void;
  /** Name of the currently active hanging protocol (e.g., "CT Chest", "Default") */
  activeProtocolName: string | null;
  /** The full viewer configuration from the active protocol */
  activeConfiguration: ViewerConfiguration | null;
  /** Whether 3D volume rendering mode is currently active */
  is3DActive: boolean;
  /** Activate 3D volume rendering — creates a single volume3d viewport with transfer function presets */
  activate3D: () => void;
  /** Deactivate 3D rendering — returns to previous layout */
  deactivate3D: () => void;
  /** Set the transfer function preset for 3D rendering (Bone, Soft Tissue, Lung, Vascular) */
  setTransferFunctionPreset: (preset: TransferFunctionPreset) => void;
  /** Reset 3D rotation to the default front-facing view */
  reset3DRotation: () => void;
  /** Prior study found for comparison (undefined if none, null if still searching) */
  priorStudy: ImagingStudyListItem | null | undefined;
  /** Whether the prior study search is in progress */
  priorStudyLoading: boolean;
  /** Series metadata extracted from the loaded study (for the SeriesBrowser filmstrip) */
  seriesItems: { seriesUid: string; modality: string; description?: string; instanceCount: number }[];
  /** MG-only per-image descriptors for the mammography 4-up hanging protocol; [] otherwise. */
  mammoImages: MammoImageDescriptor[];
  /** Apply a hanging protocol directly (changes layout + window/level without reloading the study) */
  applyHangingProtocol: (protocol: HangingProtocolRule) => void;
  /** Whether scroll (image slice) synchronization is enabled across viewports */
  scrollSyncEnabled: boolean;
  /** Whether window/level (VOI) synchronization is enabled across viewports */
  wlSyncEnabled: boolean;
  /** Toggle scroll synchronization on/off */
  toggleScrollSync: () => void;
  /** Toggle window/level synchronization on/off */
  toggleWLSync: () => void;
  /** Current slab rendering mode: 'default' (normal), 'mip' (brightest pixel), 'minip' (dimmest pixel) */
  renderingMode: RenderingMode;
  /** Slab thickness in millimeters (1-50) — controls how thick a "slab" of slices is combined */
  slabThickness: number;
  /** Switch rendering mode (default/mip/minip) and apply to the Cornerstone viewport */
  setRenderingMode: (mode: RenderingMode) => void;
  /** Set slab thickness (clamped 1-50mm) and apply to the Cornerstone viewport */
  setSlabThickness: (thickness: number) => void;
  /** VR pane interaction mode: 'rotate' (trackball on LMB) or 'crop' (drag crop handles / MPR reference lines on LMB) */
  vrInteractionMode: VrInteractionMode;
  /** Switch the VR pane between rotate and crop interaction. Owner: PACSViewer activates/deactivates the CS3D tools based on this value. */
  setVrInteractionMode: (mode: VrInteractionMode) => void;
  /** Progressive loader progress (reactive). status='idle' for studies under the large-study threshold. */
  progressiveLoadProgress: LoadProgress;
  /** Tell the progressive loader which slice the user is currently viewing so nearby frames are prefetched first. */
  setProgressivePriorityIndex: (index: number) => void;
  /** DICOMweb client (auth-configured) — exposed so consumers can fetch prior-study image IDs using the same client. */
  dicomWebClient: DicomWebClientHandle;
}

// ============================================================================
// Hook
// ============================================================================

export function usePACSViewer(): UsePACSViewerReturn {
  const fhir = useLiverraFhir();
  const [status, setStatus] = useState<ViewerStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [viewerState, setViewerState] = useState<PACSViewerState | null>(null);
  const [isMPRActive, setIsMPRActive] = useState(false);
  const [activeProtocolName, setActiveProtocolName] = useState<string | null>(null);
  const [activeConfiguration, setActiveConfiguration] = useState<ViewerConfiguration | null>(null);
  const [is3DActive, setIs3DActive] = useState(false);
  const [priorStudy, setPriorStudy] = useState<ImagingStudyListItem | null | undefined>(undefined);
  const [priorStudyLoading, setPriorStudyLoading] = useState(false);
  const [seriesItems, setSeriesItems] = useState<ExtractedSeriesItem[]>([]);
  const [mammoImages, setMammoImages] = useState<MammoImageDescriptor[]>([]);
  const [scrollSyncEnabled, setScrollSyncEnabled] = useState(false);
  const [wlSyncEnabled, setWlSyncEnabled] = useState(false);
  const [renderingMode, setRenderingModeState] = useState<RenderingMode>('default');
  const [slabThickness, setSlabThicknessState] = useState(10);
  // VR pane mouse-interaction mode. Default 'rotate' = trackball on LMB
  // (existing behavior). When operator picks Crop from the toolbar, this
  // flips to 'crop' and PACSViewer switches the VolumeCroppingTool to
  // active on LMB. Storing this in shared hook state (not local toolbar
  // state) so a toolbar re-mount doesn't lose the operator's choice.
  const [vrInteractionMode, setVrInteractionMode] = useState<VrInteractionMode>('rotate');

  // Refs to hold synchronizer instances so we can destroy them on cleanup
  const scrollSyncRef = useRef<InstanceType<typeof Synchronizer> | null>(null);
  const voiSyncRef = useRef<InstanceType<typeof Synchronizer> | null>(null);

  // PACS-H11: keep a ref mirror of viewerState + slabThickness + renderingMode
  // so the imperative MPR/slab callbacks below can have empty dep arrays
  // (camera-frame mutations no longer bust their memoization 30-60×/sec).
  const viewerStateRef = useRef<PACSViewerState | null>(null);
  useEffect(() => { viewerStateRef.current = viewerState; }, [viewerState]);
  const slabThicknessRef = useRef(slabThickness);
  useEffect(() => { slabThicknessRef.current = slabThickness; }, [slabThickness]);
  const renderingModeRef = useRef<RenderingMode>(renderingMode);
  useEffect(() => { renderingModeRef.current = renderingMode; }, [renderingMode]);

  // DICOMweb client — pre-configured with Cognito auth token + tenant context
  // (LiverRa: the root useDicomWebClient hook owns the auth/tenant wiring;
  // memoised there, so the handle is stable across renders).
  const dicomWebClient = useDicomWebClient();

  // Progressive loader — warms the browser HTTP cache for large studies so Cornerstone's
  // on-demand WADO-RS fetches hit cache instead of network. For studies under the
  // large-study threshold (default 100 instances), loadStudy is a no-op; Cornerstone's
  // own lazy fetch is already fast enough.
  const {
    progress: progressiveLoadProgress,
    isLargeStudy,
    setAuthToken: setProgressiveAuthToken,
    loadStudy: loadProgressiveStudy,
    setPriorityIndex: setProgressivePriorityIndex,
  } = useProgressiveLoader();

  // Track whether this hook instance is still mounted (prevents state updates after unmount)
  const mountedRef = useRef(true);
  // Track whether we've initialized Cornerstone in this instance
  const initializedRef = useRef(false);
  // Store the layout before MPR was activated so we can restore it on deactivate
  const preMPRLayoutRef = useRef<ViewportLayout>('1x1');
  // Store the layout before 3D was activated so we can restore it on deactivate
  const pre3DLayoutRef = useRef<ViewportLayout>('1x1');
  // AbortController for the current study load — cancelled on study switch or unmount
  // to prevent stale data from showing the wrong images when rapidly switching studies
  const loadAbortRef = useRef<AbortController | null>(null);
  // H-PACS-1: release function for this hook instance's refcount on the shared
  // Cornerstone rendering engine. Acquired in the mount effect below; released
  // in cleanup() where MediMind called destroyRenderingEngine() unconditionally.
  const releaseCornerstoneRefRef = useRef<(() => void) | null>(null);

  // --------------------------------------------------------------------------
  // Toggle functions for viewport synchronization
  // --------------------------------------------------------------------------
  const toggleScrollSync = useCallback(() => {
    setScrollSyncEnabled((prev) => !prev);
  }, []);

  const toggleWLSync = useCallback(() => {
    setWlSyncEnabled((prev) => !prev);
  }, []);

  // --------------------------------------------------------------------------
  // applySlabProjection — push blend mode + slab thickness to EVERY volume pane
  // --------------------------------------------------------------------------
  // Cornerstone3D splits "how thick is the slab" (setSlabThickness) from "how do
  // we flatten that slab" (setBlendMode). MIP keeps the brightest voxel through
  // the slab, MinIP the dimmest, COMPOSITE blends them (the normal thin-slice
  // look). We apply to every volume viewport in the layout — in MPR that's all
  // three panes — so the operator sees the effect everywhere, not just on the
  // one pane that happens to be "active".
  //
  // Stack viewports (a single 2D image) have no slab to project, so we skip them.
  // PACS-H11: empty deps; reads engine + state from refs so the callback stays
  // stable across the 30-60 viewerState mutations/second from camera frames.
  const applySlabProjection = useCallback((blendMode: number, thickness: number) => {
    try {
      const re = getOrCreateRenderingEngine();
      const vs = viewerStateRef.current;
      if (!vs) return;
      vs.viewports.forEach((vpState, vpId) => {
        if (vpState.type === 'stack') return;
        const csVp = re.getViewport(vpId) as unknown as Partial<CS3DSlabViewport>;
        if (
          !csVp ||
          typeof csVp.setBlendMode !== 'function' ||
          typeof csVp.setSlabThickness !== 'function'
        ) {
          return;
        }
        csVp.setBlendMode(blendMode);
        csVp.setSlabThickness(thickness);
        scheduleRender(csVp as CS3DViewportRenderable);
      });
    } catch (err) {
      console.warn('[PACS] apply slab projection failed:', err);
      // Viewport may not be ready — toolbar only shows these controls for volume layouts.
    }
  }, []);

  // --------------------------------------------------------------------------
  // setRenderingMode — Switch between default, MIP, and MinIP slab projection
  // --------------------------------------------------------------------------
  // MIP (Maximum Intensity Projection) picks the brightest voxel through the
  // slab thickness — like shining a flashlight through a block of ice and only
  // seeing the brightest sparkles. Great for finding blood vessels with contrast.
  //
  // MinIP does the opposite — picks the dimmest voxel. Good for seeing airways.
  const setRenderingMode = useCallback((mode: RenderingMode) => {
    setRenderingModeState(mode);

    if (mode === 'default') {
      // Back to a thin slice: COMPOSITE blend + minimal slab.
      setSlabThicknessState(1);
      applySlabProjection(csEnums.BlendModes.COMPOSITE, 1);
      return;
    }

    const blendMode =
      mode === 'mip'
        ? csEnums.BlendModes.MAXIMUM_INTENSITY_BLEND
        : csEnums.BlendModes.MINIMUM_INTENSITY_BLEND;
    applySlabProjection(blendMode, slabThicknessRef.current);
  }, [applySlabProjection]);

  // --------------------------------------------------------------------------
  // setSlabThickness — Adjust the slab thickness (1-50mm)
  // --------------------------------------------------------------------------
  const setSlabThickness = useCallback((thickness: number) => {
    const clamped = Math.max(1, Math.min(50, Math.round(thickness)));
    setSlabThicknessState(clamped);

    // Only meaningful in MIP/MinIP — in default (composite thin-slice) it's a no-op.
    const mode = renderingModeRef.current;
    if (mode === 'default') return;

    const blendMode =
      mode === 'mip'
        ? csEnums.BlendModes.MAXIMUM_INTENSITY_BLEND
        : csEnums.BlendModes.MINIMUM_INTENSITY_BLEND;
    applySlabProjection(blendMode, clamped);
  }, [applySlabProjection]);

  // --------------------------------------------------------------------------
  // Cleanup — destroy the rendering engine and free GPU resources
  // --------------------------------------------------------------------------
  const cleanup = useCallback(() => {
    // Destroy synchronizers before the rendering engine
    try {
      SynchronizerManager.destroySynchronizer(HOOK_SCROLL_SYNC_ID);
    } catch (err) {
      console.warn('[PACS] destroy scroll synchronizer failed:', err);
      // Already destroyed or never created
    }
    try {
      SynchronizerManager.destroySynchronizer(HOOK_VOI_SYNC_ID);
    } catch (err) {
      console.warn('[PACS] destroy VOI synchronizer failed:', err);
      // Already destroyed or never created
    }
    scrollSyncRef.current = null;
    voiSyncRef.current = null;

    try {
      // H-PACS-1 (LiverRa): release our refcount instead of MediMind's
      // unconditional destroyRenderingEngine(). The engine is destroyed only
      // when the LAST holder releases — multi-tab / comparison-view safe.
      releaseCornerstoneRefRef.current?.();
      releaseCornerstoneRefRef.current = null;
    } catch (err) {
      console.warn('[PACS] destroy rendering engine failed:', err);
      // Ignore cleanup errors — engine may already be destroyed
    }
    initializedRef.current = false;
  }, []);

  // Auto-cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    // H-PACS-1: refcount the rendering engine for this hook instance.
    // StrictMode double-mount: acquire → release (via cleanup) → acquire.
    releaseCornerstoneRefRef.current = acquireCornerstoneRef();
    return () => {
      mountedRef.current = false;
      // Abort any in-flight study loading requests
      if (loadAbortRef.current) {
        loadAbortRef.current.abort();
        loadAbortRef.current = null;
      }
      cleanup();
    };
  }, [cleanup]);

  // --------------------------------------------------------------------------
  // loadStudy — Initialize Cornerstone, match protocol, and set up viewer state
  // --------------------------------------------------------------------------
  // When studyInfo is provided, the engine matches a hanging protocol and
  // applies its layout and window presets automatically. Without studyInfo,
  // it falls back to the default 1x1 layout (same as before).
  const loadStudy = useCallback(async (studyId: string, studyInfo?: ImagingStudyListItem): Promise<void> => {
    if (!mountedRef.current) {
      return;
    }

    // Abort any previous study load to prevent stale data from appearing
    // when the user rapidly switches between studies
    if (loadAbortRef.current) {
      loadAbortRef.current.abort();
    }
    const abortController = new AbortController();
    loadAbortRef.current = abortController;
    const isLoadStale = (): boolean =>
      abortController.signal.aborted || !mountedRef.current || loadAbortRef.current !== abortController;

    // Purge accumulated metadata from previous studies to prevent unbounded
    // memory growth. After viewing 10+ studies, thousands of metadata objects
    // pile up — this releases them before loading the new study's metadata.
    try {
      cornerstoneDICOMImageLoader.wadors.metaDataManager.purge();
    } catch (err) {
      console.warn('[PACS] metadata manager purge failed:', err);
      // Manager may not be initialized yet on first load
    }

    setStatus('initializing');
    setError(null);

    // Start the "first image" stopwatch — measures total time from load to ready
    firstImageTimer.start();

    try {
      // Step 1: Initialize Cornerstone3D if not already done
      if (!isCornerstoneInitialized()) {
        cornerstoneInitTimer.start();
        await initCornerstone();
        cornerstoneInitTimer.stop();
        if (isLoadStale()) {
          return;
        }
      }

      // Step 1b: Configure auth headers for DICOM image loader
      // Without this, Cornerstone's XHR requests to fetch pixel data have no
      // JWT token, so nginx rejects them → black screen with "samplesPerPixel" errors
      //
      // B-PACS-3 (carried over from the pre-port PacsStudyViewerView): the
      // PROD branch fails LOUD when the token is missing, so a misconfigured
      // deploy errors at viewer-init rather than silently fetching PHI
      // pixel data unauthenticated.
      configureDicomAuth(() => {
        const token = getCurrentAccessToken();
        // LiverRa: typed via local narrow — this tsconfig doesn't load vite/client.
        const isProd = (import.meta as ImportMeta & { env?: { PROD?: boolean } }).env?.PROD === true;
        if (!token && isProd) {
          throw new Error('usePACSViewer: PACS auth token missing in production');
        }
        return token;
      });

      // Step 2: Get the rendering engine (creates it if needed)
      getOrCreateRenderingEngine();
      initializedRef.current = true;

      if (isLoadStale()) {
        return;
      }

      setStatus('loading');

      // Step 3: Match a hanging protocol if we have study metadata
      let config: ViewerConfiguration | null = null;
      if (studyInfo) {
        // Load user-defined protocols (non-blocking — if it fails, system defaults work)
        let userProtocols = [] as import('../../types/pacs').HangingProtocolRule[];
        try {
          userProtocols = await loadUserProtocols(fhir);
        } catch (err) {
          console.warn('[PACS] load user protocols failed:', err);
          // Ignore — system defaults will be used
        }

        if (isLoadStale()) {
          return;
        }

        // Find best matching protocol and convert to viewer configuration
        const protocol = matchProtocol(studyInfo, userProtocols);
        config = applyProtocol(protocol);
      }

      // Step 4: Create viewer state from protocol (or default if no match)
      let layout = config?.layout ?? '1x1';
      // PACS-MPR-GUARD: downgrade 3MPR to 1x1 for non-volumetric series
      // (CT scouts / topograms / single-image salvage). volumeLoader produces
      // garbage on <10 slices; the smallest clinical CT volume is ~40 slices,
      // so 10 is a conservative floor that rejects scouts without false-rejecting
      // any real volume.
      if (layout === '1x3-mpr' && studyInfo && studyInfo.instanceCount < 10) {
        silentLog('usePACSViewer', '3MPR downgraded to 1x1 (instanceCount<10)', {
          count: studyInfo.instanceCount,
        });
        layout = '1x1';
      }
      const viewports = createViewportsForLayout(layout);

      // Apply window/level presets from protocol to each viewport
      if (config) {
        for (const assignment of config.viewportAssignments) {
          const vpId = `viewport-${assignment.viewportIndex}`;
          const vp = viewports.get(vpId);
          if (vp && assignment.windowCenter !== undefined && assignment.windowWidth !== undefined) {
            viewports.set(vpId, {
              ...vp,
              windowLevel: {
                center: assignment.windowCenter,
                width: assignment.windowWidth,
              },
            });
          }
        }
      }

      const firstViewportId = 'viewport-0';
      const activeTool = config?.viewportAssignments[0]?.initialTool ?? 'StackScroll';

      const newState: PACSViewerState = {
        studyId,
        viewportLayout: layout,
        activeViewportId: firstViewportId,
        viewports,
        activeTool,
      };

      if (isLoadStale()) {
        return;
      }

      setViewerState(newState);
      setActiveProtocolName(config?.protocolName ?? null);
      setActiveConfiguration(config);
      setStatus('ready');

      // PACS-MPR-DEFAULT: when a protocol opens directly in 1x3-mpr (e.g. any
      // volumetric CT), flip isMPRActive so the toolbar exposes DEF/MIP/MIN.
      // Rendering itself doesn't need this — the volume effect in
      // PACSViewer.tsx:947 keys off vp.type === 'volume', which
      // createViewportsForLayout('1x3-mpr') already sets. This is purely for
      // toolbar gating (isVolumeViewportActive = isMPRActive || is3DActive).
      //
      // Also seed preMPRLayoutRef = '1x1-axial' so pressing M to exit MPR
      // drops into a volume-backed single axial (smooth, reslice-grade)
      // instead of the slow STACK '1x1' default — solves the "chunky axial"
      // complaint when leaving 3MPR on a direct-open CT.
      if (layout === '1x3-mpr') {
        setIsMPRActive(true);
        preMPRLayoutRef.current = '1x1-axial';
      }

      // Step 5: Fetch image IDs from DICOMweb (series → instances → wadors: URLs)
      // This runs after the UI is shown so the user sees the viewer shell immediately,
      // then images load in as they arrive — like a streaming video buffer filling up.
      // The abort signal cancels in-flight requests when the user switches studies.
      //
      // Optimization (mirrors useStudyVolume.ts:194-213 — TAVI hook): first do
      // the cheap QIDO series-list fetch and pick the primary series UID via
      // the parity-guarded picker. Then narrow the (expensive) per-instance
      // metadata fetch to JUST that series — typically ~10× fewer round-trips
      // on multi-series CT studies, which directly reduces the load-cancel
      // flood when the operator starts scrolling. Best-effort: any failure
      // here falls back to today's full multi-series fetch (parity guard).
      const narrowAndFetch = async (): Promise<void> => {
        let onlySeriesUid: string | undefined;
        // Mammography needs EVERY series' per-instance metadata so the 4-up
        // hanging protocol can read laterality/view-position for all of
        // RCC/LCC/RMLO/LMLO — they may live in separate series. Skip the
        // single-series volume narrowing for MG so no view is dropped.
        const isMammoStudy = studyInfo?.modalities?.some((m) => m.toUpperCase() === 'MG') ?? false;
        if (!isMammoStudy) {
          try {
            const seriesMeta = await fetchSeriesLevelMeta(
              dicomWebClient,
              studyId,
              abortController.signal,
            );
            onlySeriesUid = selectPrimarySeriesUidFromSeriesMeta(seriesMeta);
          } catch (preErr) {
            console.warn('[PACS] series pre-filter skipped:', preErr);
            silentLog('usePACSViewer', 'series pre-filter skipped (non-fatal)', preErr);
          }
        }
        if (isLoadStale() || abortController.signal.aborted) {
          return;
        }
        await fetchImageIds(
          dicomWebClient,
          studyId,
          abortController.signal,
          onlySeriesUid ? { onlySeriesUid } : undefined,
        )
        .then((result) => {
          if (isLoadStale()) return;
          if (result.imageIds.length === 0) {
            firstImageTimer.stop();
            setError(NO_IMAGES_RETURNED_ERROR);
            setStatus('error');
            return;
          }
          setViewerState((prev) => prev ? { ...prev, imageIds: result.imageIds } : prev);
          setSeriesItems(result.seriesItems);
          setMammoImages(result.mammoImages);
          firstImageTimer.stop();

          // PACS-P1.1: warm the browser HTTP cache for large studies. Skip small studies
          // (≤100 instances) — Cornerstone's lazy fetch already handles those fine, and
          // running progressive prefetch on a 30-image X-ray would just be extra network
          // thrash. The loader's loadStudy() returns after the initial batch (50 by
          // default); background prefetch continues asynchronously and can be re-prioritized
          // by setProgressivePriorityIndex when the user scrolls.
          if (isLargeStudy(result.imageIds.length)) {
            const token = dicomWebClient.getAuthToken();
            if (token) {
              setProgressiveAuthToken(token);
            }
            loadProgressiveStudy(result.imageIds).catch((err) => {
              console.warn('[usePACSViewer] best-effort PACS progressive load failed:', err);
              // Prefetch errors are non-fatal — Cornerstone's on-demand fetch is the backstop.
              // Logged inside the loader; nothing to do here.
            });
          }
        })
        .catch((err) => {
          // Silently ignore aborted requests — the user switched to a different study
          if (isLoadStale()) return;
          console.warn('[usePACSViewer] PACS fallback path failed:', err);
          firstImageTimer.stop();
          // Propagate load failure to subscribers (e.g., worklist row) so the row
          // can leave "pending" state and show a "Load failed" badge with Retry.
          // TODO(worklist): consume status === 'load-failed' in the worklist row
          // component (e.g., packages/app/src/emr/components/pacs/ReadingWorklist.tsx)
          // to render a failure badge + retry button.
          setError(err instanceof Error ? err.message : 'pacs.viewer.fetchImagesFailed');
          setStatus('load-failed');
        });
      };
      narrowAndFetch().catch((iifeErr) => {
        console.warn('[usePACSViewer] best-effort PACS operation failed:', iifeErr);
        silentLog('usePACSViewer', 'narrowAndFetch IIFE crashed (non-fatal)', iifeErr);
      });

      // Step 6: Prefetch prior study in the background (non-blocking)
      // Like checking if the patient had a similar scan before — runs quietly
      // while the doctor starts viewing the current study.
      if (studyInfo && studyInfo.patientId) {
        setPriorStudy(null); // null = "searching"
        setPriorStudyLoading(true);
        findPriorStudy(fhir, studyInfo)
          .then((result: PriorStudyResult) => {
            if (isLoadStale()) return;
            setPriorStudy(result.study ?? undefined);
            setPriorStudyLoading(false);

            // PACS-P1.2: Warm the browser HTTP cache for the prior study's first
            // series so that clicking Compare or auto-loading via hanging protocol
            // hits a warm cache (SC-013 — prior available in <1s). Best-effort:
            // failures are swallowed because the main viewer must not be blocked.
            if (result.study?.studyInstanceUid) {
              prefetchPriorStudyFirstSeries(
                dicomWebClient,
                result.study.studyInstanceUid,
                abortController.signal
              );
            }
          })
          .catch((err) => {
            if (isLoadStale()) return;
            console.warn('[PACS] prior study lookup failed:', err);
            setPriorStudy(undefined); // No prior found
            setPriorStudyLoading(false);
          });
      } else {
        setPriorStudy(undefined);
        setPriorStudyLoading(false);
      }
    } catch (err) {
      if (isLoadStale()) {
        return;
      }
      console.warn('[PACS] study initialization failed:', err);
      const message = err instanceof Error ? err.message : 'pacs.viewer.initializeFailed';
      firstImageTimer.stop();
      setError(message);
      setStatus('error');
    }
  }, [
    fhir,
    dicomWebClient,
    isLargeStudy,
    setProgressiveAuthToken,
    loadProgressiveStudy,
  ]);

  // --------------------------------------------------------------------------
  // setActiveTool — Switch the currently active tool
  // --------------------------------------------------------------------------
  const setActiveTool = useCallback((tool: PACSViewerTool) => {
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }
      return { ...prev, activeTool: tool };
    });
  }, []);

  // --------------------------------------------------------------------------
  // setViewportLayout — Change the grid layout (1x1, 2x2, etc.)
  // --------------------------------------------------------------------------
  const setViewportLayout = useCallback((layout: ViewportLayout) => {
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }

      const viewports = createViewportsForLayout(layout);

      // Preserve existing viewport data where possible (e.g., going from 1x1 to 2x2
      // keeps the first viewport's series assignment and window/level)
      for (const [id, newVp] of viewports) {
        const existing = prev.viewports.get(id);
        if (existing) {
          viewports.set(id, {
            ...newVp,
            seriesUid: existing.seriesUid,
            imageIndex: existing.imageIndex,
            windowLevel: existing.windowLevel,
          });
        }
      }

      // Make sure active viewport exists in the new layout
      const activeId = viewports.has(prev.activeViewportId)
        ? prev.activeViewportId
        : 'viewport-0';

      return {
        ...prev,
        viewportLayout: layout,
        viewports,
        activeViewportId: activeId,
      };
    });
  }, []);

  // --------------------------------------------------------------------------
  // setWindowLevel — Set contrast (window center/width) for active viewport
  // --------------------------------------------------------------------------
  const setWindowLevel = useCallback((center: number, width: number) => {
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }
      const vp = prev.viewports.get(prev.activeViewportId);
      if (!vp) {
        return prev;
      }
      const updated = new Map(prev.viewports);
      // Clamp to >=1 to avoid divide-by-zero in display LUT.
      updated.set(prev.activeViewportId, {
        ...vp,
        windowLevel: { center, width: Math.max(width, 1) },
      });
      return { ...prev, viewports: updated };
    });
  }, []);

  // --------------------------------------------------------------------------
  // applyPreset — Apply a named window/level preset (e.g., 'lung', 'bone')
  // --------------------------------------------------------------------------
  const applyPreset = useCallback((presetName: string) => {
    const preset = WINDOW_LEVEL_PRESETS[presetName];
    if (!preset) {
      return;
    }
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }
      const vp = prev.viewports.get(prev.activeViewportId);
      if (!vp) {
        return prev;
      }
      const updated = new Map(prev.viewports);
      updated.set(prev.activeViewportId, {
        ...vp,
        windowLevel: { center: preset.center, width: preset.width },
      });
      return { ...prev, viewports: updated };
    });
  }, []);

  // --------------------------------------------------------------------------
  // resetView — Reset zoom, pan, rotation, flip for the active viewport
  // --------------------------------------------------------------------------
  const resetView = useCallback(() => {
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }
      const vp = prev.viewports.get(prev.activeViewportId);
      if (!vp) {
        return prev;
      }
      const updated = new Map(prev.viewports);
      updated.set(prev.activeViewportId, {
        ...vp,
        zoom: 1.0,
        pan: { x: 0, y: 0 },
        rotation: 0,
        flipH: false,
        flipV: false,
      });

      // Reset the Cornerstone3D viewport camera and properties
      try {
        const re = getOrCreateRenderingEngine();
        // LiverRa: setProperties lives on Stack/VolumeViewport, not the base
        // IViewport type this Cornerstone build exports — narrow locally.
        const csVp = re.getViewport(prev.activeViewportId) as unknown as
          | (CS3DViewportRenderable & CS3DDisplayPropertiesViewport)
          | undefined;
        if (csVp) {
          csVp.resetCamera();
          csVp.setProperties({ rotation: 0, flipHorizontal: false, flipVertical: false });
          scheduleRender(csVp);
        }
      } catch (err) {
        console.warn('[PACS] reset view failed:', err);
        silentLog('usePACSViewer', 'resetView', err);
        // Viewport may not be ready
      }

      return { ...prev, viewports: updated };
    });
  }, []);

  // --------------------------------------------------------------------------
  // flip — Flip the active viewport horizontally or vertically
  // --------------------------------------------------------------------------
  const flip = useCallback((direction: 'horizontal' | 'vertical') => {
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }
      const vp = prev.viewports.get(prev.activeViewportId);
      if (!vp) {
        return prev;
      }
      const newFlipH = direction === 'horizontal' ? !vp.flipH : vp.flipH;
      const newFlipV = direction === 'vertical' ? !vp.flipV : vp.flipV;
      const updated = new Map(prev.viewports);
      updated.set(prev.activeViewportId, {
        ...vp,
        flipH: newFlipH,
        flipV: newFlipV,
      });

      // Apply to Cornerstone3D viewport
      try {
        const re = getOrCreateRenderingEngine();
        const csVp = re.getViewport(prev.activeViewportId) as unknown as
          | (CS3DViewportRenderable & CS3DDisplayPropertiesViewport)
          | undefined;
        if (csVp) {
          csVp.setProperties({
            flipHorizontal: newFlipH,
            flipVertical: newFlipV,
          });
          scheduleRender(csVp);
        }
      } catch (err) {
        console.warn('[PACS] flip viewport failed:', err);
        silentLog('usePACSViewer', 'flip', err);
        // Viewport may not be ready
      }

      return { ...prev, viewports: updated };
    });
  }, []);

  // --------------------------------------------------------------------------
  // rotate — Rotate the active viewport by a given number of degrees
  // --------------------------------------------------------------------------
  const rotate = useCallback((degrees: number) => {
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }
      const vp = prev.viewports.get(prev.activeViewportId);
      if (!vp) {
        return prev;
      }
      const newRotation = (vp.rotation + degrees) % 360;
      const updated = new Map(prev.viewports);
      updated.set(prev.activeViewportId, {
        ...vp,
        rotation: newRotation,
      });

      // Apply to Cornerstone3D viewport
      try {
        const re = getOrCreateRenderingEngine();
        const csVp = re.getViewport(prev.activeViewportId) as unknown as
          | (CS3DViewportRenderable & CS3DDisplayPropertiesViewport)
          | undefined;
        if (csVp) {
          csVp.setProperties({ rotation: newRotation });
          scheduleRender(csVp);
        }
      } catch (err) {
        console.warn('[PACS] rotate viewport failed:', err);
        silentLog('usePACSViewer', 'rotate', err);
        // Viewport may not be ready
      }

      return { ...prev, viewports: updated };
    });
  }, []);

  // --------------------------------------------------------------------------
  // setActiveViewport — Set which viewport is currently focused
  // --------------------------------------------------------------------------
  const setActiveViewport = useCallback((viewportId: string) => {
    setViewerState((prev) => {
      if (!prev || !prev.viewports.has(viewportId)) {
        return prev;
      }
      return { ...prev, activeViewportId: viewportId };
    });
  }, []);

  // --------------------------------------------------------------------------
  // activateMPR — Switch to 1x3-mpr layout with 3 volume viewports
  // --------------------------------------------------------------------------
  // MPR (Multi-Planar Reconstruction) shows the same 3D dataset sliced in
  // 3 directions: axial (top-down), sagittal (left-right), coronal (front-back).
  // Crosshairs sync across all 3 so moving one updates the others.
  const activateMPR = useCallback(() => {
    mprTimer.start();
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }

      // Remember the current layout so we can restore it later
      preMPRLayoutRef.current = prev.viewportLayout;

      // Create 3 volume viewports for the MPR planes
      const viewports = createViewportsForLayout('1x3-mpr');

      return {
        ...prev,
        viewportLayout: '1x3-mpr',
        viewports,
        activeViewportId: 'viewport-0',
        activeTool: 'Crosshairs', // Auto-set Crosshairs tool for MPR navigation
      };
    });
    setIsMPRActive(true);
    // Entering PURE MPR (1x3-mpr) is mutually exclusive with solo/mixed 3D — clear
    // the 3D flag so the toolbar doesn't show 3D as active after a 3D→MPR switch.
    // (Mixed MPR+VR keeps both flags, but that's created via activate3D, not here.)
    setIs3DActive(false);
    // Stop MPR timer — state is set, viewports will render on next paint
    mprTimer.stop();
  }, []);

  // --------------------------------------------------------------------------
  // deactivateMPR — Return to the previous layout
  // --------------------------------------------------------------------------
  const deactivateMPR = useCallback(() => {
    const restoreLayout = preMPRLayoutRef.current;
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }

      const viewports = createViewportsForLayout(restoreLayout);

      return {
        ...prev,
        viewportLayout: restoreLayout,
        viewports,
        activeViewportId: 'viewport-0',
        activeTool: 'WindowLevel', // Return to default tool
      };
    });
    // Clear both flags unconditionally. Previously this conditional set isMPRActive=true
    // when restoreLayout was '1x1-axial' to preserve DEF/MIP/MIN sub-buttons, but that
    // caused the MPR toggle to stay visually pressed — making the next user click hit
    // deactivateMPR() again instead of activateMPR(). Sub-button visibility now derives
    // from `hasVolumeViewport` in PACSViewer.tsx (checks viewport types directly).
    setIsMPRActive(false);
    setIs3DActive(false);
  }, []);

  // --------------------------------------------------------------------------
  // activate3D — Switch to a single volume3d viewport for 3D rendering
  // --------------------------------------------------------------------------
  // 3D volume rendering shows the entire CT dataset as a 3D model rather than
  // individual slices. Transfer function presets control which tissues are visible.
  const activate3D = useCallback((mode?: 'solo' | 'mixed') => {
    // PACS-MPR-VR-COEXIST: when 3D is pressed FROM 3MPR, transition to the
    // mixed '2x2-mpr-vr' layout (3 MPR + 1 VR sharing one cached volume) so
    // the user keeps slice navigation alongside the volume render. From any
    // other layout (stack 1x1, 2x2, single-axial), fall through to today's
    // single-VR behavior.
    //
    // `mode` lets the layout menu pick deterministically ("3D Volume" → 'solo',
    // "MPR + 3D" → 'mixed'); the IconCube toggle / "3" key pass nothing and keep
    // the context-aware default (mixed iff coming from 3MPR) for muscle memory.
    let goingToMixed = false;
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }

      // Remember the current layout so we can restore it later
      pre3DLayoutRef.current = prev.viewportLayout;
      goingToMixed = mode === 'mixed' || (mode == null && prev.viewportLayout === '1x3-mpr');

      if (goingToMixed) {
        // 3MPR → 2x2 mixed. The layout factory seeds vp0/1/2 as 'volume'
        // (ORTHOGRAPHIC) and vp3 as 'volume3d' (VR).
        return {
          ...prev,
          viewportLayout: '2x2-mpr-vr',
          viewports: createViewportsForLayout('2x2-mpr-vr'),
          activeViewportId: 'viewport-0',
          activeTool: 'Crosshairs', // MPR navigation stays primary; VR pane responds to default mouse drag.
        };
      }

      // Original single-VR path — anywhere else (stack 1x1, etc).
      // Use the dedicated '1x1-3d' layout id (NOT '1x1') so the render-
      // reconciliation effect's layout-change gate fires when toggling 3D on
      // from a single-pane stack — otherwise '1x1'→'1x1' looks unchanged and
      // the VR viewport is never built. createViewportsForLayout('1x1-3d')
      // seeds one volume3d slot with the default 'CtVessel' preset.
      return {
        ...prev,
        viewportLayout: '1x1-3d',
        viewports: createViewportsForLayout('1x1-3d'),
        activeViewportId: 'viewport-0',
        activeTool: 'Pan', // Pan/rotate is the natural tool for solo 3D
      };
    });
    // In mixed mode, MPR is still active alongside 3D — both flags true so
    // the toolbar exposes BOTH the DEF/MIP/MIN buttons (isMPRActive) AND
    // the VR preset buttons (is3DActive). In solo-3D, MPR stays off.
    setIsMPRActive(goingToMixed);
    setIs3DActive(true);
  }, []);

  // --------------------------------------------------------------------------
  // deactivate3D — Return to the previous layout
  // --------------------------------------------------------------------------
  const deactivate3D = useCallback(() => {
    const restoreLayout = pre3DLayoutRef.current;
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }

      const viewports = createViewportsForLayout(restoreLayout);

      return {
        ...prev,
        viewportLayout: restoreLayout,
        viewports,
        activeViewportId: 'viewport-0',
        // If restoring to MPR (3-pane), Crosshairs is the right default;
        // otherwise WindowLevel matches today's behavior.
        activeTool: restoreLayout === '1x3-mpr' ? 'Crosshairs' : 'WindowLevel',
      };
    });
    setIs3DActive(false);
    // If we came from MPR (3MPR or single-axial volume), re-assert isMPRActive
    // so the toolbar gates stay correct. For stack-based restores, leave it
    // false (it was already false when activate3D fired).
    if (restoreLayout === '1x3-mpr' || restoreLayout === '1x1-axial') {
      setIsMPRActive(true);
    }
  }, []);

  // --------------------------------------------------------------------------
  // setTransferFunctionPreset — Change the 3D rendering preset
  // --------------------------------------------------------------------------
  const setTransferFunctionPreset = useCallback((preset: TransferFunctionPreset) => {
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }
      // BUG-CRIT-2 fix (same anti-pattern as reset3DRotation): scan for the
      // volume3d viewport instead of trusting activeViewportId. In mixed mode,
      // clicking a 3D preset while an MPR pane is active was silently no-op'ing.
      let vrEntry: [string, ViewportState] | null = null;
      for (const entry of prev.viewports.entries()) {
        if (entry[1].type === 'volume3d') { vrEntry = entry; break; }
      }
      if (!vrEntry) {
        return prev;
      }
      const [vrVpId, vrVp] = vrEntry;
      const updated = new Map(prev.viewports);
      updated.set(vrVpId, {
        ...vrVp,
        volume3DPreset: preset,
      });

      // Apply the transfer function to the Cornerstone3D volume viewport.
      // Translate the friendly MediMind preset name (e.g. 'Bone') into the
      // actual VTK preset name (e.g. 'CT-Bone') — Cornerstone3D's
      // setProperties does strict-equality matching against
      // CONSTANTS.VIEWPORT_PRESETS, so the raw friendly name would silently
      // no-op (BaseVolumeViewport.js:885-898).
      try {
        const re = getOrCreateRenderingEngine();
        const csVp = re.getViewport(vrVpId);
        if (isVolumeViewport(csVp)) {
          const vtkPreset = VOLUME_PRESET_VTK_NAME[preset] ?? preset;
          csVp.setProperties({ preset: vtkPreset });
          scheduleRender(csVp);
        }
      } catch (err) {
        console.warn('[PACS] set 3D preset failed:', err);
        silentLog('usePACSViewer', 'set3DPreset', err);
        // Viewport may not be ready
      }

      return { ...prev, viewports: updated };
    });
  }, []);

  // --------------------------------------------------------------------------
  // reset3DRotation — Reset the 3D viewport rotation to default
  // --------------------------------------------------------------------------
  const reset3DRotation = useCallback(() => {
    setViewerState((prev) => {
      if (!prev) {
        return prev;
      }
      // BUG-CRIT-2 fix: scan for the volume3d viewport instead of trusting
      // activeViewportId. In mixed mode '2x2-mpr-vr', activeViewportId is
      // typically an MPR pane (type 'volume'), so the old early-return silently
      // no-op'd. Now we find the VR pane (type 'volume3d') and reset it
      // regardless of which pane is currently "active".
      let vrEntry: [string, ViewportState] | null = null;
      for (const entry of prev.viewports.entries()) {
        if (entry[1].type === 'volume3d') { vrEntry = entry; break; }
      }
      if (!vrEntry) {
        return prev;
      }
      const [vrVpId, vrVp] = vrEntry;
      const updated = new Map(prev.viewports);
      updated.set(vrVpId, {
        ...vrVp,
        rotation: 0,
        zoom: 1.0,
        pan: { x: 0, y: 0 },
      });

      // Reset the Cornerstone3D VR camera to default. resetProperties() restores
      // initialCamera (the CORONAL pose captured at construction) — this undoes
      // accumulated TrackballRotateTool rotation, which plain resetCamera() does NOT.
      // Reference: @cornerstonejs/core VolumeViewport3D.js:82-103.
      try {
        const re = getOrCreateRenderingEngine();
        const csVp = re.getViewport(vrVpId) as {
          resetProperties?: () => void;
          resetCamera?: () => void;
          render?: () => void;
        } | undefined;
        csVp?.resetProperties?.(); // undoes TrackballRotate accumulation
        csVp?.resetCamera?.();      // re-frames
        if (csVp) {
          scheduleRender(csVp as Parameters<typeof scheduleRender>[0]);
        }
      } catch (err) {
        console.warn('[PACS] reset 3D rotation failed:', err);
        silentLog('usePACSViewer', 'reset3DRotation', err);
        // Viewport may not be ready
      }

      return { ...prev, viewports: updated };
    });
  }, []);

  // --------------------------------------------------------------------------
  // applyHangingProtocol — Apply a user-selected hanging protocol directly
  // --------------------------------------------------------------------------
  // Instead of reloading the whole study, this atomically switches the layout
  // and window/level presets in one state update — like changing a TV's picture
  // mode without turning it off and on again.
  const applyHangingProtocol = useCallback((protocol: HangingProtocolRule) => {
    const config = applyProtocol(protocol);

    setViewerState((prev) => {
      if (!prev) return prev;

      const viewports = createViewportsForLayout(config.layout);

      // Apply window/level from each assignment
      for (const assignment of config.viewportAssignments) {
        const vpId = `viewport-${assignment.viewportIndex}`;
        const vp = viewports.get(vpId);
        if (vp && assignment.windowCenter !== undefined && assignment.windowWidth !== undefined) {
          viewports.set(vpId, {
            ...vp,
            windowLevel: { center: assignment.windowCenter, width: assignment.windowWidth },
          });
        }
      }

      return { ...prev, viewportLayout: config.layout, viewports, activeViewportId: 'viewport-0' };
    });

    setActiveProtocolName(config.protocolName);
    setActiveConfiguration(config);
  }, []);

  // --------------------------------------------------------------------------
  // Derived dependency string for viewport keys — only changes when viewports
  // are added/removed, NOT on every camera/zoom/pan event. This prevents
  // constant listener teardown and re-setup that compounds performance overhead.
  // --------------------------------------------------------------------------
  const viewportKeysString = viewerState?.viewports
    ? Array.from(viewerState.viewports.keys()).sort().join(',')
    : '';
  const vrVolumeBuildKeyString = viewerState?.viewports
    ? [
        viewerState.studyId,
        viewerState.viewportLayout,
        Array.from(viewerState.viewports.entries())
          .map(([id, vp]) => `${id}:${vp.type}:${vp.seriesUid ?? ''}`)
          .sort()
          .join(','),
        viewerState.imageIds
          ? `${viewerState.imageIds.length}:${viewerState.imageIds[0] ?? ''}:${viewerState.imageIds[viewerState.imageIds.length - 1] ?? ''}`
          : 'no-images',
      ].join('|')
    : '';

  // PACS-VR-LOD: true only while the user is actively dragging the VOLUME_3D
  // pane (rotate/zoom/pan/crop). Used to (a) coarsen the ray-cast and (b) suppress
  // the per-frame setViewerState churn until the drag ends.
  const vrInteractingRef = useRef(false);

  // PACS-VR-LOD: the VR mapper's NATIVE sample distance — the crisp value Cornerstone
  // computes from the volume spacing at bind time. Captured lazily on the first
  // interaction so we restore to IT on release, NEVER a hardcoded 1.0 (which is coarser
  // than native for typical CT spacing and would permanently degrade the render after the
  // first drag). Reset to undefined per layout/series rebuild so it re-captures.
  const vrNativeSampleDistanceRef = useRef<number | undefined>(undefined);

  // --------------------------------------------------------------------------
  // Sync Cornerstone3D viewport events → React state
  // --------------------------------------------------------------------------
  // Without this, the overlay always shows the hardcoded defaults (W:400, L:40,
  // Zoom:1.0). These listeners update React state in real time as the user
  // adjusts window/level, zooms, or scrolls through images.
  useEffect(() => {
    if (status !== 'ready' || !viewportKeysString) return;

    const viewportIds = viewportKeysString.split(',').filter(Boolean);
    const cleanups: (() => void)[] = [];
    // PACS-VR-LOD: this effect re-runs on every layout/series/volume rebuild → the VR
    // mapper is a fresh instance, so drop the cached native sample distance and
    // re-capture it on the next interaction (a stale value from a prior volume
    // would mis-restore the quality).
    void vrVolumeBuildKeyString;
    vrNativeSampleDistanceRef.current = undefined;

    for (const vpId of viewportIds) {
      const el = document.getElementById(`cs3d-${vpId}`) as HTMLDivElement | null;
      if (!el) continue;

      // VOI_MODIFIED — fires when user drags to change brightness/contrast
      const handleVoi = (evt: Event) => {
        const detail = (evt as CustomEvent).detail;
        if (!detail?.range) return;
        const { lower, upper } = detail.range;
        const width = upper - lower;
        const center = lower + width / 2;
        setViewerState((prev) => {
          if (!prev) return prev;
          const vp = prev.viewports.get(vpId);
          if (!vp) return prev;
          const updated = new Map(prev.viewports);
          updated.set(vpId, { ...vp, windowLevel: { center, width } });
          return { ...prev, viewports: updated };
        });
      };

      // CAMERA_MODIFIED — fires 30-60x/sec during drag. Throttled with rAF so we
      // only clone the viewports Map once per display frame (~60fps max) instead of
      // once per event. The latest event data is always used via the ref.
      let cameraPendingRaf = false;
      const handleCamera = () => {
        // PACS-VR-LOD: during an active VR drag, suppress the per-frame state churn
        // entirely (cloning the viewports Map + re-rendering the whole viewer 60x/s).
        // The final zoom is flushed once on release via handleVrInteractionEnd.
        if (vrInteractingRef.current) return;
        if (cameraPendingRaf) return; // Skip — an rAF callback is already scheduled
        cameraPendingRaf = true;
        requestAnimationFrame(() => {
          cameraPendingRaf = false;
          try {
            const re = getOrCreateRenderingEngine();
            const csVp = re.getViewport(vpId);
            if (!csVp) return;
            const zoom = csVp.getZoom();
            setViewerState((prev) => {
              if (!prev) return prev;
              const vp = prev.viewports.get(vpId);
              if (!vp) return prev;
              const updated = new Map(prev.viewports);
              updated.set(vpId, { ...vp, zoom });
              return { ...prev, viewports: updated };
            });
          } catch (err) {
            console.warn('[PACS] camera modified handler failed:', err);
            silentLog('usePACSViewer', 'cameraModifiedHandler', err);
            // Viewport may not be ready
          }
        });
      };

      // STACK_NEW_IMAGE — fires when user scrolls through a stack of slices
      const handleStackNewImage = (evt: Event) => {
        const detail = (evt as CustomEvent).detail;
        if (detail?.imageIdIndex == null) return;
        setViewerState((prev) => {
          if (!prev) return prev;
          const vp = prev.viewports.get(vpId);
          if (!vp) return prev;
          const updated = new Map(prev.viewports);
          updated.set(vpId, { ...vp, imageIndex: detail.imageIdIndex });
          return { ...prev, viewports: updated };
        });
      };

      // PACS-VR-LOD: coarsen the ray-cast on drag start, restore on release.
      // Resolved against the LIVE Cornerstone viewport type (not stale React state)
      // so it only ever touches a VOLUME_3D pane — MPR/stack panes are left alone.
      const handleVrInteractionStart = () => {
        try {
          const csVp = getOrCreateRenderingEngine().getViewport(vpId) as
            | (CS3DViewportRenderable & { type?: string })
            | undefined;
          if (csVp?.type !== csEnums.ViewportType.VOLUME_3D) return;
          vrInteractingRef.current = true;
          const mapper = getVrMapper(csVp);
          // Capture the native (crisp) sample distance ONCE, before we ever coarsen it.
          if (vrNativeSampleDistanceRef.current == null) {
            const native = mapper?.getSampleDistance?.();
            vrNativeSampleDistanceRef.current =
              typeof native === 'number' && native > 0 ? native : VR_FULL_SAMPLE_DISTANCE;
          }
          mapper?.setSampleDistance?.(vrNativeSampleDistanceRef.current * VR_INTERACTIVE_LOD_FACTOR);
        } catch (err) {
          console.warn('[PACS] VR interaction start failed:', err);
          silentLog('usePACSViewer', 'vrInteractionStart', err);
          // Viewport may not be ready.
        }
      };
      const handleVrInteractionEnd = () => {
        if (!vrInteractingRef.current) return;
        vrInteractingRef.current = false;
        try {
          const csVp = getOrCreateRenderingEngine().getViewport(vpId) as
            | (CS3DViewportRenderable & { type?: string })
            | undefined;
          if (csVp?.type !== csEnums.ViewportType.VOLUME_3D) return;
          // Restore to the NATIVE captured distance (NOT a hardcoded 1.0) so the render
          // returns to the exact crispness the operator saw on initial load.
          getVrMapper(csVp)?.setSampleDistance?.(
            vrNativeSampleDistanceRef.current ?? VR_FULL_SAMPLE_DISTANCE,
          );
          scheduleRender(csVp); // one crisp full-quality frame at rest
        } catch (err) {
          console.warn('[PACS] VR interaction end failed:', err);
          silentLog('usePACSViewer', 'vrInteractionEnd', err);
          // Viewport may not be ready.
        }
        handleCamera(); // flush the final zoom into the overlay (suppressed during drag)
      };

      el.addEventListener(csEnums.Events.VOI_MODIFIED, handleVoi);
      el.addEventListener(csEnums.Events.CAMERA_MODIFIED, handleCamera);
      el.addEventListener(csEnums.Events.STACK_NEW_IMAGE, handleStackNewImage);
      el.addEventListener(csToolsEnums.Events.MOUSE_DOWN, handleVrInteractionStart);
      el.addEventListener(csToolsEnums.Events.TOUCH_START, handleVrInteractionStart);
      el.addEventListener(csToolsEnums.Events.MOUSE_UP, handleVrInteractionEnd);
      el.addEventListener(csToolsEnums.Events.TOUCH_END, handleVrInteractionEnd);

      cleanups.push(() => {
        el.removeEventListener(csEnums.Events.VOI_MODIFIED, handleVoi);
        el.removeEventListener(csEnums.Events.CAMERA_MODIFIED, handleCamera);
        el.removeEventListener(csEnums.Events.STACK_NEW_IMAGE, handleStackNewImage);
        el.removeEventListener(csToolsEnums.Events.MOUSE_DOWN, handleVrInteractionStart);
        el.removeEventListener(csToolsEnums.Events.TOUCH_START, handleVrInteractionStart);
        el.removeEventListener(csToolsEnums.Events.MOUSE_UP, handleVrInteractionEnd);
        el.removeEventListener(csToolsEnums.Events.TOUCH_END, handleVrInteractionEnd);
      });
    }

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, [status, viewportKeysString, vrVolumeBuildKeyString]);

  // --------------------------------------------------------------------------
  // Scroll sync — create/destroy ImageSlice synchronizer when toggle changes
  // --------------------------------------------------------------------------
  // Like linking two projectors to show the same slide: when you scroll on one
  // viewport, all other synced viewports scroll to the same slice position.
  useEffect(() => {
    if (!viewportKeysString || status !== 'ready') return;

    const viewportIds = viewportKeysString.split(',').filter(Boolean);

    if (scrollSyncEnabled && viewportIds.length > 1) {
      try {
        // Destroy any stale synchronizer first (defensive)
        if (scrollSyncRef.current) {
          scrollSyncRef.current.destroy();
        }
        const sync = csSynchronizers.createImageSliceSynchronizer(HOOK_SCROLL_SYNC_ID);
        for (const vpId of viewportIds) {
          sync.add({ renderingEngineId: RENDERING_ENGINE_ID, viewportId: vpId });
        }
        scrollSyncRef.current = sync;
      } catch (err) {
        console.warn('[PACS] create scroll sync failed:', err);
        silentLog('usePACSViewer', 'createScrollSync', err);
        // Synchronizer creation may fail if viewports aren't ready
      }
    } else {
      if (scrollSyncRef.current) {
        try {
          scrollSyncRef.current.destroy();
        } catch (err) {
          console.warn('[PACS] destroy scroll sync on toggle failed:', err);
          // Already destroyed
        }
        scrollSyncRef.current = null;
      }
    }

    return () => {
      if (scrollSyncRef.current) {
        try {
          scrollSyncRef.current.destroy();
        } catch (err) {
          console.warn('[PACS] cleanup scroll sync failed:', err);
          // Cleanup best-effort
        }
        scrollSyncRef.current = null;
      }
    };
  }, [scrollSyncEnabled, status, viewportKeysString]);

  // --------------------------------------------------------------------------
  // VOI sync — create/destroy VOI synchronizer when toggle changes
  // --------------------------------------------------------------------------
  // Like linking brightness dials: adjusting contrast on one viewport
  // automatically adjusts all other synced viewports to the same level.
  useEffect(() => {
    if (!viewportKeysString || status !== 'ready') return;

    const viewportIds = viewportKeysString.split(',').filter(Boolean);

    if (wlSyncEnabled && viewportIds.length > 1) {
      try {
        if (voiSyncRef.current) {
          voiSyncRef.current.destroy();
        }
        const sync = csSynchronizers.createVOISynchronizer(HOOK_VOI_SYNC_ID, {
          syncInvertState: true,
          syncColormap: false,
        });
        for (const vpId of viewportIds) {
          sync.add({ renderingEngineId: RENDERING_ENGINE_ID, viewportId: vpId });
        }
        voiSyncRef.current = sync;
      } catch (err) {
        console.warn('[PACS] create VOI sync failed:', err);
        // Synchronizer creation may fail if viewports aren't ready
      }
    } else {
      if (voiSyncRef.current) {
        try {
          voiSyncRef.current.destroy();
        } catch (err) {
          console.warn('[PACS] destroy VOI sync on toggle failed:', err);
          // Already destroyed
        }
        voiSyncRef.current = null;
      }
    }

    return () => {
      if (voiSyncRef.current) {
        try {
          voiSyncRef.current.destroy();
        } catch (err) {
          console.warn('[PACS] cleanup VOI sync failed:', err);
          // Cleanup best-effort
        }
        voiSyncRef.current = null;
      }
    };
  }, [wlSyncEnabled, status, viewportKeysString]);

  // --------------------------------------------------------------------------
  // Master cleanup for synchronizers on unmount
  // --------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      try {
        SynchronizerManager.destroySynchronizer(HOOK_SCROLL_SYNC_ID);
      } catch (err) {
        console.warn('[PACS] destroy scroll sync on unmount failed:', err);
        // Already destroyed or never created
      }
      try {
        SynchronizerManager.destroySynchronizer(HOOK_VOI_SYNC_ID);
      } catch (err) {
        console.warn('[PACS] destroy VOI sync on unmount failed:', err);
        // Already destroyed or never created
      }
    };
  }, []);

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------
  return {
    status,
    error,
    viewerState,
    loadStudy,
    setActiveTool,
    setViewportLayout,
    setWindowLevel,
    applyPreset,
    resetView,
    flip,
    rotate,
    setActiveViewport,
    cleanup,
    isMPRActive,
    activateMPR,
    deactivateMPR,
    activeProtocolName,
    activeConfiguration,
    is3DActive,
    activate3D,
    deactivate3D,
    setTransferFunctionPreset,
    reset3DRotation,
    priorStudy,
    priorStudyLoading,
    seriesItems,
    mammoImages,
    applyHangingProtocol,
    scrollSyncEnabled,
    wlSyncEnabled,
    toggleScrollSync,
    toggleWLSync,
    renderingMode,
    slabThickness,
    setRenderingMode,
    setSlabThickness,
    vrInteractionMode,
    setVrInteractionMode,
    progressiveLoadProgress,
    setProgressivePriorityIndex,
    dicomWebClient,
  };
}
