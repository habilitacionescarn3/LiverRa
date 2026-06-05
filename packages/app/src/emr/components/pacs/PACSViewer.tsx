// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// PACSViewer Component
// ============================================================================
// The main PACS viewer that renders DICOM images using Cornerstone3D.
// Think of it as the "TV screen" for medical images — it provides the viewport
// grid (1x1, 2x2, etc.), loading/error states, WebGL detection, and cleanup.
//
// This component:
// 1. Checks if the browser supports WebGL2 (required for Cornerstone3D)
// 2. Uses the usePACSViewer hook to manage viewer lifecycle
// 3. Renders a grid of viewport cells based on the chosen layout
// 4. Shows loading spinners and error messages as needed
// 5. Provides a close callback for the parent to handle navigation
//
// Dependencies: usePACSViewer (T020), cornerstoneInit (T009), dicomwebClient (T010)
// ============================================================================
//
// ── D11 code-scale — DOCUMENTED REVIEWED EXCEPTION (EMR-PACS-IMAGING-AUDIT-009) ──
// This file sits above the D11 1000-line component threshold. It has been
// incrementally decomposed (38 pacs hooks, 54 services, 98 components already
// extracted) and was further reduced under finding 009 via behavior-preserving,
// VERBATIM extractions:
//   • ./PACSViewer.volumeGuards         — pure Cornerstone viewport type-guards +
//                                         volume health/geometry helpers (+ tests)
//   • ../../hooks/pacs/usePacsImageExport       — PNG + anonymized-DICOM export
//   • ../../hooks/pacs/useIsolationDebugHarness — DEV-only window.__isolation harness
// The DEAD partial-fork artifact `__pv_head.tsx` was also removed.
//
// The RESIDUAL core is an irreducible Cornerstone3D orchestration closure that
// CANNOT be split without clinical-rendering risk: a single ~750-line layout
// render effect (MPR / VR / stack / mixed / single-axial branches) shares mutable
// refs (activeVolumeIdRef, registeredViewportIdsRef, seriesSelectionRequestRef, …)
// and exact init/teardown + volume/SEG-binding sequencing with handleSeriesSelect,
// the study-load effect, the isolation/cut listeners, and the multi-monitor sync
// effects. Lifting any of these changes effect dependency arrays / ref lifecycles
// and reintroduces the documented black-pane / SEG-as-volume / StrictMode
// double-mount regressions. Per finding 009's Verify clause ("below the D11
// thresholds OR accompanied by documented, reviewed exceptions"), the residual is
// a reviewed exception. Sibling files services/pacs/imagingStudyService.ts and
// hooks/pacs/usePACSViewer.ts are likewise reviewed exceptions — not blind-
// refactored to avoid clinical-path risk; both remain tracked for future
// incremental extraction.
// ============================================================================

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { Button, Tooltip, SegmentedControl, Menu } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconClipboardCheck, IconFileReport, IconDownload, IconShieldCheck, IconUpload, IconLoader2, IconCloudDownload, IconFileInfo, IconKeyboard, IconLayoutGrid, IconChevronDown, IconDeviceFloppy, IconReload, IconExternalLink, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconSquare, IconLayoutColumns, IconLayoutRows, IconLayout2, IconBox, IconCube, IconBriefcase, IconAdjustmentsHorizontal } from '@tabler/icons-react';
import { useLiverraFhir } from '../../hooks/useLiverraFhir';
import { usePACSViewer } from '../../hooks/pacs/usePACSViewer';
import { useKeyboardShortcuts } from '../../hooks/pacs/useKeyboardShortcuts';
import { useCinePlayback, detectNativeFps } from '../../hooks/pacs/useCinePlayback';
import { useCloudConnectivity } from '../../hooks/pacs/useCloudConnectivity';
import { usePacsReachability } from '../../hooks/pacs/usePacsReachability';
import { useAnnotations } from '../../hooks/pacs/useAnnotations';
import { Enums as csEnums, volumeLoader, setVolumesForViewports, cache, metaData, getRenderingEngine } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { applyVolumePrefetchBias } from '../../services/pacs/volumePrefetchBias';
import { warmStackInBackground } from '../../services/pacs/stackPrefetchWarm';
import { VOLUME_PRESET_VTK_NAME } from '../../services/pacs/volumePresetNames';
import { detectWebGL2Support, logStudyView, getOrCreateRenderingEngine, RENDERING_ENGINE_ID, loadUserProtocols, saveUserProtocol, SYSTEM_PROTOCOLS } from '../../services/pacs';
import { getOrCreateToolGroup, getOrCreateVrToolGroup, activateToolOnGroup, onArrowAnnotateTextRequest, toggleAnnotationVisibility, toggleAnnotationLock, cancelActiveAnnotation, removeSelectedAnnotation, removeAllAnnotations, getCurrentAnnotationsJson, syncVoiAcrossViewports } from '../../services/pacs/cornerstoneInit';
import { setViewportVoiRange } from '../../services/pacs/cornerstoneCompat';
import { getCornerstoneGlobals } from '../../services/pacs/cornerstoneGlobals';
import { useTranslation } from '../../contexts/TranslationContext';
import { PACSToolbar, isModalityVolumetric } from './PACSToolbar';
import { WindowPresets } from './WindowPresets';
import { SeriesBrowser } from './SeriesBrowser';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { CloudOfflineBanner } from './CloudOfflineBanner';
import { MeasurementPanel } from './MeasurementPanel';
import { DicomTagBrowser } from './DicomTagBrowser';
import { KeyImageGallery } from './KeyImageGallery';
import { PACSErrorBoundary } from './PACSErrorBoundary';
import { StenosisTool } from './StenosisTool';
import { DSAControls } from './DSAControls';
import { SegmentationPanel } from './SegmentationPanel';
import { Panel3DControls } from './Panel3DControls';
import { CriticalAlertModal } from './CriticalAlertModal';
import { logStudyDownload, logStructureIsolation } from '../../services/pacs/auditService';
import { useHasPermission } from '../../contexts/PermissionContext';
import { useCalibration } from '../../hooks/pacs/useCalibration';
import type { CalibrationScope } from '../../hooks/pacs/useCalibration';
import { useDSA } from '../../hooks/pacs/useDSA';
import { useCriticalAlerts } from '../../hooks/pacs/useCriticalAlerts';
import { useSegmentation } from '../../hooks/pacs/useSegmentation';
import { useDicomSR } from '../../hooks/pacs/useDicomSR';
import { useImageFilters } from '../../hooks/pacs/useImageFilters';
import { useQCA } from '../../hooks/pacs/useQCA';
import { useStenosisPolling } from '../../hooks/pacs/useStenosisPolling';
import { useCalibrationPolling } from '../../hooks/pacs/useCalibrationPolling';
import { useViewerLifecycle } from '../../hooks/pacs/useViewerLifecycle';
import { useViewportResize } from '../../hooks/pacs/useViewportResize';
import { useViewportWheelScroll } from '../../hooks/pacs/useViewportWheelScroll';
import { useCineFrameSync } from '../../hooks/pacs/useCineFrameSync';
import { useDSARenderLoop } from '../../hooks/pacs/useDSARenderLoop';
import { useImageFilterReapply } from '../../hooks/pacs/useImageFilterReapply';
import { useViewerCacheCleanup } from '../../hooks/pacs/useViewerCacheCleanup';
import { useAuditServiceInit } from '../../hooks/pacs/useAuditServiceInit';
import { useInitialSopSync, extractSopUidFromImageId } from '../../hooks/pacs/useInitialSopSync';
import { useViewportSync, type ViewportSyncState } from '../../hooks/pacs/useViewportSync';
import { fetchImageIds } from '../../hooks/pacs/usePACSViewer.dicom';
import { usePacsImageExport } from '../../hooks/pacs/usePacsImageExport';
import { useIsolationDebugHarness } from '../../hooks/pacs/useIsolationDebugHarness';
import { selectPrimarySeriesImageIds, sortImageIdsBySpatialPosition } from '../../services/pacs/seriesSelectionSvc';
import { assignMammoPanes } from '../../services/pacs/mammoLayout';
import { resolveOrderingPractitioner } from '../../services/shared/resolveOrderingPractitioner';
import type { HangingProtocolRule, PACSViewerTool, RenderingMode, TransferFunctionPreset } from '../../types/pacs';
import {
  isStackViewport,
  hasImageIndexControl,
  hasResetProperties,
  hasSetProperties,
  isVolumePresetViewport,
  hasSetCamera,
  hasRenderableViewport,
  isCachedVolumeUsable,
  evictFramesForRebuild,
  decimateImageIdsForVr,
  canFormVolume,
} from './PACSViewer.volumeGuards';
import { splitCalibrationDependentAnnotations } from './PACSViewer.calibrationGate';
import { PACSErrorState, PACSLoadingState, PACSNoWebGLState } from './PACSViewer.states';
import { PACSSidebarActions } from './PACSViewer.sidebarActions';
import { PACSViewportGrid } from './PACSViewer.viewportGrid';
import { detachViewportIds, reconcileViewports, type RegisteredVpType } from './viewportReconcile';
import { clearIsolation, isolateStructureAtPoint, isCtScalarsReady, MASKED_VOLUME_SUFFIX, removeStructureAtPoint, removeFrustumByRect, clearRemovals, getRemovalCutCount } from '../../services/pacs/structureIsolation';
import { TaviActionButton } from '../../services/pacs/taviIntegration';
import './PACSViewer.css';

const MEDPLUM_ANNOTATION_TOOLS = new Set([
  'Length',
  'Angle',
  'CobbAngle',
  'Bidirectional',
  'Probe',
  'DragProbe',
  'Polyline',
  'EllipticalROI',
  'FreehandROI',
  'RectangleROI',
  'CircleROI',
  'SplineROI',
  'ArrowAnnotate',
]);


// Viewport type-guards + volume health/geometry helpers (isStackViewport,
// canFormVolume, isCachedVolumeUsable, decimateImageIdsForVr, …) were extracted
// verbatim to ./PACSViewer.volumeGuards for unit-testability (finding
// EMR-PACS-IMAGING-AUDIT-009). They are pure module-level functions — moving them
// changed nothing at runtime.
//
// Viewport teardown + reconciliation helpers live in ./viewportReconcile so they
// can be unit-tested without mounting the whole component. `reconcileViewports`
// detaches every slot that is leaving OR whose TYPE changed before the next
// setViewports — the latter is what lets solo 3D reopen after being closed
// (Cornerstone silently keeps a stale STACK slot on a same-id type swap).

// ============================================================================
// Types
// ============================================================================

export interface PACSViewerProps {
  /** DICOM StudyInstanceUID to load */
  studyInstanceUid: string;
  /** Orthanc internal study ID (optional — local uploads may not have this) */
  orthancStudyId?: string;
  /** Optional: pre-select a specific series by its SeriesInstanceUID */
  seriesUid?: string;
  /** Called when the user closes the viewer */
  onClose?: () => void;
  /** Optional: study metadata for hanging protocol matching */
  studyInfo?: import('../../types/pacs').ImagingStudyListItem;
  /** Whether the viewer is in full-screen mode */
  isFullScreen?: boolean;
  /** Toggle full-screen mode */
  onToggleFullScreen?: () => void;
  /** Navigate to previous study */
  onPrevStudy?: () => void;
  /** Navigate to next study */
  onNextStudy?: () => void;
  /** Whether there is a previous study to navigate to */
  hasPrevStudy?: boolean;
  /** Whether there is a next study to navigate to */
  hasNextStudy?: boolean;
  /** Toggle the Report Panel (opens/closes the side panel for writing reports) */
  onToggleReport?: () => void;
  /** Hide the left sidebar (tools/presets/series) — used when study drawer is open */
  hideSidebar?: boolean;
}

// ============================================================================
// Component
// ============================================================================

// Mantine Menu dropdowns render in a portal at <body>, OUTSIDE `.pacs-viewer`,
// so a `.pacs-viewer`-scoped CSS rule can't reach them. Tag every viewer Menu
// with these shared classNames and style the panels via GLOBAL rules in
// PACSToolbar.css (`.pacs-menu-dropdown` / `.pacs-menu-item`) so opened menus
// match the dark reading-room chrome. One source of truth, reused everywhere.
const PACS_MENU_CLASSNAMES = {
  dropdown: 'pacs-menu-dropdown',
  item: 'pacs-menu-item',
  label: 'pacs-menu-label',
  divider: 'pacs-menu-divider',
} as const;

// DICOM modalities that are NOT a browsable image stack — derived / overlay /
// document objects. The series rail hides these so it lists only real,
// viewable image reconstructions (matching medspace). SEG = segmentation
// overlays (e.g. the "Aortic Root Segmentation" series the TAVI tool writes
// back); SR = structured reports; PR = presentation states; KO = key-object
// selections; REG = registrations; RT* = radiotherapy structures/plans/doses.
const NON_STACKABLE_SERIES_MODALITIES = new Set<string>([
  'SEG', 'SR', 'PR', 'KO', 'REG', 'RTSTRUCT', 'RTPLAN', 'RTDOSE', 'RTRECORD', 'RWV', 'DOC', 'AU',
]);

interface WadoImageIdPathParts {
  studyUid?: string;
  seriesUid?: string;
  sopInstanceUid?: string;
  frameNumber?: number;
}

function decodeWadoPathSegment(segment: string | undefined): string | undefined {
  if (!segment) {
    return undefined;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseWadoImageIdPath(imageId: string): WadoImageIdPathParts {
  const match = imageId.match(/(?:\/studies\/([^/?#]+))?\/series\/([^/?#]+)\/instances\/([^/?#]+)(?:\/frames\/([^/?#]+))?/);
  if (!match) {
    return {};
  }

  const rawFrame = decodeWadoPathSegment(match[4]);
  const frameNumber = rawFrame ? Number.parseInt(rawFrame, 10) : undefined;
  return {
    studyUid: decodeWadoPathSegment(match[1]),
    seriesUid: decodeWadoPathSegment(match[2]),
    sopInstanceUid: decodeWadoPathSegment(match[3]),
    frameNumber: Number.isFinite(frameNumber) ? frameNumber : undefined,
  };
}

function imageIdMatchesSeriesUid(imageId: string, seriesUid: string): boolean {
  const parts = parseWadoImageIdPath(imageId);
  return parts.seriesUid ? parts.seriesUid === seriesUid : !imageId.includes('/series/') && imageId.includes(seriesUid);
}

function imageIdMatchesSopInstanceUid(imageId: string, sopInstanceUid: string): boolean {
  const parts = parseWadoImageIdPath(imageId);
  return parts.sopInstanceUid ? parts.sopInstanceUid === sopInstanceUid : !imageId.includes('/instances/') && imageId.includes(sopInstanceUid);
}

function imageIdMatchesFilmstripUid(imageId: string, uid: string): boolean {
  return imageIdMatchesSeriesUid(imageId, uid) || imageIdMatchesSopInstanceUid(imageId, uid);
}

function imageIdMatchesWadoTarget(
  imageId: string,
  target: { studyUid?: string; seriesUid?: string; sopInstanceUid: string; frameNumber?: number }
): boolean {
  const parts = parseWadoImageIdPath(imageId);
  if (!parts.sopInstanceUid) {
    return false;
  }
  if (target.studyUid && parts.studyUid !== target.studyUid) {
    return false;
  }
  if (target.seriesUid && parts.seriesUid !== target.seriesUid) {
    return false;
  }
  if (parts.sopInstanceUid !== target.sopInstanceUid) {
    return false;
  }
  return target.frameNumber === undefined || parts.frameNumber === target.frameNumber + 1;
}

export function PACSViewer({
  studyInstanceUid,
  // NOTE (LiverRa port): `orthancStudyId` stays on the props interface for
  // callers, but is not destructured — it is unused inside this component and
  // LiverRa's tsconfig enforces noUnusedParameters.
  seriesUid,
  onClose,
  studyInfo,
  isFullScreen,
  onToggleFullScreen,
  onPrevStudy,
  onNextStudy,
  hasPrevStudy,
  hasNextStudy,
  onToggleReport,
  hideSidebar,
}: PACSViewerProps): JSX.Element {
  const { t } = useTranslation();
  const fhir = useLiverraFhir();
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const [webGLSupported] = useState(() => detectWebGL2Support());

  // ── Structure Isolation (3mensio-style click-to-isolate) ────────────────────
  // State machine: idle → ARMED → LOADING → ACTIVE | ERROR ; ACTIVE/ARMED → idle.
  // Modelled as two booleans (armed/active) + a loading flag so the toolbar can
  // render its armed/active affordances without a string enum.
  // LiverRa has no structure-isolation-specific permission; viewer-level study.view gates it.
  const canIsolate = useHasPermission('study.view');
  const [isIsolateArmed, setIsIsolateArmed] = useState(false);
  const [isIsolateActive, setIsIsolateActive] = useState(false);
  const [isIsolateLoading, setIsIsolateLoading] = useState(false);
  // Cut tools — Remove (click a structure to delete it) + Scalpel (drag-box cut).
  // Both share the cumulative removal accumulator in structureIsolation.ts.
  const [cutMode, setCutMode] = useState<'none' | 'remove' | 'scalpel'>('none');
  const [cutCount, setCutCount] = useState(0);
  const [isCutLoading, setIsCutLoading] = useState(false);
  // Last successful click coords (viewport-relative CSS px). Retained as the
  // seed-point record for isolation; the ghost-opacity slider that used to
  // re-run isolation from here was removed in Wave 8G.13.
  const lastIsolateClickRef = useRef<{ x: number; y: number } | null>(null);
  // Lets the isolate handlers flip the VR interaction mode (crop ↔ rotate) without a
  // render-order dependency — handleVrInteractionModeChange is defined further down.
  // Kept current via a useEffect right after that definition.
  const vrModeChangeRef = useRef<(mode: 'rotate' | 'crop') => void>(() => {});

  // ── VR build status (PACS-VR-STATE) ─────────────────────────────────────────
  // Per-viewport 3D build status drives the building / error+retry / empty
  // overlays so a VR pane is never just silently black while its volume loads.
  type Vr3DBuildStatus = 'idle' | 'building' | 'ready' | 'error';
  const [volume3dBuildStatus, setVolume3dBuildStatus] = useState<Map<string, Vr3DBuildStatus>>(() => new Map());
  const setVrBuildStatus = useCallback((vpId: string, s: Vr3DBuildStatus): void => {
    setVolume3dBuildStatus((prev) => {
      if (prev.get(vpId) === s) return prev;
      const next = new Map(prev);
      next.set(vpId, s);
      return next;
    });
  }, []);
  // Retry control for the per-pane VR error overlay: optimistically show "building"
  // and bump a nonce the render-reconciliation effect depends on → clean rebuild.
  // imageIdsRef is the "this layout is already set up" marker for the render effect;
  // declared HERE (before retryVolume3d) so Retry can clear it to force a rebuild.
  const imageIdsRef = useRef<string[] | undefined>(undefined);
  const activeStackImageIdsRef = useRef<string[] | undefined>(undefined);
  const [vrRebuildNonce, setVrRebuildNonce] = useState(0);
  const retryVolume3d = useCallback((vpId: string): void => {
    setVrBuildStatus(vpId, 'building');
    // Clear the "setup done" marker so the render-reconciliation effect actually re-runs
    // the current layout's build branch. The effect sets imageIdsRef.current = imageIds
    // BEFORE the build work, so on a FAILED build the guard (imageIds === imageIdsRef.current)
    // would otherwise short-circuit the retry. Works for any layout (MPR/stack/axial/VR).
    imageIdsRef.current = undefined;
    setVrRebuildNonce((n) => n + 1);
  }, [setVrBuildStatus]);

  const {
    status,
    error,
    viewerState,
    loadStudy,
    setActiveViewport,
    setActiveTool,
    applyPreset,
    resetView,
    flip,
    rotate,
    isMPRActive,
    activateMPR,
    deactivateMPR,
    setViewportLayout,
    activeProtocolName,
    activeConfiguration,
    applyHangingProtocol,
    is3DActive,
    activate3D,
    deactivate3D,
    setTransferFunctionPreset,
    reset3DRotation,
    seriesItems,
    mammoImages,
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
    setProgressivePriorityIndex,
    priorStudy,
    dicomWebClient,
  } = usePACSViewer();

  // Track active window preset for highlighting the correct button
  const [activeWLPreset, setActiveWLPreset] = useState<string | null>(null);

  // Arrow annotate text input — shown when the ArrowAnnotateTool needs a label
  const [showArrowTextInput, setShowArrowTextInput] = useState(false);

  // Register listener for ArrowAnnotateTool text requests
  useEffect(() => {
    return onArrowAnnotateTextRequest(() => {
      setShowArrowTextInput(true);
    });
  }, []);

  // ---------- Task 1A: Protocol management state ----------
  const [userProtocols, setUserProtocols] = useState<HangingProtocolRule[]>([]);

  // Initialise audit service singleton so all logStudy*/logAnnotation* calls work
  useAuditServiceInit(fhir);

  // Load user protocols on mount
  useEffect(() => {
    loadUserProtocols(fhir).then(setUserProtocols).catch((err) => console.warn('[PACSViewer] Failed to load protocols:', err));
  }, [fhir]);

  const handleSaveProtocol = useCallback(async () => {
    if (!viewerState || !studyInfo) return;
    const protocol: HangingProtocolRule = {
      id: `user-new-${Date.now()}`,
      name: `${studyInfo.modalities.join('/') || t('common.custom')} — ${viewerState.viewportLayout}`,
      isDefault: false,
      matchCriteria: {
        modality: studyInfo.modalities,
        bodyPart: studyInfo.bodyPart ? [studyInfo.bodyPart] : undefined,
      },
      layout: viewerState.viewportLayout,
      viewportAssignments: Array.from(viewerState.viewports.entries()).map(([, _vp], idx) => ({
        viewportIndex: idx,
        seriesSelector: { preferFirst: true },
        initialTool: viewerState.activeTool,
        windowPreset: activeWLPreset || undefined,
      })),
    };
    try {
      await saveUserProtocol(fhir, protocol);
      const refreshed = await loadUserProtocols(fhir);
      setUserProtocols(refreshed);
    } catch (err) {
      console.error('[PACSViewer] Failed to save hanging protocol:', err);
      notifications.show({
        title: t('pacs.protocol.saveError'),
        message: t('pacs.protocol.saveErrorMessage'),
        color: 'red',
      });
    }
  }, [fhir, viewerState, studyInfo, activeWLPreset, t]);

  const handleResetProtocol = useCallback(() => {
    if (!studyInfo) return;
    // Re-load the study which will re-match the default protocol (no user overrides)
    void loadStudy(studyInstanceUid, studyInfo);
  }, [studyInfo, loadStudy, studyInstanceUid]);

  const handleSelectProtocol = useCallback((protocol: HangingProtocolRule) => {
    applyHangingProtocol(protocol);
  }, [applyHangingProtocol]);


  // Derive findings availability from studyInfo.
  // NOTE (LiverRa port): the upstream `studyStatus` derivation was dropped —
  // nothing in this file reads it and LiverRa's tsconfig enforces noUnusedLocals.
  const hasFindings = studyInfo?.hasFindings === true || (studyInfo?.findingsText !== undefined && studyInfo?.findingsText !== null);

  // ---------- Task 1C: Key Image Gallery state ----------
  const [showKeyImages, setShowKeyImages] = useState(false);
  const toggleKeyImages = useCallback(() => {
    setShowKeyImages((prev) => !prev);
  }, []);

  // Track the SOP Instance UID of the image currently on screen
  // so the Key Image Gallery knows which frame the user is looking at
  const [currentSopInstanceUid, setCurrentSopInstanceUid] = useState<string | undefined>(undefined);

  // Cine playback — video-like frame-by-frame control for multi-frame DICOM
  const cine = useCinePlayback();
  const cineSetTotalFramesRef = useRef(cine.setTotalFrames);
  cineSetTotalFramesRef.current = cine.setTotalFrames;
  const cineSetNativeFrameRateRef = useRef(cine.setNativeFrameRate);
  cineSetNativeFrameRateRef.current = cine.setNativeFrameRate;
  const cineTimingWarningRef = useRef<string | undefined>(undefined);
  const setCineNativeTimingForStack = useCallback((stackImageIds: string[]): void => {
    const firstImageId = stackImageIds[0];
    if (!firstImageId) {
      cineSetNativeFrameRateRef.current(undefined);
      return;
    }

    const readMetaNumber = (keyword: string): number | number[] | undefined => {
      const tagCodes: Record<string, string> = {
        FrameTime: '00181063',
        RecommendedDisplayFrameRate: '00082144',
        CineRate: '00180040',
        ActualFrameDuration: '00181242',
        FrameTimeVector: '00181065',
      };
      const camel = keyword.charAt(0).toLowerCase() + keyword.slice(1);
      const modules = ['cineModule', 'multiFrameModule', 'generalImageModule', 'dicomTag'];
      for (const moduleName of modules) {
        const module = metaData.get(moduleName, firstImageId) as Record<string, unknown> | undefined;
        const raw = module?.[keyword] ?? module?.[camel] ?? module?.[tagCodes[keyword]];
        const value = Array.isArray(raw) ? raw.map((item) => Number(item)).filter(Number.isFinite) : Number(raw);
        if (Array.isArray(value) && value.length > 0) return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
      return undefined;
    };

    const nativeFps = detectNativeFps(readMetaNumber);
    cineSetNativeFrameRateRef.current(nativeFps);
    if (nativeFps === undefined && stackImageIds.length > 1 && cineTimingWarningRef.current !== firstImageId) {
      cineTimingWarningRef.current = firstImageId;
      notifications.show({
        title: t('pacs.viewer.cineTimingUnknownTitle'),
        message: t('pacs.viewer.cineTimingUnknownMessage'),
        color: 'yellow',
        autoClose: 6000,
      });
    }
  }, [t]);

  // Refs for annotation callbacks — set after annotations hook is initialized
  const deleteAnnotationRef = useRef<(() => void) | null>(null);
  const undoRef = useRef<(() => void) | null>(null);
  const redoRef = useRef<(() => void) | null>(null);
  const lastMedplumOfflineNoticeRef = useRef(0);

  // Cloud connectivity — Medplum-dependent writes are blocked while offline
  const { status: cloudStatus, checkNow: retryConnection, isMedplumDisabled } = useCloudConnectivity();
  const notifyMedplumOffline = useCallback(() => {
    const now = Date.now();
    if (now - lastMedplumOfflineNoticeRef.current < 5000) return;
    lastMedplumOfflineNoticeRef.current = now;
    notifications.show({
      title: t('pacs.viewer.medplumOfflineTitle'),
      message: t('pacs.viewer.medplumOfflineMessage'),
      color: 'red',
    });
  }, [t]);

  // Keyboard shortcuts — the "remote control" for the viewer
  const {
    shortcuts,
    isHelpOpen,
    toggleHelp,
    closeHelp,
  } = useKeyboardShortcuts({
    onToolChange: (tool: PACSViewerTool) => {
      if (isMedplumDisabled && MEDPLUM_ANNOTATION_TOOLS.has(tool)) {
        notifyMedplumOffline();
        return;
      }
      setActiveTool(tool);
      activateToolOnGroup(tool);
    },
    onReset: resetView,
    onMPRToggle: () => (isMPRActive ? deactivateMPR() : activateMPR()),
    on3DToggle: () => (is3DActive ? deactivate3D() : activate3D()),
    onCineToggle: cine.togglePlayPause,
    onCineStepForward: cine.stepForward,
    onCineStepBackward: cine.stepBackward,
    onFullScreenToggle: onToggleFullScreen,
    onPrevStudy,
    onNextStudy,
    onCancelAnnotation: cancelActiveAnnotation,
    onDeleteAnnotation: () => deleteAnnotationRef.current?.(),
    onUndo: () => undoRef.current?.(),
    onRedo: () => redoRef.current?.(),
  });

  // Gate Save/Load to PACS on actual PACS Bridge reachability — otherwise users
  // click into a network error. Hook pings /health every 30s with a 3s timeout.
  const { isReachable: pacsReachable } = usePacsReachability();

  // Annotations — load/save measurement annotations (auto-save on change)
  const fhirStudyId = studyInfo?.id ?? '';
  const annotations = useAnnotations(fhirStudyId);
  const { queueSave } = annotations;
  const lastCalibrationGateNoticeRef = useRef(0);
  const notifyCalibrationRequired = useCallback(() => {
    const now = Date.now();
    if (now - lastCalibrationGateNoticeRef.current < 5000) return;
    lastCalibrationGateNoticeRef.current = now;
    notifications.show({
      title: t('pacs.viewer.calibrationRequiredTitle'),
      message: t('pacs.viewer.calibrationRequiredMessage'),
      color: 'red',
    });
  }, [t]);
  // Ref-mirrored calibration gate. `calibrationHook` is declared later (it needs
  // viewport state), so the autosave callback reads the live gate through a ref
  // updated by the effect below — avoids a TDZ on the hook in the deps array.
  const calibrationGateRef = useRef<{ isXA: boolean; canPersist: boolean }>({
    isXA: false,
    canPersist: true,
  });
  const queueAnnotationSave = useCallback((annotationJson: string): void => {
    if (isMedplumDisabled) {
      notifyMedplumOffline();
      return;
    }
    // SFAR/XA #8-L3130 — on XA, calibration-dependent annotations (Length /
    // Bidirectional / ROI / Probe / stenosis) are only meaningful once the
    // mm-per-pixel calibration is persisted. Until then, save the
    // non-calibration annotations but defer the calibration-dependent ones so
    // we never persist a length/area derived from an unconfirmed scale.
    const gate = calibrationGateRef.current;
    if (gate.isXA && !gate.canPersist) {
      const { retained, deferred } = splitCalibrationDependentAnnotations(annotationJson);
      if (deferred) {
        notifyCalibrationRequired();
      }
      if (retained === null) {
        // Parse failure — fail closed: skip the save rather than persist a
        // calibration-dependent measurement on an unconfirmed scale.
        return;
      }
      // When the only change was a calibration-dependent annotation, there is
      // nothing safe to persist — skip the save entirely rather than churn an
      // empty annotation set.
      if (deferred && retained === '[]') {
        return;
      }
      queueSave(retained);
      return;
    }
    queueSave(annotationJson);
  }, [isMedplumDisabled, notifyMedplumOffline, queueSave, notifyCalibrationRequired]);
  // NOTE (LiverRa port): the upstream `measurementStudyMeta` memo fed the
  // MeasurementPanel `studyMeta` prop, which the target MeasurementPanel does
  // not yet expose — re-add the memo when MeasurementPanel is uplifted:
  //   { studyDescription, patientName, patientId, studyDate } from studyInfo.

  // Cornerstone emits annotation events when the user creates, edits, or removes
  // measurements. Save from those events so new measurements are not dependent
  // on the delete/clear buttons to reach FHIR.
  useEffect(() => {
    if (!fhirStudyId) return;

    const cs = getCornerstoneGlobals().events;
    const events = cs?.Enums?.Events;
    const target = cs?.eventTarget;
    if (!target?.addEventListener || !events) return;

    const handler = (): void => {
      if (typeof document !== 'undefined' && document.hidden) return;
      queueAnnotationSave(getCurrentAnnotationsJson());
    };
    const eventTypes = [
      events.ANNOTATION_ADDED,
      events.ANNOTATION_MODIFIED,
      events.ANNOTATION_REMOVED,
    ].filter(Boolean) as string[];

    for (const eventType of eventTypes) {
      target.addEventListener(eventType, handler);
    }
    return () => {
      for (const eventType of eventTypes) {
        target.removeEventListener?.(eventType, handler);
      }
    };
  }, [queueAnnotationSave, fhirStudyId]);

  // Delete selected annotation — removes from CS3D viewport and triggers save
  const handleDeleteAnnotation = useCallback(() => {
    if (isMedplumDisabled) {
      notifyMedplumOffline();
      return;
    }
    const removedUid = removeSelectedAnnotation();
    if (removedUid) {
      queueAnnotationSave(getCurrentAnnotationsJson());
    }
  }, [isMedplumDisabled, notifyMedplumOffline, queueAnnotationSave]);

  // Clear all annotations — removes all from CS3D viewport and saves empty state
  const handleClearAnnotations = useCallback(() => {
    if (isMedplumDisabled) {
      notifyMedplumOffline();
      return;
    }
    const count = removeAllAnnotations();
    if (count > 0) {
      queueAnnotationSave(JSON.stringify([]));
    }
  }, [isMedplumDisabled, notifyMedplumOffline, queueAnnotationSave]);

  const handleUndoAnnotation = useCallback(() => {
    if (isMedplumDisabled) {
      notifyMedplumOffline();
      return;
    }
    annotations.undo();
  }, [annotations, isMedplumDisabled, notifyMedplumOffline]);

  const handleRedoAnnotation = useCallback(() => {
    if (isMedplumDisabled) {
      notifyMedplumOffline();
      return;
    }
    annotations.redo();
  }, [annotations, isMedplumDisabled, notifyMedplumOffline]);

  // Wire up refs so keyboard shortcuts can call annotation functions
  deleteAnnotationRef.current = handleDeleteAnnotation;
  undoRef.current = handleUndoAnnotation;
  redoRef.current = handleRedoAnnotation;

  // Track which series is currently displayed in the viewport
  const [activeSeriesUid, setActiveSeriesUid] = useState<string | undefined>(seriesUid);
  // Ref mirror so the (heavy, dep-sensitive) layout-build effect can read the
  // operator's selected series WITHOUT adding it to the effect deps (which
  // would rebuild viewports on every selection).
  const activeSeriesUidRef = useRef(activeSeriesUid);
  activeSeriesUidRef.current = activeSeriesUid;
  // Which series the currently-bound MPR/volume was built from — lets the
  // layout rebuild reuse the cached volume only when it still matches the
  // operator's selection (so switching layout keeps their series, not the
  // auto-picked primary).
  const activeVolumeSeriesUidRef = useRef<string | undefined>(undefined);

  // Track whether we've auto-selected the initial series (prevents re-triggering)
  const initialSeriesSelected = useRef(false);
  const seriesSelectionRequestRef = useRef(0);
  // D1/D2: the series UID the initial stack was scoped to by
  // selectPrimarySeriesImageIds. The auto-select-first-series effect compares
  // against this to SKIP a redundant second setStack when it would re-select
  // the already-loaded series. Reset per study via the seriesSelectionRequest
  // effect below (keyed on studyInstanceUid).
  const loadedPrimarySeriesUidRef = useRef<string | undefined>(undefined);
  // Cache of series loaded lazily on click. The initial fetch narrows to ONE
  // primary series for speed (onlySeriesUid); every other series' imageIds are
  // fetched on demand the first time the user clicks it, then cached here so
  // re-clicks are instant. Cleared per study below.
  const onDemandSeriesRef = useRef<Map<string, string[]>>(new Map());
  // Which series we've already shown the "can't be 3D-rendered" toast for, so a
  // repeated click on the same non-volumetric series doesn't pile up red toasts.
  const notVolumetricNotifiedRef = useRef<string | null>(null);

  useEffect(() => {
    seriesSelectionRequestRef.current += 1;
    loadedPrimarySeriesUidRef.current = undefined;
    onDemandSeriesRef.current.clear();
    notVolumetricNotifiedRef.current = null;
    activeStackImageIdsRef.current = undefined;
  }, [studyInstanceUid]);

  // Handle series selection from the filmstrip — loads that series into the
  // viewport. The initial study fetch is narrowed to one primary series for
  // speed, so a clicked series may not be loaded yet; in that case we fetch
  // its imageIds on demand (like medspace) and cache them for re-clicks.
  const handleSeriesSelect = useCallback((selectedSeriesUid: string) => {
    const requestId = ++seriesSelectionRequestRef.current;
    setActiveSeriesUid(selectedSeriesUid);

    void (async (): Promise<void> => {
      try {
        // 1) Already in the initial fetch (the primary series, or a multi-frame
        //    split)? Image IDs carry exact UIDs in the wadors URL path. Match
        //    path segments, not substrings, so 1.2.3 never matches 1.2.30.
        const loadedImageIds = imageIdsRef.current ?? [];
        let seriesImageIds = loadedImageIds.filter((id) => imageIdMatchesFilmstripUid(id, selectedSeriesUid));

        // 2) Loaded lazily earlier this study? Use the cache.
        if (seriesImageIds.length === 0) {
          seriesImageIds = onDemandSeriesRef.current.get(selectedSeriesUid) ?? [];
        }

        // 3) First click on a deferred series → fetch ONLY its instances on
        //    demand (mirrors the prior-study prefetch below). fetchImageIds
        //    registers the series' metadata with Cornerstone as a side effect,
        //    so setStack can decode it.
        if (seriesImageIds.length === 0 && dicomWebClient && studyInstanceUid) {
          const result = await fetchImageIds(
            dicomWebClient,
            studyInstanceUid,
            undefined,
            { onlySeriesUid: selectedSeriesUid },
          );
          // The user may have clicked another series while this was in flight.
          if (requestId !== seriesSelectionRequestRef.current) {
            return;
          }
          seriesImageIds = result.imageIds;
          if (seriesImageIds.length > 0) {
            onDemandSeriesRef.current.set(selectedSeriesUid, seriesImageIds);
          }
        }

        if (seriesImageIds.length === 0) {
          return; // genuinely nothing renderable for this series
        }

        // Spatial-sort along the through-plane axis so 2D scrolling is
        // sequential (not the jerky 1→9→18 jumps of raw acquisition order) and
        // MPR reformats don't band. Same sort the primary-series setup uses.
        const orderedIds = sortImageIdsBySpatialPosition(
          seriesImageIds,
          (id) => metaData.get('imagePlaneModule', id) as
            | { imagePositionPatient?: number[]; imageOrientationPatient?: number[] }
            | undefined,
        );

        const renderingEngine = getOrCreateRenderingEngine();
        const activeVpId = viewerState?.activeViewportId ?? 'viewport-0';
        const activeViewport = renderingEngine.getViewport(activeVpId);

        // --- Stack viewport (1×1 / non-MPR): swap the sorted stack ---
        if (activeViewport && isStackViewport(activeViewport)) {
          await activeViewport.setStack(orderedIds);
          if (requestId !== seriesSelectionRequestRef.current) {
            return;
          }
          activeStackImageIdsRef.current = orderedIds;
          setCineNativeTimingForStack(orderedIds);
          activeViewport.resetCamera();
          activeViewport.render();
          cineSetTotalFramesRef.current(orderedIds.length);
          // Background-warm the rest of the slices through the throttled CS pool
          // so scrolling becomes smooth within a few seconds instead of cold-
          // fetching each slice on scroll. The current slice is skipped (setStack
          // already decoded it); the pool's 12-concurrent cap keeps it gentle so
          // it never bursts the PACS edge into 503s. Best-effort — never awaited.
          warmStackInBackground({ imageIds: orderedIds, currentIndex: 0 });
          return;
        }

        // --- Volume viewport active (MPR / 3D / single-axial): rebuild the
        // shared volume from the selected series and rebind it to every volume
        // pane, so all MPR reformats follow the series change. ---
        const volumeViewports = renderingEngine.getViewports().filter((vp) => !isStackViewport(vp));
        if (volumeViewports.length === 0) {
          return;
        }

        const newVolumeId = `cornerstoneStreamingImageVolume:series_${selectedSeriesUid}_${Date.now()}`;
        if (!canFormVolume(orderedIds)) {
          console.warn('[PACSViewer] selected series is not volumetric — dropping to 2D stack so it stays viewable');
          // Toast at most once per series — repeated clicks shouldn't pile up red toasts.
          if (notVolumetricNotifiedRef.current !== selectedSeriesUid) {
            notVolumetricNotifiedRef.current = selectedSeriesUid;
            notifications.show({
              title: t('pacs.tools.3dGroup'),
              message: t('pacs.vr.notVolumetric'),
              color: 'red',
            });
          }
          // Drop to a 2D layout so the clicked series renders as a stack instead
          // of leaving the volume panes white.
          setViewportLayout('1x1');
          return;
        }
        const dropNewVolume = (): void => {
          try { cache.removeVolumeLoadObject(newVolumeId); } catch (err) { console.warn('[PACSViewer] failed to remove new volume after series switch:', err); }
        };
        evictFramesForRebuild(orderedIds);
        // Defense-in-depth: canFormVolume above already rejects non-volumetric
        // series, but if Cornerstone still throws building the volume (a geometry
        // edge canFormVolume didn't predict), degrade to the same "can't 3D-render"
        // notification instead of bubbling out and leaving the panes white.
        let volume: Awaited<ReturnType<typeof volumeLoader.createAndCacheVolume>>;
        try {
          volume = await volumeLoader.createAndCacheVolume(newVolumeId, { imageIds: orderedIds });
          // User clicked another series while this was building → discard to avoid a leak.
          if (requestId !== seriesSelectionRequestRef.current) { dropNewVolume(); return; }
          await volume.load();
        } catch (buildErr) {
          console.warn('[PACSViewer] volume build failed for series — keeping prior view:', buildErr);
          dropNewVolume();
          notifications.show({
            title: t('pacs.tools.3dGroup'),
            message: t('pacs.vr.notVolumetric'),
            color: 'red',
          });
          return;
        }
        if (requestId !== seriesSelectionRequestRef.current) { dropNewVolume(); return; }

        // Bias the load toward the center slice for a fast first paint.
        applyVolumePrefetchBias({
          volume,
          centerIndex: Math.floor(orderedIds.length * 0.5),
          windowFrames: 24,
        });

        const prevVolumeId = activeVolumeIdRef.current;
        activeVolumeIdRef.current = newVolumeId;
        activeVolumeSeriesUidRef.current = selectedSeriesUid;

        await setVolumesForViewports(
          renderingEngine,
          [{ volumeId: newVolumeId }],
          volumeViewports.map((vp) => vp.id),
        );
        if (requestId !== seriesSelectionRequestRef.current) {
          return;
        }

        for (const vp of volumeViewports) {
          vp.resetCamera();
          vp.render();
        }

        // Re-seed Crosshairs against the new volume's camera so the colored
        // reference lines repaint correctly (mirrors the MPR build effect).
        // Only on ≥2 panes — Crosshairs._computeToolCenter logs "at least two
        // viewports must be given" when seeded on a single-pane (1x1-axial) layout.
        try {
          const crosshairName = cornerstoneTools.CrosshairsTool.toolName;
          const toolGroup = getOrCreateToolGroup();
          if (volumeViewports.length >= 2 && toolGroup.hasTool(crosshairName)) {
            toolGroup.setToolPassive(crosshairName);
          }
        } catch (err) { console.warn('[PACSViewer] crosshair line re-seed failed:', err); }

        cineSetTotalFramesRef.current(orderedIds.length);

        // Free the previous volume now the new one is bound — prevents GPU
        // memory growth as the operator browses many reconstructions.
        if (prevVolumeId && prevVolumeId !== newVolumeId) {
          try { cache.removeVolumeLoadObject(prevVolumeId); } catch (err) { console.warn('[PACSViewer] failed to remove previous volume after series switch:', err); }
          // Also drop the derived isolation-masked sibling so it doesn't leak
          // (~432MB) — cleanup elsewhere only tracks the base volume id.
          try { cache.removeVolumeLoadObject(`${prevVolumeId}${MASKED_VOLUME_SUFFIX}`); } catch (err) { console.warn('[PACSViewer] failed to remove masked previous volume after series switch:', err); }
        }
      } catch (err) {
        console.warn('Failed to switch/load series:', err);
      }
    })();
  }, [dicomWebClient, setCineNativeTimingForStack, setViewportLayout, studyInstanceUid, t, viewerState?.activeViewportId]);

  // Series rail toggle — the thin dark left rail collapses to width:0 so the
  // viewport grid can reclaim the space (medspace-style immersive reading).
  // Re-opened from the top-bar rail-toggle button. Defaults open.
  const [seriesRailOpen, setSeriesRailOpen] = useState(true);
  const toggleSeriesRail = useCallback(() => {
    setSeriesRailOpen((prev) => !prev);
  }, []);

  // Measurement panel toggle — slide-out panel showing measurement results
  const [showMeasurements, setShowMeasurements] = useState(false);
  const toggleMeasurements = useCallback(() => {
    setShowMeasurements((prev) => !prev);
  }, []);

  // ColorBar toggle — vertical gradient strip showing HU-to-brightness mapping
  const [showColorBar, setShowColorBar] = useState(false);
  const toggleColorBar = useCallback(() => {
    setShowColorBar((prev) => !prev);
  }, []);

  // Segmentation panel toggle — side panel for managing segmentation segments
  const [segmentationPanelVisible, setSegmentationPanelVisible] = useState(false);
  const toggleSegmentationPanel = useCallback(() => {
    setSegmentationPanelVisible((prev) => !prev);
  }, []);

  // Segmentation state — manages segments, active tool, and segment CRUD
  const segmentation = useSegmentation();

  // Segmentation threshold state — min/max HU values for threshold-based segmentation
  const [segThresholdMin, setSegThresholdMin] = useState(-1000);
  const [segThresholdMax, setSegThresholdMax] = useState(3000);
  const handleThresholdChange = useCallback((min: number, max: number) => {
    setSegThresholdMin(min);
    setSegThresholdMax(max);
  }, []);

  // ---------- MIP / MinIP rendering mode ----------
  // renderingMode & slabThickness come from usePACSViewer() which actually
  // calls Cornerstone3D's slab API. No local state needed.
  const handleRenderingModeChange = useCallback((mode: RenderingMode) => {
    setRenderingMode(mode);
  }, [setRenderingMode]);
  const handleSlabThicknessChange = useCallback((thickness: number) => {
    setSlabThickness(thickness);
  }, [setSlabThickness]);

  // ---------- Calibration & Stenosis (Cardiology XA tools) ----------
  // Prefer FHIR modality, fall back to DICOMweb series modality (Orthanc-only studies may lack FHIR series data)
  const studyModality = studyInfo?.modalities?.[0] || seriesItems?.[0]?.modality;
  const calibrationScope = useMemo<CalibrationScope | undefined>(() => {
    const viewportId = viewerState?.activeViewportId ?? 'viewport-0';
    const viewportState = viewerState?.viewports.get(viewportId);
    let imageId: string | undefined;
    try {
      const viewport = getOrCreateRenderingEngine().getViewport(viewportId);
      if (isStackViewport(viewport)) {
        imageId = viewport.getCurrentImageId();
      }
    } catch {
      // Best-effort during viewport teardown; fall back to the hook state below.
    }
    imageId ??= viewerState?.imageIds?.[viewportState?.imageIndex ?? 0];
    const parsed = imageId ? parseWadoImageIdPath(imageId) : {};
    if (!parsed.seriesUid || !parsed.sopInstanceUid) {
      return undefined;
    }
    const plane = imageId
      ? (metaData.get('imagePlaneModule', imageId) as
          | { frameOfReferenceUID?: string; pixelSpacing?: number[] }
          | undefined)
      : undefined;
    const pixelSpacing = Array.isArray(plane?.pixelSpacing) ? plane.pixelSpacing : undefined;
    return {
      studyInstanceUid: parsed.studyUid ?? studyInstanceUid,
      seriesInstanceUid: parsed.seriesUid,
      sopInstanceUid: parsed.sopInstanceUid,
      frameNumber: parsed.frameNumber,
      frameOfReferenceUid: plane?.frameOfReferenceUID,
      viewportId,
      rowPixelSpacingMm: pixelSpacing?.[0],
      columnPixelSpacingMm: pixelSpacing?.[1],
    };
  }, [studyInstanceUid, viewerState?.activeViewportId, viewerState?.imageIds, viewerState?.viewports]);
  const calibrationHook = useCalibration(
    fhirStudyId || undefined,
    studyModality,
    calibrationScope
  );

  // SFAR/XA #8-L3130 — keep the annotation-autosave calibration gate (read via
  // ref in queueAnnotationSave, declared earlier) in sync with the live hook.
  useEffect(() => {
    calibrationGateRef.current = {
      isXA: studyModality === 'XA',
      canPersist: calibrationHook.canPersistCalibrationDependentData,
    };
  }, [studyModality, calibrationHook.canPersistCalibrationDependentData]);

  // ---------- DICOM SR (Structured Report) persistence ----------
  // HOOK-SURFACE MISMATCH (LiverRa port): the target useDicomSR takes only
  // (studyInstanceUID, patientId) — the upstream third `fhirStudyId` param
  // (links the saved SR DocumentReference to the ImagingStudy) was not ported.
  const dicomSR = useDicomSR(studyInstanceUid, studyInfo?.patientId ?? '');

  // ---------- DSA (Digital Subtraction Angiography) ----------
  const dsa = useDSA();
  const { deactivateDSA } = dsa;

  // ---------- Critical Alerts ----------
  const criticalAlerts = useCriticalAlerts();
  const [criticalAlertOpen, setCriticalAlertOpen] = useState(false);
  const [criticalAlertRecipients, setCriticalAlertRecipients] = useState<Array<{ value: string; label: string }>>([]);
  const [defaultCriticalRecipientId, setDefaultCriticalRecipientId] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setCriticalAlertRecipients([]);
    setDefaultCriticalRecipientId(undefined);

    const orderRef = studyInfo?.orderRef;
    const serviceRequestId = orderRef?.startsWith('ServiceRequest/')
      ? orderRef.slice('ServiceRequest/'.length)
      : undefined;
    if (!serviceRequestId && !fhirStudyId) return;

    void (async () => {
      try {
        const recipientRef = serviceRequestId
          ? await resolveOrderingPractitioner(fhir, serviceRequestId, 'ServiceRequest')
          : await resolveOrderingPractitioner(fhir, fhirStudyId, 'ImagingStudy');
        if (cancelled) return;
        const requesterRef = recipientRef?.reference ?? '';
        if (!requesterRef.startsWith('Practitioner/')) return;
        const practitionerId = requesterRef.slice('Practitioner/'.length);
        const label = recipientRef?.display || requesterRef;
        setCriticalAlertRecipients([{ value: practitionerId, label }]);
        setDefaultCriticalRecipientId(practitionerId);
      } catch (err) {
        console.warn('[PACSViewer] Failed to resolve critical alert recipient:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fhirStudyId, fhir, studyInfo?.orderRef]);

  const criticalAlertReportId = studyInfo?.reportId ?? '';
  const criticalAlertUnavailableMessage = !criticalAlertReportId
    ? t('pacs.criticalAlert.requiresReport')
    : !studyInfo?.patientId
      ? t('pacs.criticalAlert.requiresPatient')
      : criticalAlertRecipients.length === 0
        ? t('pacs.criticalAlert.requiresRecipient')
        : '';

  const handleOpenCriticalAlert = useCallback(() => {
    setCriticalAlertOpen(true);
  }, []);

  // ---------- Image Filters (Sharpen / Smooth) ----------
  // Provides a convolution-based filter that modifies viewport pixel data.
  // The hook needs a function to get the current viewport so it can read/write
  // pixel data and trigger re-renders.
  const getActiveViewport = useCallback(() => {
    try {
      const re = getOrCreateRenderingEngine();
      return re.getViewport(viewerState?.activeViewportId ?? 'viewport-0') ?? null;
    } catch (err) {
      console.warn('[PACSViewer] Failed to get active viewport:', err);
      return null;
    }
  }, [viewerState?.activeViewportId]);

  const imageFilters = useImageFilters(getActiveViewport);

  // Re-apply filter when user scrolls to a new slice (image index changes).
  const activeVpState = viewerState?.viewports.get(viewerState?.activeViewportId ?? '');
  const currentImageIndex = activeVpState?.imageIndex ?? 0;
  // HOOK-SURFACE MISMATCH (LiverRa port): the target useImageFilters is the
  // older pixel-cache implementation and does NOT expose `dropOriginalCache`
  // (forget the prior slice's source pixels without writing them back). Without
  // it, re-applying a filter after a slice change would convolve the PREVIOUS
  // slice's cached pixels into the new slice — display corruption. Until the
  // hooks layer ports the newer useImageFilters, reapply-on-scroll is wired
  // INERT (activeFilter: null): scrolling shows the new slice unfiltered, which
  // is safe; the user can re-toggle the filter manually.
  useImageFilterReapply({
    currentImageIndex,
    activeFilter: null,
    clearFilter: imageFilters.clearFilter,
    dropOriginalCache: () => {},
    applyFilter: imageFilters.applyFilter,
  });

  // Stenosis mode toggle & measurement values (polled from CS3D Length annotations)
  const stenosisCalibrationMm = calibrationHook.calibration?.mmPerPixel ?? null;
  const {
    isStenosisActive,
    toggleStenosis,
    stenosisRVD,
    stenosisMLD,
    stenosisSubMode,
    setStenosisSubMode,
  } = useStenosisPolling(stenosisCalibrationMm);

  const getQCAViewport = useCallback(() => {
    const engine = getOrCreateRenderingEngine();
    return engine?.getViewport(viewerState?.activeViewportId ?? 'viewport-0') ?? null;
  }, [viewerState?.activeViewportId]);

  // Semi-Automatic QCA hook — only active when stenosis is on and sub-mode is 'qca'
  // LiverRa adaptation: the target useQCA types its getViewport param against a
  // private structural `QCAViewport` shape; Cornerstone's `Viewport` satisfies it
  // at runtime but not nominally — cast to the hook's own parameter type.
  const qca = useQCA(
    getQCAViewport as unknown as Parameters<typeof useQCA>[0],
    viewerState?.activeViewportId ? `cs3d-${viewerState.activeViewportId}` : null,
    stenosisCalibrationMm,
    isStenosisActive && stenosisSubMode === 'qca'
  );

  // Track the pixel length of the latest Length annotation during calibration.
  // Polls CS3D annotation state every 500ms while calibrating to detect when
  // the user finishes drawing a line, then enables the French size buttons.
  const calibrationPixelLength = useCalibrationPolling(calibrationHook.isCalibrating);

  const handleCalibrate = useCallback(() => {
    if (calibrationHook.isCalibrating) {
      // Already calibrating — cancel
      calibrationHook.clearCalibration();
    } else {
      if (isMedplumDisabled) {
        notifyMedplumOffline();
        return;
      }
      calibrationHook.startCalibration();
      // Switch tool to Length for drawing the calibration line
      setActiveTool('Length');
      activateToolOnGroup('Length');
    }
  }, [calibrationHook, isMedplumDisabled, notifyMedplumOffline, setActiveTool]);

  // DICOM tag browser state
  const [showTagBrowser, setShowTagBrowser] = useState(false);

  // Export current viewport as PNG
  // Viewport PNG export + tag-level anonymized DICOM export (PACS-H2 invariants)
  // extracted verbatim to usePacsImageExport (finding EMR-PACS-IMAGING-AUDIT-009).
  // Self-contained "export" concern — no render-orchestration refs shared.
  // LiverRa adaptation: the target usePacsImageExport hook no longer takes a
  // `medplum` client param (dropped during the hooks port) — call matches
  // UsePacsImageExportParams exactly.
  const { handleExportImage, handleAnonymizeExport, isAnonymizing } = usePacsImageExport({
    viewerContainerRef,
    viewerState,
    studyInstanceUid,
    fhirStudyId,
    studyInfo,
    seriesItems,
    t,
  });

  // Navigate the viewport to a specific SOP Instance UID + frame (used by Key Image Gallery)
  // Switches to the correct series/clip in the filmstrip, then jumps to the exact frame.
  const handleKeyImageNavigate = useCallback((sopInstanceUid: string, frameNumber?: number) => {
    try {
      const allImageIds = viewerState?.imageIds ?? [];
      if (allImageIds.length === 0) return;

      // Find the target image ID across ALL series
      let targetImageId: string | undefined;
      if (frameNumber !== undefined) {
        targetImageId = allImageIds.find((id) => imageIdMatchesWadoTarget(id, { sopInstanceUid, frameNumber }));
      }
      if (!targetImageId) {
        targetImageId = allImageIds.find((id) => imageIdMatchesSopInstanceUid(id, sopInstanceUid));
      }
      if (!targetImageId) return;

      // Determine which filmstrip entry to select.
      // For multi-frame cardiac studies, the filmstrip uses SOP Instance UIDs as seriesUid
      // (so each cine clip gets its own thumbnail). For normal series it uses the real series UID.
      // Check for direct SOP match first, then fall back to the real series UID from the URL.
      const targetParts = parseWadoImageIdPath(targetImageId);
      let filmstripId = seriesItems.find((s) => s.seriesUid === sopInstanceUid)?.seriesUid;
      const filmstripIdIsSopUid = filmstripId !== undefined;
      if (!filmstripId) {
        filmstripId = targetParts.seriesUid;
      }

      if (filmstripId) {
        const clipImageIds = allImageIds.filter((id) =>
          filmstripIdIsSopUid
            ? imageIdMatchesSopInstanceUid(id, filmstripId)
            : imageIdMatchesSeriesUid(id, filmstripId)
        );
        if (clipImageIds.length > 0) {
          // Find the frame index within this clip's stack
          let targetIndex = clipImageIds.indexOf(targetImageId);
          if (targetIndex < 0) {
            targetIndex = clipImageIds.findIndex((id) => imageIdMatchesSopInstanceUid(id, sopInstanceUid));
          }
          if (targetIndex < 0) targetIndex = 0;

          // Update filmstrip highlight
          setActiveSeriesUid(filmstripId);

          // Load the clip into the viewport, then jump to the bookmarked frame
          const renderingEngine = getOrCreateRenderingEngine();
          const viewport = renderingEngine.getViewport(viewerState?.activeViewportId ?? 'viewport-0');
          if (!isStackViewport(viewport)) return;

          void viewport.setStack(clipImageIds).then(() => {
            activeStackImageIdsRef.current = clipImageIds;
            setCineNativeTimingForStack(clipImageIds);
            viewport.setImageIdIndex(targetIndex);
            cineSetTotalFramesRef.current(clipImageIds.length);
            cine.seekToFrame(targetIndex);
            cine.play();
          }).catch((e: unknown) => {
            console.warn('Failed to navigate to key image:', e);
          });
        }
      }

      setCurrentSopInstanceUid(sopInstanceUid);
    } catch (err) {
      console.warn('[PACSViewer] Failed to set current SOP instance:', err);
      // Viewport may not be ready
    }
  }, [viewerState?.imageIds, viewerState?.activeViewportId, seriesItems, cine, setCineNativeTimingForStack]);

  // PACS-C7 / D3: cache cleanup refs + unmount effect — owned by the cleanup
  // hook so unmount semantics survive future refactors of the rendering
  // effect. studyImageIdsRef is kept in sync below so the unmount path evicts
  // ONLY this viewer's study images (no global purgeCache).
  const { activeVolumeIdRef, studyImageIdsRef } = useViewerCacheCleanup();
  // Latest non-trigger values consumed by the study-load effect. Mirrored in a
  // ref (updated every render) so the effect can use the freshest loadStudy /
  // studyInfo / deactivateDSA / fhirStudyId WITHOUT listing them as effect deps
  // — listing them made a layout switch (MPR/3D/grid toggle), which churns those
  // identities, spuriously re-fire the destructive study reload below. See the
  // study-load effect's dependency array for the full rationale.
  const studyLoadLatestRef = useRef({ loadStudy, studyInfo, deactivateDSA, fhirStudyId });
  studyLoadLatestRef.current = { loadStudy, studyInfo, deactivateDSA, fhirStudyId };

  // --------------------------------------------------------------------------
  // Load study on mount (or when studyInstanceUid changes)
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!webGLSupported) {
      return;
    }
    // Read the freshest non-trigger values from the latest-ref (see deps note).
    const { loadStudy, studyInfo, deactivateDSA, fhirStudyId } = studyLoadLatestRef.current;
    // Reset auto-select flag so a new study triggers auto-selection of its first series
    initialSeriesSelected.current = false;
    // Deactivate DSA when switching studies
    deactivateDSA();
    // PACS-C7 / D3: when the study changes, evict ONLY the OUTGOING study's
    // decoded pixel data — not the whole CS3D cache. The previous unconditional
    // cache.purgeCache() also wiped any prior-study / prefetched frames, so
    // back-navigation cold-refetched + re-decoded everything. imageIdsRef holds
    // the full all-series imageId list of the study currently displayed (set by
    // the rendering effect); evict exactly those. The active MPR volume (if any)
    // is released here too. General memory pressure is bounded by the 3GB
    // size-pressure budget configured in cornerstoneInit (512MB on mobile), so
    // a scoped eviction keeps the OOM guarantee without the cold-cache penalty.
    const outgoingImageIds = imageIdsRef.current;
    if (outgoingImageIds && outgoingImageIds.length > 0) {
      for (const imageId of outgoingImageIds) {
        try {
          cache.removeImageLoadObject(imageId);
        } catch (err) {
          console.warn('[PACSViewer] Failed to remove cached image during study cleanup:', err);
        }
      }
    }
    if (activeVolumeIdRef.current) {
      try {
        cache.removeVolumeLoadObject(activeVolumeIdRef.current);
        // Drop the derived isolation-masked sibling too (avoids a ~432MB leak).
        cache.removeVolumeLoadObject(`${activeVolumeIdRef.current}${MASKED_VOLUME_SUFFIX}`);
      } catch (err) {
        console.warn('[PACSViewer] Failed to remove cached volume during study cleanup:', err);
      }
      activeVolumeIdRef.current = null;
    }
    imageIdsRef.current = undefined;
    studyImageIdsRef.current = undefined;
    // Load using studyInstanceUid — DICOMweb URLs use the DICOM UID, not Orthanc's internal ID
    // Pass studyInfo so the hanging protocol engine can match the right layout/presets
    void loadStudy(studyInstanceUid, studyInfo);
    // Fire-and-forget: log that the user viewed this study. Use FHIR IDs in
    // the audit entity and keep the DICOM UID in the human-readable text.
    if (fhirStudyId || studyInfo?.patientId) {
      logStudyView({
        studyId: fhirStudyId || undefined,
        patientId: studyInfo?.patientId,
        description: `Viewed study ${studyInstanceUid}`,
      });
    }
    // PACS black-slices fix: depend ONLY on the values that should trigger a
    // full study (re)load — the DICOM study identity and WebGL availability.
    // Previously this listed loadStudy / studyInfo / deactivateDSA / fhirStudyId
    // too; a layout switch (MPR/3D/grid toggle) re-renders this component and
    // churns those identities, which spuriously re-ran this effect's destructive
    // body (reset initialSeriesSelected → re-pick seriesItems[0], which can be a
    // derived/segmentation series → MPR volume built from a non-volumetric series
    // → BLACK; plus evict + re-fetch racing the rendering effect's volume build).
    // The freshest copies of those values are read from studyLoadLatestRef above,
    // so narrowing the deps has no stale-closure cost. Stable cleanup refs are
    // included so the hook dependency check can prove the ref bridge.
    // studyInstanceUid changing is the ONLY thing that means "a different study"
    // — a real study switch (and every genuine/StrictMode mount) still reloads correctly.
  }, [activeVolumeIdRef, studyImageIdsRef, studyInstanceUid, webGLSupported]);

  // --------------------------------------------------------------------------
  // Render images into Cornerstone3D viewports when imageIds arrive
  // --------------------------------------------------------------------------
  // This is the "plug images in" step — we tell Cornerstone3D about the DOM
  // elements and hand it the image URLs. Without this, the viewer is just an
  // empty black screen with overlays.
  const layoutRef = useRef<string | undefined>(undefined);
  // D1: ref mirror of seriesItems so the rendering effect can pass modality
  // info to selectPrimarySeriesImageIds WITHOUT widening that effect's deps
  // (keeps the PACS-H13 minimal-deps intent — viewports must not rebuild on a
  // seriesItems identity change).
  const seriesItemsRef = useRef(seriesItems);
  useEffect(() => { seriesItemsRef.current = seriesItems; }, [seriesItems]);
  // Ref mirror of mammoImages so the render effect can read the MG hanging-
  // protocol descriptors without widening its deps (same intent as seriesItemsRef).
  const mammoImagesRef = useRef(mammoImages);
  useEffect(() => { mammoImagesRef.current = mammoImages; }, [mammoImages]);

  // Resolve which series' imageIds the layout-build effect should display, and
  // return them spatially sorted. Prefers the operator's currently-selected
  // series (so changing layout keeps their series) and falls back to the
  // auto-picked primary on first open / when the selected series isn't loaded.
  // The pool includes both the initial (narrowed) imageIds AND any series
  // fetched on demand via handleSeriesSelect — selectPrimarySeriesImageIds only
  // honors the preferred series when its imageIds are actually present, so on
  // first open (selection not yet loaded) it cleanly falls through to primary.
  const resolveDisplaySeriesIds = useCallback(
    (poolBase: string[]): { sortedIds: string[]; seriesUid?: string } => {
      const onDemand = Array.from(onDemandSeriesRef.current.values()).flat();
      const pool = onDemand.length > 0 ? [...poolBase, ...onDemand] : poolBase;
      const sel = selectPrimarySeriesImageIds(pool, seriesItemsRef.current, activeSeriesUidRef.current);
      const chosen = sel.imageIds;
      const sortedIds = sortImageIdsBySpatialPosition(
        chosen,
        (id) => metaData.get('imagePlaneModule', id) as
          | { imagePositionPatient?: number[]; imageOrientationPatient?: number[] }
          | undefined,
      );
      return { sortedIds, seriesUid: sel.seriesUid };
    },
    [],
  );
  const resolveProtocolAssignmentSeriesIds = useCallback(
    (
      poolBase: string[],
      assignment: { seriesSelector?: { modality?: string; descriptionPattern?: string; preferFirst?: boolean } }
    ): { sortedIds: string[]; seriesUid?: string } => {
      const selector = assignment.seriesSelector;
      if (!selector) {
        return { sortedIds: [], seriesUid: undefined };
      }
      const onDemand = Array.from(onDemandSeriesRef.current.values()).flat();
      const pool = onDemand.length > 0 ? [...poolBase, ...onDemand] : poolBase;
      const descriptionPattern = selector.descriptionPattern ? new RegExp(selector.descriptionPattern, 'i') : undefined;
      const candidates = seriesItemsRef.current.filter((series) => {
        if (selector.modality && series.modality.toUpperCase() !== selector.modality.toUpperCase()) {
          return false;
        }
        if (descriptionPattern && !descriptionPattern.test(series.description ?? '')) {
          return false;
        }
        return true;
      });

      for (const candidate of candidates) {
        const candidateIds = pool.filter((id) => imageIdMatchesSeriesUid(id, candidate.seriesUid));
        if (candidateIds.length === 0) {
          continue;
        }
        const sortedIds = sortImageIdsBySpatialPosition(
          candidateIds,
          (id) => metaData.get('imagePlaneModule', id) as
            | { imagePositionPatient?: number[]; imageOrientationPatient?: number[] }
            | undefined,
        );
        return { sortedIds, seriesUid: candidate.seriesUid };
      }

      return selector.preferFirst ? resolveDisplaySeriesIds(poolBase) : { sortedIds: [], seriesUid: undefined };
    },
    [resolveDisplaySeriesIds],
  );
  // Track viewport IDs currently registered with the rendering engine + tool
  // groups so the next layout transition can detach stale ones before re-binding.
  // Without this, STACK→ORTHOGRAPHIC re-registration (the MPR toggle path) leaves
  // viewport-0 attached under its prior type and the new addViewport silently
  // throws "already in group" — root cause of the MPR off-then-on regression.
  // id → viewport type currently registered with the engine. Tracking the TYPE
  // (not just the id) lets reconcileViewports detect a same-id type swap
  // (STACK→VOLUME_3D) and force a clean teardown.
  const registeredViewportIdsRef = useRef<Map<string, RegisteredVpType>>(new Map());

  // [DEV-ONLY] Structure-isolation primitive harness — extracted verbatim to
  // useIsolationDebugHarness (finding EMR-PACS-IMAGING-AUDIT-009). Guarded by
  // import.meta.env.DEV inside the hook, so it is stripped from production
  // builds and never runs for clinicians.
  useIsolationDebugHarness({ activeViewportId: viewerState?.activeViewportId, activeVolumeIdRef });

  // Unmount-only cleanup: detach all registered viewports from both tool groups
  // and the rendering engine so a remount (e.g., HMR or route re-entry) starts
  // from a clean slate. Per-layout-transition detaches happen inline in the
  // rendering effect; this effect runs ONLY at unmount.
  useEffect(() => {
    const idsSnapshotRef = registeredViewportIdsRef;
    return () => {
      // WEBGL-LEAK FIX: use the READ-ONLY accessor, never getOrCreateRenderingEngine().
      // In CS3D 4.22 constructing a RenderingEngine eagerly allocates a pool of 7
      // WebGL2 contexts. The hook's own teardown (destroyRenderingEngine) usually runs
      // first, so getOrCreateRenderingEngine() here would RESURRECT a fresh 7-context
      // engine just to detach a stale id list — then never free it. Repeated on every
      // unmount (incl. StrictMode's double-mount) that exhausts the browser's ~16
      // context cap → "Too many active WebGL contexts" + dead rendering. Detaching from
      // an already-destroyed/absent engine is a no-op, so skip it entirely.
      const engine = getRenderingEngine(RENDERING_ENGINE_ID);
      if (!engine || (engine as { hasBeenDestroyed?: boolean }).hasBeenDestroyed) {
        idsSnapshotRef.current = new Map();
        return;
      }
      try {
        const ids = [...idsSnapshotRef.current.keys()];
        if (ids.length > 0) {
          detachViewportIds(ids, engine, getOrCreateToolGroup());
          detachViewportIds(ids, engine, getOrCreateVrToolGroup());
        }
        idsSnapshotRef.current = new Map();
      } catch (err) {
        console.warn('[PACSViewer] unmount viewport cleanup failed:', err);
      }
    };
  }, []);

  // STRUCTURAL key for the viewport set: layout + each pane's id:type. This is
  // STABLE across camera-frame mutations (zoom/pan/rotation/W-L) which replace
  // the viewerState.viewports Map ~30-60×/sec. Using this as the render effect's
  // dependency — instead of the volatile `viewerState.viewports` identity —
  // stops a camera frame from re-triggering the effect mid-setup and cancelling
  // the async volume load (the "3D→MPR leaves black panes" bug). The effect
  // still re-runs whenever a pane is added/removed or changes type (e.g. a
  // VOLUME_3D pane becoming an ORTHOGRAPHIC MPR pane).
  const viewportImageIds = viewerState?.imageIds;
  const viewportImageIdsKey = useMemo(() => viewportImageIds?.join('\n') ?? '', [viewportImageIds]);
  const viewportLayout = viewerState?.viewportLayout;
  const viewportsRef = useRef(viewerState?.viewports);
  // Keep the latest viewport Map available without making the heavy rebuild
  // effect depend on the Map identity churn from camera/window-level updates.
  useEffect(() => {
    viewportsRef.current = viewerState?.viewports;
  }, [viewerState?.viewports]);

  const viewportStructureKey = viewportLayout && viewerState?.viewports
    ? `${viewportLayout}|${[...viewerState.viewports.entries()]
        .map(([id, vp]) => `${id}:${vp.type}`)
        .join(',')}`
    : '';

  useEffect(() => {
    const imageIds = viewportImageIds;
    const currentLayout = viewportLayout;

    // Re-run when layout changes (e.g., MPR/3D toggle creates new viewport slots)
    const layoutChanged = currentLayout !== layoutRef.current;
    if (layoutChanged) {
      layoutRef.current = currentLayout;
      imageIdsRef.current = undefined; // Force re-setup of viewports
    }

    // Only run when imageIds actually change (prevents re-renders from other state updates)
    if (!imageIds || imageIds.length === 0 || imageIds === imageIdsRef.current) {
      return;
    }

    const viewports = viewportsRef.current;
    if (!viewports || status !== 'ready') {
      return;
    }
    // NOTE: imageIdsRef.current (the "this layout is already set up" marker) is
    // set INSIDE the deferred setTimeout below — AFTER setViewports actually
    // runs — NOT here. Marking it synchronously was a race: a spurious second
    // effect run (same layout, e.g. a stray viewports state update right after
    // a 3D↔MPR toggle) would clear the pending setup timer via cleanup and then
    // early-return because the marker already said "done" — so the viewport
    // rebuild was silently skipped (3D→MPR left the stale VR pane). Marking only
    // when the work truly runs makes a cleared-timer re-run re-schedule setup.
    // D3: mirror the full all-series list into the cleanup hook so unmount
    // evicts exactly this study's images (not a global purge).
    studyImageIdsRef.current = imageIds;

    // Detect the four render-effect branches:
    //   isMixedMode          → '2x2-mpr-vr' (3 MPR + 1 VR, both volume + volume3d present)
    //   isSingleVolumeAxial  → '1x1-axial'  (one ORTHOGRAPHIC axial pane)
    //   isVolumeMode (3MPR)  → '1x3-mpr'    (three ORTHOGRAPHIC panes)
    //   isVolume3DMode (VR)  → '1x1' single volume3d viewport
    //   else                 → STACK path
    // The mixed/single-axial branches must be tested BEFORE isVolumeMode/isVolume3DMode
    // so a mixed-mode layout (which has both volume AND volume3d viewports) doesn't
    // accidentally trigger the pure-MPR branch and skip the VR pane.
    const hasVolume = Array.from(viewports.values()).some((vp) => vp.type === 'volume');
    const hasVolume3D = Array.from(viewports.values()).some((vp) => vp.type === 'volume3d');
    const isMixedMode = hasVolume && hasVolume3D;
    const isSingleVolumeAxial = currentLayout === '1x1-axial';
    const isVolumeMode = !isMixedMode && !isSingleVolumeAxial && hasVolume;
    const isVolume3DMode = !isMixedMode && hasVolume3D;

    // PACS black-slices fix: do NOT destroy the active volume on a layout switch.
    // Previously, switching to a pure-STACK layout called
    // cache.removeVolumeLoadObject(activeVolumeIdRef) + nulled the ref. But a
    // layout toggle (MPR→1×1, 3D→grid, …) runs through transient layouts, so this
    // fired mid-transition and FORCED the next volume layout to rebuild from
    // scratch (volumeId became null → the reuse fast-path below was skipped). That
    // rebuild's createAndCacheVolume + volume.load() raced the teardown's aborted
    // in-flight frame XHRs and/or uploaded a half-allocated scalar buffer →
    // permanently BLACK panes ("Error caching image: XMLHttpRequest" /
    // "texImage2D: ArrayBufferView not big enough"). Keeping the volume cached lets
    // the reuse guard (cache.getVolume + volumeSeriesMatches) hit on the way back —
    // instant, no re-fetch, no race. The volume is still freed on a genuine study
    // change (the study-load effect, which now re-runs only when studyInstanceUid
    // changes) and on unmount (useViewerCacheCleanup), and overall memory stays
    // bounded by the 3GB/512MB CS3D cache budget.

    let cancelled = false;

    // Small delay to ensure the DOM elements are rendered before Cornerstone3D grabs them
    const timer = setTimeout(async () => {
      try {
        if (cancelled) return;
        // Mark this imageIds as set-up ONLY now that the deferred work runs (see
        // note above). A re-run that cleared this timer will have left the marker
        // unset and will therefore re-schedule setup instead of early-returning.
        imageIdsRef.current = imageIds;
        const renderingEngine = getOrCreateRenderingEngine();

        if (isMixedMode) {
          // ── Mixed Path: 3 MPR (ORTHOGRAPHIC) + 1 VR (VOLUME_3D) ──
          // Triggered when the 3D button is pressed FROM 3MPR. The activate3D
          // hook seeds viewport-0/1/2 as 'volume' and viewport-3 as 'volume3d'
          // via createViewportsForLayout('2x2-mpr-vr'). All four share ONE
          // cached volume — same volume the MPR branch built, kept alive by
          // the cleanup guard at line 951 because activeVolumeIdRef is set.
          //
          // This is the "MPR+VR coexistence" pattern from TAVI Step 9 (see
          // AccessRouteVrViewport.tsx) — except here the layout is created
          // atomically so we use ONE setViewports(4) call instead of TAVI's
          // additive enableElement.
          const orientations = [
            csEnums.OrientationAxis.AXIAL,
            csEnums.OrientationAxis.SAGITTAL,
            csEnums.OrientationAxis.CORONAL,
          ];
          const mixedInputs: Array<{
            viewportId: string;
            type: typeof csEnums.ViewportType.ORTHOGRAPHIC | typeof csEnums.ViewportType.VOLUME_3D;
            element: HTMLDivElement;
            defaultOptions: { orientation?: csEnums.OrientationAxis; background?: [number, number, number] };
          }> = [];
          const mpriVpIds: string[] = [];
          let mixedVrVpId: string | null = null;
          let mixedVrPreset: TransferFunctionPreset = 'CtVessel';
          let orientIdx = 0;
          for (const [vpId, vpState] of viewports) {
            // The cs3d-* canvas hosts are always <div>s (PACSViewportGrid) —
            // narrow getElementById's HTMLElement for Cornerstone's PublicViewportInput.
            const element = document.getElementById(`cs3d-${vpId}`) as HTMLDivElement | null;
            if (!element) continue;
            if (vpState.type === 'volume3d') {
              mixedInputs.push({
                viewportId: vpId,
                type: csEnums.ViewportType.VOLUME_3D,
                element,
                // `orientation` triggers Cornerstone3D's internal
                // applyViewOrientation in the VolumeViewport3D constructor,
                // which is the only camera-setup path that correctly negates
                // viewPlaneNormal before calling setDirectionOfProjection.
                // CORONAL = anatomical anterior view (patient facing viewer,
                // head up). Setting this here avoids the black-canvas trap
                // of calling setCamera({viewPlaneNormal,viewUp}) externally.
                defaultOptions: {
                  background: [0, 0, 0],
                  orientation: csEnums.OrientationAxis.CORONAL,
                },
              });
              mixedVrVpId = vpId;
              mixedVrPreset = vpState.volume3DPreset ?? 'CtVessel';
            } else {
              mixedInputs.push({
                viewportId: vpId,
                type: csEnums.ViewportType.ORTHOGRAPHIC,
                element,
                defaultOptions: {
                  orientation: orientations[orientIdx] ?? csEnums.OrientationAxis.AXIAL,
                },
              });
              mpriVpIds.push(vpId);
              orientIdx++;
            }
          }
          if (mixedInputs.length !== 4 || !mixedVrVpId) return;
          setVrBuildStatus(mixedVrVpId, 'building');

          if (cancelled) return;
          // Reconcile registration before rebinding. 3 MPR panes are 'volume'
          // (ORTHOGRAPHIC), the VR pane is 'volume3d' — any id whose type changed
          // since the last render gets disabled first so setViewports can't no-op.
          registeredViewportIdsRef.current = reconcileViewports(
            registeredViewportIdsRef.current,
            new Map<string, RegisteredVpType>([
              ...mpriVpIds.map((id) => [id, 'volume'] as const),
              [mixedVrVpId, 'volume3d'] as const,
            ]),
            renderingEngine,
            getOrCreateToolGroup(),
            getOrCreateVrToolGroup()
          );
          renderingEngine.setViewports(mixedInputs);

          // Wire only the 3 MPR panes into the ToolGroup for Crosshairs
          // navigation. The VR pane (VOLUME_3D) is DELIBERATELY excluded —
          // keeping it out of the tool group lets Cornerstone3D's native
          // VOLUME_3D trackball handler (left-drag rotate, right-drag zoom,
          // middle-drag pan) fire. Adding the VR pane would bind Crosshairs
          // to its LMB and suppress the native rotation — that's the bug
          // that made 3D "static-looking." This mirrors TAVI Step 9 (see
          // AccessRouteVrViewport.tsx:140-156) and the solo-VR branch below.
          const mixedToolGroup = getOrCreateToolGroup();
          for (const inp of mixedInputs) {
            if (inp.type === csEnums.ViewportType.VOLUME_3D) continue;
            try { mixedToolGroup.addViewport(inp.viewportId, renderingEngine.id); } catch (err) { console.warn('[PACSViewer] addViewport (mixed-mode MPR pane):', err); }
          }

          // Bind the VR pane to the dedicated VR tool group so left-drag
          // rotates, right-drag zooms, middle-drag pans. The MPR tool group
          // above excludes VOLUME_3D viewports for the opposite reason — the
          // VR pane belongs in this separate group with TrackballRotate on LMB.
          try {
            getOrCreateVrToolGroup().addViewport(mixedVrVpId, renderingEngine.id);
          } catch (vrToolErr) {

            console.warn('[PACSViewer] mixed-mode VR tool-group bind failed:', vrToolErr);
          }

          // VOLUME REUSE: if MPR already built a cached volume, reuse it
          // (instant transition). Else fall back to building a fresh one
          // (covers the "page reload mid-mixed" recovery path).
          const { sortedIds: sortedMixedIds, seriesUid: mixedSeriesUid } = resolveDisplaySeriesIds(imageIds);
          const mixedPrevVolumeId = activeVolumeIdRef.current;
          let mixedVolumeId = mixedPrevVolumeId;
          const mixedCached = mixedVolumeId ? cache.getVolume?.(mixedVolumeId) : null;
          const mixedSeriesMatches = activeVolumeSeriesUidRef.current === mixedSeriesUid;
          let mixedBuiltVolumeId: string | undefined;
          const dropMixedBuiltVolume = (): void => {
            if (!mixedBuiltVolumeId) return;
            try { cache.removeVolumeLoadObject(mixedBuiltVolumeId); } catch (err) { console.warn('[PACSViewer] failed to remove cancelled mixed volume:', err); }
          };
          if (!mixedVolumeId || !mixedCached || !mixedSeriesMatches || !isCachedVolumeUsable(mixedCached)) {
            // Pre-flight: don't crash the volume build on a non-volumetric series.
            if (!canFormVolume(sortedMixedIds)) {
              console.warn('[PACSViewer] mixed-mode series is not volumetric — falling back to 2D stack');
              setViewportLayout('1x1');
              return;
            }
            mixedVolumeId = `cornerstoneStreamingImageVolume:mixed_${Date.now()}`;
            mixedBuiltVolumeId = mixedVolumeId;
            evictFramesForRebuild(sortedMixedIds);
            try {
              const mixedVolume = await volumeLoader.createAndCacheVolume(mixedVolumeId, { imageIds: sortedMixedIds });
              if (cancelled) { dropMixedBuiltVolume(); return; }
              await mixedVolume.load();
              if (cancelled) { dropMixedBuiltVolume(); return; }
              applyVolumePrefetchBias({
                volume: mixedVolume,
                centerIndex: Math.floor(sortedMixedIds.length * 0.5),
                windowFrames: 24,
              });
            } catch (buildErr) {
              dropMixedBuiltVolume();
              throw buildErr;
            }
          }

          // Single bind: same volumeId to all 4 viewports — MPR slices and VR
          // share the GPU volume actor.
          if (!mixedVolumeId) return;
          try {
            await setVolumesForViewports(
              renderingEngine,
              [{ volumeId: mixedVolumeId }],
              [...mpriVpIds, mixedVrVpId],
            );
          } catch (bindErr) {
            dropMixedBuiltVolume();
            throw bindErr;
          }
          if (cancelled) { dropMixedBuiltVolume(); return; }
          if (mixedBuiltVolumeId) {
            activeVolumeIdRef.current = mixedBuiltVolumeId;
            activeVolumeSeriesUidRef.current = mixedSeriesUid;
            if (mixedPrevVolumeId && mixedPrevVolumeId !== mixedBuiltVolumeId) {
              try { cache.removeVolumeLoadObject(mixedPrevVolumeId); } catch (err) { console.warn('[PACSViewer] failed to remove previous mixed volume:', err); }
              try { cache.removeVolumeLoadObject(`${mixedPrevVolumeId}${MASKED_VOLUME_SUFFIX}`); } catch (err) { console.warn('[PACSViewer] failed to remove masked previous mixed volume:', err); }
            }
          }

          // Apply the VR preset to viewport-3 only.
          const mixedVrVp = renderingEngine.getViewport(mixedVrVpId);
          if (isVolumePresetViewport(mixedVrVp)) {
            const vtkPreset = VOLUME_PRESET_VTK_NAME[mixedVrPreset] ?? mixedVrPreset;
            try {
              mixedVrVp.setProperties({ preset: vtkPreset });
            } catch (presetErr) {
              console.warn('[PACSViewer] mixed-mode VR preset apply failed:', presetErr);
            }
          }

          // Reset cameras + render on all 4 panes. The VR pane's anterior
          // orientation is already set via defaultOptions.orientation =
          // CORONAL above (CS3D's internal applyViewOrientation handles
          // the camera math), so a plain resetCamera() here is correct.
          for (const inp of mixedInputs) {
            const vp = renderingEngine.getViewport(inp.viewportId);
            if (vp) {
              vp.resetCamera();
              vp.render();
            }
          }
          if (mixedVrVpId) setVrBuildStatus(mixedVrVpId, 'ready');

          // Re-assert Crosshairs PASSIVE after the volume bind so the tool
          // re-seeds its center against valid camera state (same fix as
          // the MPR branch — TaviViewportGrid.tsx:560-572 mirror).
          try {
            const crosshairName = cornerstoneTools.CrosshairsTool.toolName;
            if (mixedToolGroup.hasTool(crosshairName)) {
              mixedToolGroup.setToolPassive(crosshairName);
            }
            renderingEngine.render();
          } catch (xhErr) {
            console.warn('[PACSViewer] crosshair re-assert (mixed) failed:', xhErr);
          }
        } else if (isVolumeMode) {
          // ── MPR Volume Path ──
          // Create 3 orthographic viewports (axial, sagittal, coronal) that slice
          // through a 3D volume built from the 2D image stack.
          const orientations = [
            csEnums.OrientationAxis.AXIAL,
            csEnums.OrientationAxis.SAGITTAL,
            csEnums.OrientationAxis.CORONAL,
          ];

          const viewportInputs = [];
          let vpIndex = 0;
          for (const [vpId] of viewports) {
            // The cs3d-* canvas hosts are always <div>s (PACSViewportGrid) —
            // narrow getElementById's HTMLElement for Cornerstone's PublicViewportInput.
            const element = document.getElementById(`cs3d-${vpId}`) as HTMLDivElement | null;
            if (element) {
              viewportInputs.push({
                viewportId: vpId,
                type: csEnums.ViewportType.ORTHOGRAPHIC,
                element,
                defaultOptions: {
                  orientation: orientations[vpIndex] ?? csEnums.OrientationAxis.AXIAL,
                },
              });
              vpIndex++;
            }
          }

          if (viewportInputs.length === 0) return;

          if (cancelled) return;
          // Reconcile registration before rebinding (all 3 panes are 'volume').
          registeredViewportIdsRef.current = reconcileViewports(
            registeredViewportIdsRef.current,
            new Map<string, RegisteredVpType>(
              viewportInputs.map((v) => [v.viewportId, 'volume'] as const)
            ),
            renderingEngine,
            getOrCreateToolGroup(),
            getOrCreateVrToolGroup()
          );
          renderingEngine.setViewports(viewportInputs);

          // Wire viewports into the ToolGroup. Disable Crosshairs across the
          // one-at-a-time add loop: the tool recomputes its center on every
          // addViewport and logs "For crosshairs to operate, at least two
          // viewports must be given" while only 1 pane is attached. The tool-
          // activation effect re-promotes it once all panes are present.
          const toolGroup = getOrCreateToolGroup();
          try { toolGroup.setToolDisabled(cornerstoneTools.CrosshairsTool.toolName); } catch (err) { console.warn('[PACSViewer] failed to disable crosshairs before MPR viewport bind:', err); }
          for (const vpInput of viewportInputs) {
            try {
              toolGroup.addViewport(vpInput.viewportId, renderingEngine.id);
            } catch (err) { console.warn('[PACSViewer] addViewport (MPR branch):', err); }
          }

          // Display the operator's SELECTED series (sorted), not always the
          // longest/primary — so toggling into MPR keeps their series. Falls
          // back to the primary on first open. The spatial sort prevents the
          // sagittal/coronal reformats from banding (Cornerstone streams
          // texture planes in imageId-array order, not anatomical Z order).
          const { sortedIds, seriesUid: mprSeriesUid } = resolveDisplaySeriesIds(imageIds);

          // PACS-VOLUME-REUSE: reuse the cached volume across MPR ↔ mixed ↔
          // axial toggles for an instant transition — but ONLY while it's still
          // the operator's selected series. If the selection changed (e.g. they
          // picked a different reconstruction in 2D, then switched to MPR),
          // rebuild from that series instead of silently reverting to primary.
          const prevVolumeId = activeVolumeIdRef.current;
          let volumeId = prevVolumeId;
          const cachedVolume = volumeId ? cache.getVolume?.(volumeId) : null;
          const volumeSeriesMatches = activeVolumeSeriesUidRef.current === mprSeriesUid;
          let builtVolumeId: string | undefined;
          const dropBuiltVolume = (): void => {
            if (!builtVolumeId) return;
            try { cache.removeVolumeLoadObject(builtVolumeId); } catch (err) { console.warn('[PACSViewer] failed to remove cancelled MPR volume:', err); }
          };
          if (!volumeId || !cachedVolume || !volumeSeriesMatches || !isCachedVolumeUsable(cachedVolume)) {
            // Pre-flight: bail out BEFORE createAndCacheVolume on a series that
            // can't form a clean volume — Cornerstone would otherwise throw an
            // uncaught "reading '1' of undefined" and leave the panes white.
            // Drop to a 2D stack layout so the operator SEES the scan (and it
            // loads far faster — the stack decodes lazily vs. the volume loading
            // every slice).
            if (!canFormVolume(sortedIds)) {
              console.warn('[PACSViewer] MPR series is not volumetric — falling back to 2D stack');
              setViewportLayout('1x1');
              return;
            }
            volumeId = `cornerstoneStreamingImageVolume:mpr_${Date.now()}`;
            builtVolumeId = volumeId;
            evictFramesForRebuild(sortedIds);
            try {
              const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds: sortedIds });
              if (cancelled) { dropBuiltVolume(); return; }

              // Load pixel data into the volume (streams in background)
              await volume.load();
              if (cancelled) { dropBuiltVolume(); return; }

              // Promote a ±24-frame window around the center of the volume to
              // priority 0 so the operator's first paint + nearby scrub range
              // jumps the queue ahead of the rest of the load (mirrors TAVI's
              // useStudyVolume.ts:343-407 C4 prefetch bias). Best-effort: the
              // utility never throws — failure means the flat-priority load
              // still completes in the background.
              applyVolumePrefetchBias({
                volume,
                centerIndex: Math.floor(sortedIds.length * 0.5),
                windowFrames: 24,
              });
            } catch (buildErr) {
              dropBuiltVolume();
              throw buildErr;
            }
          }

          // Assign the volume to all 3 viewports
          if (!volumeId) return;
          try {
            await setVolumesForViewports(
              renderingEngine,
              [{ volumeId }],
              viewportInputs.map((vp) => vp.viewportId)
            );
          } catch (bindErr) {
            dropBuiltVolume();
            throw bindErr;
          }
          if (cancelled) { dropBuiltVolume(); return; }
          if (builtVolumeId) {
            activeVolumeIdRef.current = builtVolumeId;
            activeVolumeSeriesUidRef.current = mprSeriesUid;
            if (prevVolumeId && prevVolumeId !== builtVolumeId) {
              try { cache.removeVolumeLoadObject(prevVolumeId); } catch (err) { console.warn('[PACSViewer] failed to remove previous MPR volume:', err); }
              try { cache.removeVolumeLoadObject(`${prevVolumeId}${MASKED_VOLUME_SUFFIX}`); } catch (err) { console.warn('[PACSViewer] failed to remove masked previous MPR volume:', err); }
            }
          }

          // Make a window/level drag on ANY pane adjust ALL panes together, and
          // tear down any synchronizer left over from a prior layout.
          syncVoiAcrossViewports(viewportInputs.map((v) => v.viewportId));

          // Reset cameras so each plane is centered and render
          for (const vpInput of viewportInputs) {
            const vp = renderingEngine.getViewport(vpInput.viewportId);
            if (vp) {
              vp.resetCamera();
              // Apply an explicit VOI so the axial native plane never renders
              // white from Cornerstone's pre-stream auto-VOI (the axial pane is
              // computed first, before the volume finishes streaming, and lands
              // on a degenerate range). Mirror of TaviViewportGrid.tsx:921-936.
              const wl = viewports.get(vpInput.viewportId)?.windowLevel;
              if (wl) {
                try {
                  setViewportVoiRange(vp, wl.center - wl.width / 2, wl.center + wl.width / 2);
                } catch (wlErr) { console.warn('[PACSViewer] initial W/L apply failed:', wlErr); }
              }
              vp.render();
            }
          }

          // Re-assert Crosshairs PASSIVE AFTER volume bind + camera reset so
          // CrosshairsTool._computeToolCenter re-seeds the colored reference
          // lines against valid camera/world state. Without this the first
          // passive seed can run with degenerate
          // camera state and the lines either paint at wrong positions or
          // don't paint until the operator manually scrubs (the "line issues"
          // reported here). Verbatim mirror of TaviViewportGrid.tsx:560-572.
          try {
            const crosshairName = cornerstoneTools.CrosshairsTool.toolName;
            if (toolGroup.hasTool(crosshairName)) {
              toolGroup.setToolPassive(crosshairName);
            }
            renderingEngine.render();
          } catch (xhErr) {
            console.warn('[PACSViewer] crosshair re-assert failed:', xhErr);
          }
        } else if (isSingleVolumeAxial) {
          // ── Single Volume-backed AXIAL Path ──
          // One ORTHOGRAPHIC viewport in AXIAL orientation, backed by the
          // same cached volume as MPR. Used as the M-key exit target so
          // leaving 3MPR drops into smooth reslice-grade single-axial
          // instead of a slow STACK '1x1'. Pattern source: TAVI Step 8
          // "Calcium Burden" (TaviViewportGrid.tsx:284-289 + 387-400).
          const axialEntry = Array.from(viewports.entries())[0];
          if (!axialEntry) return;
          const [axialVpId] = axialEntry;
          const axialElement = document.getElementById(`cs3d-${axialVpId}`) as HTMLDivElement | null;
          if (!axialElement) return;

          if (cancelled) return;
          // Reconcile registration before rebinding (single 'volume' axial pane).
          registeredViewportIdsRef.current = reconcileViewports(
            registeredViewportIdsRef.current,
            new Map<string, RegisteredVpType>([[axialVpId, 'volume']]),
            renderingEngine,
            getOrCreateToolGroup(),
            getOrCreateVrToolGroup()
          );
          renderingEngine.setViewports([
            {
              viewportId: axialVpId,
              type: csEnums.ViewportType.ORTHOGRAPHIC,
              element: axialElement,
              defaultOptions: { orientation: csEnums.OrientationAxis.AXIAL },
            },
          ]);

          const axialToolGroup = getOrCreateToolGroup();
          try { axialToolGroup.addViewport(axialVpId, renderingEngine.id); } catch (err) { console.warn('[PACSViewer] addViewport (single-axial branch):', err); }

          // VOLUME REUSE: same guard pattern as the MPR branch. If we just
          // came from 3MPR, the volume is already cached and the transition
          // is instant.
          const { sortedIds: sortedAxialIds, seriesUid: axialSeriesUid } = resolveDisplaySeriesIds(imageIds);
          const axialPrevVolumeId = activeVolumeIdRef.current;
          let axialVolumeId = axialPrevVolumeId;
          const axialCached = axialVolumeId ? cache.getVolume?.(axialVolumeId) : null;
          const axialSeriesMatches = activeVolumeSeriesUidRef.current === axialSeriesUid;
          let axialBuiltVolumeId: string | undefined;
          const dropAxialBuiltVolume = (): void => {
            if (!axialBuiltVolumeId) return;
            try { cache.removeVolumeLoadObject(axialBuiltVolumeId); } catch (err) { console.warn('[PACSViewer] failed to remove cancelled axial volume:', err); }
          };
          if (!axialVolumeId || !axialCached || !axialSeriesMatches || !isCachedVolumeUsable(axialCached)) {
            // Pre-flight: don't crash the volume build on a non-volumetric series.
            if (!canFormVolume(sortedAxialIds)) {
              console.warn('[PACSViewer] single-axial series is not volumetric — falling back to 2D stack');
              setViewportLayout('1x1');
              return;
            }
            axialVolumeId = `cornerstoneStreamingImageVolume:axial_${Date.now()}`;
            axialBuiltVolumeId = axialVolumeId;
            evictFramesForRebuild(sortedAxialIds);
            try {
              const axialVolume = await volumeLoader.createAndCacheVolume(axialVolumeId, { imageIds: sortedAxialIds });
              if (cancelled) { dropAxialBuiltVolume(); return; }
              await axialVolume.load();
              if (cancelled) { dropAxialBuiltVolume(); return; }
              applyVolumePrefetchBias({
                volume: axialVolume,
                centerIndex: Math.floor(sortedAxialIds.length * 0.5),
                windowFrames: 24,
              });
            } catch (buildErr) {
              dropAxialBuiltVolume();
              throw buildErr;
            }
          }

          if (!axialVolumeId) return;
          try {
            await setVolumesForViewports(renderingEngine, [{ volumeId: axialVolumeId }], [axialVpId]);
          } catch (bindErr) {
            dropAxialBuiltVolume();
            throw bindErr;
          }
          if (cancelled) { dropAxialBuiltVolume(); return; }
          if (axialBuiltVolumeId) {
            activeVolumeIdRef.current = axialBuiltVolumeId;
            activeVolumeSeriesUidRef.current = axialSeriesUid;
            if (axialPrevVolumeId && axialPrevVolumeId !== axialBuiltVolumeId) {
              try { cache.removeVolumeLoadObject(axialPrevVolumeId); } catch (err) { console.warn('[PACSViewer] failed to remove previous axial volume:', err); }
              try { cache.removeVolumeLoadObject(`${axialPrevVolumeId}${MASKED_VOLUME_SUFFIX}`); } catch (err) { console.warn('[PACSViewer] failed to remove masked previous axial volume:', err); }
            }
          }

          // Single pane → clears any MPR synchronizer left over from 3MPR
          // (syncVoiAcrossViewports is a no-op + clear when given <2 ids).
          syncVoiAcrossViewports([axialVpId]);

          const axialVp = renderingEngine.getViewport(axialVpId);
          if (axialVp) {
            axialVp.resetCamera();
            // Explicit VOI so the single axial pane never renders white from
            // Cornerstone's pre-stream auto-VOI (same fix as the MPR branch).
            const axialWl = axialEntry[1]?.windowLevel;
            if (axialWl) {
              try {
                setViewportVoiRange(axialVp, axialWl.center - axialWl.width / 2, axialWl.center + axialWl.width / 2);
              } catch (wlErr) { console.warn('[PACSViewer] initial W/L apply (single-axial) failed:', wlErr); }
            }
            axialVp.render();
          }
        } else if (isVolume3DMode) {
          // ── 3D Volume Rendering (VR) Path ──
          // The is3DActive toggle creates a single viewport-0 entry with
          // type: 'volume3d'. Build a VOLUME_3D viewport and apply the
          // friendly preset (translated to a real VTK preset name via the
          // VOLUME_PRESET_VTK_NAME map). Mirrors AccessRouteVrViewport.tsx
          // (TAVI Step-9 VR) at the engine level — same singleton, same
          // cached-volume reuse pattern, distinct viewport id.
          const vrViewportEntry = Array.from(viewports.entries()).find(
            ([, vp]) => vp.type === 'volume3d',
          );
          if (!vrViewportEntry) { return; }
          const [vrVpId, vrVpState] = vrViewportEntry;
          const element = document.getElementById(`cs3d-${vrVpId}`) as HTMLDivElement | null;
          if (!element) { return; }
          setVrBuildStatus(vrVpId, 'building');

          if (cancelled) { return; }
          // Reconcile registration before rebinding. The solo VR pane reuses
          // 'viewport-0' but flips its type to 'volume3d' — reconcileViewports
          // disables the prior STACK slot so this VOLUME_3D bind actually swaps
          // (the fix for "3D only opens the first time").
          registeredViewportIdsRef.current = reconcileViewports(
            registeredViewportIdsRef.current,
            new Map<string, RegisteredVpType>([[vrVpId, 'volume3d']]),
            renderingEngine,
            getOrCreateToolGroup(),
            getOrCreateVrToolGroup()
          );
          renderingEngine.setViewports([
            {
              viewportId: vrVpId,
              type: csEnums.ViewportType.VOLUME_3D,
              element,
              // CORONAL orientation = anterior anatomical view; CS3D's
              // VolumeViewport3D constructor applies the correct camera
              // pose via its protected applyViewOrientation method.
              defaultOptions: {
                background: [0, 0, 0],
                orientation: csEnums.OrientationAxis.CORONAL,
              },
            },
          ]);

          // Apply same selected-series sort + narrow as MPR.
          const { sortedIds: sortedVrIds, seriesUid: vrSeriesUid } = resolveDisplaySeriesIds(imageIds);

          // Decimate to an overview-resolution slice-subset for the SOLO VR pane
          // (smaller 3D texture → smoother rotate/crop + faster build). Solo VR
          // feeds only this pane; MPR/measurements use the full-res volume elsewhere.
          const vrVolumeIds = decimateImageIdsForVr(sortedVrIds);
          if (!canFormVolume(vrVolumeIds)) {
            setVrBuildStatus(vrVpId, 'error');
            console.warn('[PACSViewer] VR series is not volumetric — falling back to 2D stack');
            // Consistent with the MPR/mixed/axial/series-switch fallbacks: drop to a
            // viewable 2D stack instead of stranding the operator on an error card.
            setViewportLayout('1x1');
            return;
          }
          const prevVolumeId = activeVolumeIdRef.current;
          const volumeId = `cornerstoneStreamingImageVolume:vr_${Date.now()}`;
          const dropVrBuiltVolume = (): void => {
            try { cache.removeVolumeLoadObject(volumeId); } catch (err) { console.warn('[PACSViewer] failed to remove cancelled VR volume:', err); }
          };
          evictFramesForRebuild(vrVolumeIds);
          try {
            const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds: vrVolumeIds });
            if (cancelled) { dropVrBuiltVolume(); return; }
            await volume.load();
            if (cancelled) { dropVrBuiltVolume(); return; }
            applyVolumePrefetchBias({
              volume,
              centerIndex: Math.floor(vrVolumeIds.length * 0.5),
              windowFrames: 24,
            });
          } catch (buildErr) {
            dropVrBuiltVolume();
            throw buildErr;
          }

          try {
            await setVolumesForViewports(renderingEngine, [{ volumeId }], [vrVpId]);
          } catch (bindErr) {
            dropVrBuiltVolume();
            throw bindErr;
          }
          if (cancelled) { dropVrBuiltVolume(); return; }
          activeVolumeIdRef.current = volumeId;
          activeVolumeSeriesUidRef.current = vrSeriesUid;
          if (prevVolumeId && prevVolumeId !== volumeId) {
            try { cache.removeVolumeLoadObject(prevVolumeId); } catch (err) { console.warn('[PACSViewer] failed to remove previous VR volume:', err); }
            try { cache.removeVolumeLoadObject(`${prevVolumeId}${MASKED_VOLUME_SUFFIX}`); } catch (err) { console.warn('[PACSViewer] failed to remove masked previous VR volume:', err); }
          }

          // Bind the VR viewport to the dedicated VR tool group so LMB
          // rotates, RMB zooms, MMB pans. Solo-3D and mixed-3D share this
          // same group — adding the same viewport twice is a safe no-op.
          try {
            getOrCreateVrToolGroup().addViewport(vrVpId, renderingEngine.id);
          } catch (vrToolErr) {

            console.warn('[PACSViewer] solo VR tool-group bind failed:', vrToolErr);
          }

          // Apply the friendly preset → real VTK preset name. setProperties
          // does strict-equality matching against CONSTANTS.VIEWPORT_PRESETS
          // (BaseVolumeViewport.js:885-898); pass the translated VTK name or
          // the call silently no-ops. setProperties also no-ops if called
          // before the volume actor exists — we already awaited
          // setVolumesForViewports, so the actor is ready here.
          const vrViewport = renderingEngine.getViewport(vrVpId);
          if (isVolumePresetViewport(vrViewport)) {
            const friendlyPreset = vrVpState.volume3DPreset ?? 'CtVessel';
            const vtkPreset = VOLUME_PRESET_VTK_NAME[friendlyPreset] ?? friendlyPreset;
            try {
              vrViewport.setProperties({ preset: vtkPreset });
            } catch (presetErr) {
              console.warn('[PACSViewer] VR preset apply failed:', presetErr);
            }
            // Anterior pose is set via defaultOptions.orientation = CORONAL
            // above. resetCamera reframes the volume; CS3D preserves the
            // initial orientation across reset by default.
            vrViewport.resetCamera?.();
            vrViewport.render?.();
          }
          setVrBuildStatus(vrVpId, 'ready');
        } else {
          // ── Stack Path (original behavior) ──
          const viewportInputs = [];

          for (const [vpId] of viewports) {
            // The cs3d-* canvas hosts are always <div>s (PACSViewportGrid) —
            // narrow getElementById's HTMLElement for Cornerstone's PublicViewportInput.
            const element = document.getElementById(`cs3d-${vpId}`) as HTMLDivElement | null;
            if (element) {
              viewportInputs.push({
                viewportId: vpId,
                type: csEnums.ViewportType.STACK,
                element,
              });
            }
          }

          if (viewportInputs.length === 0) return;

          if (cancelled) return;
          // Reconcile registration before rebinding (all panes are 'stack').
          registeredViewportIdsRef.current = reconcileViewports(
            registeredViewportIdsRef.current,
            new Map<string, RegisteredVpType>(
              viewportInputs.map((v) => [v.viewportId, 'stack'] as const)
            ),
            renderingEngine,
            getOrCreateToolGroup(),
            getOrCreateVrToolGroup()
          );
          renderingEngine.setViewports(viewportInputs);

          const toolGroup = getOrCreateToolGroup();
          for (const vpInput of viewportInputs) {
            try {
              toolGroup.addViewport(vpInput.viewportId, renderingEngine.id);
            } catch (err) { console.warn('[PACSViewer] addViewport (stack branch):', err); }
          }

          // Mammography 4-up: place LCC/RCC/LMLO/RMLO from per-image laterality +
          // view-position (assignMammoPanes) and mirror the right-breast panes so
          // the two chest walls meet in the middle. Degrades to a single pane when
          // the placement tags are absent.
          if (currentLayout === 'mammo-4up') {
            const { panes, usable } = assignMammoPanes(mammoImagesRef.current);
            if (!usable) {
              // No laterality/view tags to drive placement → collapse to 1x1 (the
              // same graceful fallback the volume-build path uses) and let the
              // effect re-run bind the primary series normally.
              setViewportLayout('1x1');
              return;
            }
            for (const pane of panes) {
              if (!pane.imageId) continue; // missing view → leave that pane empty
              const mammoVp = renderingEngine.getViewport(`viewport-${pane.viewportIndex}`);
              if (!isStackViewport(mammoVp)) continue;
              try {
                await mammoVp.setStack([pane.imageId]);
                if (cancelled) return;
                mammoVp.resetCamera();
                const paneWl = viewports.get(`viewport-${pane.viewportIndex}`)?.windowLevel;
                if (paneWl) {
                  try {
                    setViewportVoiRange(mammoVp, paneWl.center - paneWl.width / 2, paneWl.center + paneWl.width / 2);
                  } catch (wlErr) { console.warn('[PACSViewer] initial W/L apply (mammo stack) failed:', wlErr); }
                }
                // setProperties exists on stack viewports at runtime; Cornerstone's
                // public Viewport union omits it — narrow via the existing guard shape.
                (mammoVp as unknown as { setProperties: (props: unknown) => void }).setProperties({
                  flipHorizontal: pane.flipHorizontal,
                  flipVertical: false,
                  rotation: 0,
                });
                mammoVp.render();
              } catch (paneErr) {
                console.warn('[PACSViewer] mammo pane bind failed:', paneErr);
              }
            }
            cineSetTotalFramesRef.current(1); // FFDM is single-frame
          } else {
            const assignments = activeConfiguration?.viewportAssignments ?? [];
            let assignedAnyStack = false;
            let firstAssignedStack: string[] | undefined;

            for (const assignment of assignments) {
              const assignedViewport = renderingEngine.getViewport(`viewport-${assignment.viewportIndex}`);
              if (!isStackViewport(assignedViewport)) {
                continue;
              }
              const { sortedIds, seriesUid } = resolveProtocolAssignmentSeriesIds(imageIds, assignment);
              if (sortedIds.length === 0) {
                continue;
              }
              await assignedViewport.setStack(sortedIds);
              if (cancelled) return;
              assignedViewport.resetCamera();
              const assignedWl = viewports.get(`viewport-${assignment.viewportIndex}`)?.windowLevel;
              if (assignedWl) {
                try {
                  setViewportVoiRange(assignedViewport, assignedWl.center - assignedWl.width / 2, assignedWl.center + assignedWl.width / 2);
                } catch (wlErr) { console.warn('[PACSViewer] initial W/L apply (assigned stack) failed:', wlErr); }
              }
              assignedViewport.render();
              assignedAnyStack = true;
              firstAssignedStack ??= sortedIds;
              if (assignment.viewportIndex === 0) {
                loadedPrimarySeriesUidRef.current = seriesUid;
                activeStackImageIdsRef.current = sortedIds;
                setCineNativeTimingForStack(sortedIds);
              }
            }

            if (assignedAnyStack) {
              const cineStack = firstAssignedStack ?? [];
              if (cineStack.length > 0 && activeStackImageIdsRef.current !== cineStack) {
                activeStackImageIdsRef.current = cineStack;
                setCineNativeTimingForStack(cineStack);
              }
              cineSetTotalFramesRef.current(cineStack.length || 1);
              if (cineStack.length > 0) {
                warmStackInBackground({ imageIds: cineStack, currentIndex: 0 });
              }
            } else {
              // Load images into the first viewport.
              //
              // D1: `imageIds` is the ENTIRE study — every series concatenated by
              // fetchImageIds. Stacking all of them makes the first decode pass
              // huge and is clinically wrong (the stack scrolls across unrelated
              // acquisitions). Scope the INITIAL stack to one coherent primary
              // series via the shared selectPrimarySeriesImageIds helper (same one
              // the TAVI volume path uses). The FULL per-series list stays in
              // imageIdsRef.current (set above) so the SeriesBrowser filmstrip /
              // handleSeriesSelect can still switch to any other series.
              const viewport = renderingEngine.getViewport('viewport-0');
              if (isStackViewport(viewport)) {
                // Display the operator's SELECTED series (sorted), not always the
                // longest/primary — so changing layout keeps their series. Falls
                // back to the primary on first open. The spatial sort also fixes
                // jerky scrolling on interleaved-acquisition series.
                const { sortedIds: initialImageIds, seriesUid } = resolveDisplaySeriesIds(imageIds);
                loadedPrimarySeriesUidRef.current = seriesUid;
                await viewport.setStack(initialImageIds);
                if (cancelled) return;
                activeStackImageIdsRef.current = initialImageIds;
                setCineNativeTimingForStack(initialImageIds);
                viewport.resetCamera();
                const initialWl = viewports.get('viewport-0')?.windowLevel;
                if (initialWl) {
                  try {
                    setViewportVoiRange(viewport, initialWl.center - initialWl.width / 2, initialWl.center + initialWl.width / 2);
                  } catch (wlErr) { console.warn('[PACSViewer] initial W/L apply (stack) failed:', wlErr); }
                }
                viewport.render();
                cineSetTotalFramesRef.current(initialImageIds.length);
                // Background-warm the rest of the stack through the throttled CS pool
                // so scrolling is smooth quickly (same gentle, 503-safe path the
                // clicked-series switch uses). Best-effort — never awaited.
                warmStackInBackground({ imageIds: initialImageIds, currentIndex: 0 });
              }
            }
          }
        }
      } catch (err) {
        console.warn('Failed to render DICOM images:', err);
        // Surface a per-pane error overlay (with Retry) instead of a silently-black /
        // garbled pane — mark EVERY pane that was building as errored (MPR/stack/axial/VR),
        // so a build failure on any layout degrades to a clean Retry, not a blank square.
        try {
          for (const [vpId] of viewports) {
            setVrBuildStatus(vpId, 'error');
          }
        } catch (overlayErr) {
          console.warn('[PACSViewer] failed to mark viewport build errors:', overlayErr);
        }
      }
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // PACS-H13: drop `viewerState?.activeTool` from this effect's deps. Tool
    // activation is now wired through a dedicated effect below so changing
    // tool does NOT recreate viewports/MPR volumes.
  }, [
    viewportImageIds,
    viewportLayout,
    // Structural key (layout + pane id:type), NOT the volatile viewports Map
    // identity — camera frames mutate the Map ~30-60×/sec and would otherwise
    // re-trigger this effect mid-setup and cancel the async volume load.
    viewportStructureKey,
    status,
    activeVolumeIdRef,
    activeConfiguration?.viewportAssignments,
    resolveDisplaySeriesIds,
    resolveProtocolAssignmentSeriesIds,
    setCineNativeTimingForStack,
    setViewportLayout,
    setVrBuildStatus,
    studyImageIdsRef,
    // PACS-VR-STATE: a Retry from the VR error overlay bumps this to force a rebuild.
    vrRebuildNonce,
  ]);

  // PACS-H13: dedicated tool-activation effect — switches the active tool on
  // the existing tool group without rebuilding viewports.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tool = viewerState?.activeTool;
    if (status === 'ready' && tool) {
      const activateTool = (): void => {
        try {
          activateToolOnGroup(tool);
        } catch (err) {
          console.warn('[PACSViewer] activateToolOnGroup failed', err);
        }
      };
      activateTool();
      timer = setTimeout(activateTool, 125);
    }
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [viewerState?.activeTool, viewportImageIdsKey, viewportStructureKey, status]);

  // PACS-B3: install WebGL context-loss + visibility lifecycle once the first
  // viewport canvas exists. Hook handles rAF retry + cleanup.
  const handleLifecycleReload = useCallback(() => {
    void loadStudy(studyInstanceUid, studyInfo);
  }, [loadStudy, studyInstanceUid, studyInfo]);
  useViewerLifecycle({ enabled: status === 'ready', onReload: handleLifecycleReload });

  // --------------------------------------------------------------------------
  // Auto-select the first series/instance once viewports are ready
  // --------------------------------------------------------------------------
  // Waits for both seriesItems (from fetchImageIds) and status === 'ready'
  // (viewport DOM is set up), then keeps the already loaded primary series
  // active or loads the largest stackable series.
  useEffect(() => {
    if (seriesItems.length > 0 && !initialSeriesSelected.current && status === 'ready') {
      initialSeriesSelected.current = true;
      const autoSelectableSeries = seriesItems
        .filter((s) => s.instanceCount > 0 && !NON_STACKABLE_SERIES_MODALITIES.has((s.modality || '').toUpperCase()))
        .slice()
        .sort((a, b) => b.instanceCount - a.instanceCount);
      const fallbackSeriesUid = autoSelectableSeries[0]?.seriesUid;
      if (!fallbackSeriesUid) {
        return;
      }
      setActiveSeriesUid(loadedPrimarySeriesUidRef.current ?? fallbackSeriesUid);
      // Delay to let the rendering effect finish setting up the viewport.
      // The rendering effect's setStack runs on a 100ms timer and assigns
      // loadedPrimarySeriesUidRef just before it stacks, so this 250ms timer
      // observes the post-D1 value.
      const timer = setTimeout(() => {
        // D2: the rendering effect (D1) already scoped the initial stack to a
        // primary series. If that series exists, the stack is already correct:
        // skip handleSeriesSelect to avoid a second setStack/decode pass.
        const loadedPrimary = loadedPrimarySeriesUidRef.current;
        const targetSeriesUid = loadedPrimary ?? fallbackSeriesUid;
        setActiveSeriesUid(targetSeriesUid);
        if (loadedPrimary) {
          return;
        }
        handleSeriesSelect(targetSeriesUid);
      }, 250);
      return () => clearTimeout(timer);
    }
    // LiverRa tsconfig enforces noImplicitReturns — explicit no-cleanup return.
    return undefined;
  }, [seriesItems, status, handleSeriesSelect]);

  // --------------------------------------------------------------------------
  // Auto-load DICOM SR measurements when viewport is ready (T102)
  // --------------------------------------------------------------------------
  // Runs asynchronously AFTER images are displayed — annotations appear on top
  // without delaying the initial image render. Like loading comments on a
  // document after the text is already visible.
  const srAutoLoaded = useRef(false);
  const dicomSRRef = useRef(dicomSR);
  const tRef = useRef(t);
  useEffect(() => {
    dicomSRRef.current = dicomSR;
    tRef.current = t;
  }, [dicomSR, t]);

  useEffect(() => {
    if (status !== 'ready' || srAutoLoaded.current || !studyInstanceUid) {
      return;
    }
    srAutoLoaded.current = true;

    // Small delay to ensure images are fully rendered before adding annotations
    const timer = setTimeout(async () => {
      try {
        const result = await dicomSRRef.current.autoLoadSR();
        if (result && result.annotationCount > 0) {
          notifications.show({
            title: tRef.current('pacs.sr.loadedTitle'),
            message: tRef.current('pacs.sr.loadedMessage').replace('{count}', String(result.annotationCount)),
            color: 'blue',
          });
        }
        // If result is null or count is 0, no notification — that's normal
      } catch (err) {
        console.warn('[PACSViewer] PACS fallback path failed:', err);
        notifications.show({
          title: tRef.current('pacs.sr.loadWarning'),
          message: tRef.current('pacs.sr.loadRetry'),
          color: 'red',
        });
      }
    }, 500);

    return () => clearTimeout(timer);
  // CROSS-M21 (2026-05-06 audit): `dicomSR` and `t` are mirrored through refs
  // above. Auto-loading must run exactly ONCE per (study, ready) pair; depending
  // on the recreated helper/function identities would repeatedly reschedule this
  // fetch even though srAutoLoaded guards the actual load.
  }, [status, studyInstanceUid]);

  // Reset SR auto-load flag when study changes
  useEffect(() => {
    srAutoLoaded.current = false;
  }, [studyInstanceUid]);

  // Set initial SOP UID once the viewport has loaded its first image
  useInitialSopSync({
    ready: status === 'ready',
    activeSeriesUid,
    activeViewportId: viewerState?.activeViewportId,
    onSopInstanceChange: setCurrentSopInstanceUid,
  });

  // Sync cine playback frame to Cornerstone3D viewport
  useCineFrameSync({
    isMultiFrame: cine.isMultiFrame,
    currentFrame: cine.currentFrame,
    ready: status === 'ready',
    activeViewportId: viewerState?.activeViewportId,
    onSopInstanceChange: setCurrentSopInstanceUid,
  });

  // DSA rendering — apply pixel subtraction when DSA is active
  useDSARenderLoop({
    isActive: dsa.dsaState.isActive,
    showOriginal: dsa.dsaState.showOriginal,
    maskFrameIndex: dsa.dsaState.maskFrameIndex ?? undefined,
    shiftX: dsa.dsaState.shiftX,
    shiftY: dsa.dsaState.shiftY,
    currentFrame: cine.currentFrame,
    ready: status === 'ready',
    viewerState,
    activeStackImageIdsRef,
  });

  // Resize handling — tells Cornerstone3D when the container changes size
  useViewportResize(viewerContainerRef, status === 'ready');

  // Mouse wheel → scroll through slices (standard radiology UX)
  useViewportWheelScroll(viewerState?.activeViewportId, status === 'ready');

  // PACS-P1.1: Feed the user's current slice into the progressive loader so it
  // prefetches nearby frames first (priority window). Listens on Cornerstone3D's
  // STACK_NEW_IMAGE event which fires regardless of input source (wheel, cine,
  // keyboard, slice slider) — one wiring point catches them all.
  useEffect(() => {
    const vpId = viewerState?.activeViewportId;
    if (status !== 'ready' || !vpId) return;
    const element = document.getElementById(`cs3d-${vpId}`);
    if (!element) return;

    interface StackNewImageDetail {
      imageIdIndex?: number;
      imageId?: string;
    }
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<StackNewImageDetail>).detail;
      const idx = detail?.imageIdIndex;
      if (typeof idx === 'number') {
        setProgressivePriorityIndex(idx);
        cine.seekToFrame(idx);
      }
      // Gap-4: keep the "current slice" SOP UID in sync as the user scrolls a
      // stack, so "flag key image" bookmarks the slice actually on screen
      // (previously pinned to the first image for non-cine stacks).
      if (detail?.imageId) {
        setCurrentSopInstanceUid(extractSopUidFromImageId(detail.imageId));
      }
    };

    const eventName = csEnums.Events.STACK_NEW_IMAGE;
    element.addEventListener(eventName, handler);
    return () => element.removeEventListener(eventName, handler);
  }, [status, viewerState?.activeViewportId, setProgressivePriorityIndex, cine.seekToFrame]);

  // --------------------------------------------------------------------------
  // PACS-P1.3: Hanging-protocol prior-comparison auto-load
  // --------------------------------------------------------------------------
  // When the active hanging protocol specifies `priorStudyMatch.enabled = true`
  // and a target `viewportIndex`, automatically load the matched prior study
  // into that side viewport once the main study's images are rendered.
  //
  // Conservative behaviour:
  //   - Only runs when the layout has multiple viewports (priorStudyViewportIndex
  //     is meaningful only with a 1x2 / 2x2 / etc. layout).
  //   - Skips silently on any failure (missing series, fetch error, abort).
  //   - Cancels in-flight prior load when the study switches via AbortController.
  //   - Relies on the P1.2 prefetch having already warmed the browser HTTP cache
  //     for the prior's first series, so the setStack call resolves quickly.
  // --------------------------------------------------------------------------
  const loadPriorStudyEnabled = activeConfiguration?.loadPriorStudy === true;
  const priorStudyViewportIndex = activeConfiguration?.priorStudyViewportIndex;
  const priorStudyInstanceUid = priorStudy?.studyInstanceUid;
  useEffect(() => {
    if (status !== 'ready') return;
    if (!loadPriorStudyEnabled) return;
    if (!priorStudyInstanceUid) return;
    const targetIndex = priorStudyViewportIndex;
    if (typeof targetIndex !== 'number') return;

    // Layout must actually have a slot at the target index — otherwise the
    // protocol metadata is stale and there is no viewport to populate.
    const viewports = viewportsRef.current;
    if (!viewports) return;
    const targetViewportId = `viewport-${targetIndex}`;
    if (!viewports.has(targetViewportId) || viewports.size <= 1) return;

    // Wait until the main study's images have actually arrived. Without imageIds
    // the rendering effect hasn't built the Cornerstone viewports yet, so we
    // can't grab a handle on viewport N.
    if (!viewportImageIdsKey) return;

    const abortController = new AbortController();
    const signal = abortController.signal;

    // Slight delay to let the main rendering effect finish its setStack on
    // viewport-0 — same shape as the auto-select-first-series effect above.
    const timer = setTimeout(async () => {
      try {
        const result = await fetchImageIds(dicomWebClient, priorStudyInstanceUid, signal);
        if (signal.aborted || result.imageIds.length === 0) return;

        const renderingEngine = getOrCreateRenderingEngine();
        const targetVp = renderingEngine.getViewport(targetViewportId);
        if (!isStackViewport(targetVp)) return;

        const priorSelection = selectPrimarySeriesImageIds(result.imageIds, result.seriesItems);
        const priorIds = priorSelection.imageIds;
        if (priorIds.length === 0) return;
        const sortedPriorIds = sortImageIdsBySpatialPosition(
          priorIds,
          (id) => metaData.get('imagePlaneModule', id) as
            | { imagePositionPatient?: number[]; imageOrientationPatient?: number[] }
            | undefined,
        );
        await targetVp.setStack(sortedPriorIds);
        if (signal.aborted) return;
        targetVp.resetCamera();
        targetVp.render();
      } catch (err) {
        // Aborts on study switch are expected; other errors are non-fatal —
        // the user can still click Compare manually to load the prior.
        console.warn('[PACSViewer] Prior study auto-load failed:', err);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [
    status,
    loadPriorStudyEnabled,
    priorStudyViewportIndex,
    priorStudyInstanceUid,
    viewportStructureKey,
    viewportImageIdsKey,
    dicomWebClient,
  ]);

  // --------------------------------------------------------------------------
  // PACS-P4.5: Dual-monitor viewport sync (BroadcastChannel)
  // --------------------------------------------------------------------------
  // When the user pops the viewer out to a second monitor, the two windows
  // exchange scroll / W-L / zoom state over a same-origin BroadcastChannel
  // keyed by the StudyInstanceUID. Sync is bidirectional and always-on (the
  // channel is cheap when there is no peer). Whichever window initiates a
  // change wins; throttle inside the hook keeps the wire ≤ 30 Hz.
  //
  // CAREFUL — this effect lives alongside P1.1 (STACK_NEW_IMAGE listener)
  // and P1.3 (prior-load); we attach an *additional* STACK_NEW_IMAGE
  // listener for broadcast purposes without removing the P1.1 one.
  // --------------------------------------------------------------------------
  const { broadcast: broadcastViewportSync, remoteState: remoteViewportSyncState } = useViewportSync(studyInstanceUid, status === 'ready');
  type ViewportSyncWireState = Partial<ViewportSyncState> & {
    sourceViewportId?: string;
    studyUid?: string;
    seriesUid?: string;
    sopInstanceUid?: string;
    imageId?: string;
    viewportRole?: 'current' | 'prior';
    stackLength?: number;
  };
  const getViewportSyncIdentity = useCallback(
    (vpId?: string, currentImageIdOverride?: string): ViewportSyncWireState => {
      const viewportIndex = vpId?.startsWith('viewport-') ? Number.parseInt(vpId.slice('viewport-'.length), 10) : NaN;
      const isPriorViewport =
        loadPriorStudyEnabled &&
        !!priorStudyInstanceUid &&
        Number.isFinite(viewportIndex) &&
        viewportIndex === priorStudyViewportIndex;
      let imageId = currentImageIdOverride;
      let stackLength: number | undefined;
      try {
        const vp = vpId ? getOrCreateRenderingEngine().getViewport(vpId) : undefined;
        if (isStackViewport(vp)) {
          imageId ??= vp.getCurrentImageId();
          stackLength = vp.getImageIds().length;
        }
      } catch {
        // Viewport identity is best-effort during teardown/rebuild.
      }
      const parsed: ReturnType<typeof parseWadoImageIdPath> = imageId ? parseWadoImageIdPath(imageId) : {};
      const stateSeriesUid = vpId ? viewerState?.viewports.get(vpId)?.seriesUid : undefined;
      return {
        sourceViewportId: vpId,
        studyUid: parsed.studyUid ?? (isPriorViewport ? priorStudyInstanceUid : studyInstanceUid),
        seriesUid: parsed.seriesUid ?? stateSeriesUid,
        sopInstanceUid: parsed.sopInstanceUid,
        imageId,
        viewportRole: isPriorViewport ? 'prior' : 'current',
        stackLength,
      };
    },
    [loadPriorStudyEnabled, priorStudyInstanceUid, priorStudyViewportIndex, studyInstanceUid, viewerState?.viewports],
  );

  // Broadcast W/L, zoom, rotation, and the current image index when those local
  // viewport values change without a slice-scroll event (for example, dragging
  // window/level or zooming with the mouse).
  const activeViewportSyncState = viewerState?.activeViewportId
    ? viewerState.viewports.get(viewerState.activeViewportId)
    : undefined;
  const hasActiveViewportSyncState = activeViewportSyncState !== undefined;
  const activeSyncImageIndex = activeViewportSyncState?.imageIndex;
  const activeSyncWindowCenter = activeViewportSyncState?.windowLevel.center;
  const activeSyncWindowWidth = activeViewportSyncState?.windowLevel.width;
  const activeSyncZoom = activeViewportSyncState?.zoom;
  const activeSyncRotation = activeViewportSyncState?.rotation;
  const activeViewportSyncIdentity = getViewportSyncIdentity(viewerState?.activeViewportId);
  const activeViewportSyncSnapshotRef = useRef<ViewportSyncWireState>({});
  activeViewportSyncSnapshotRef.current = hasActiveViewportSyncState
    ? {
        imageIdIndex: activeSyncImageIndex,
        windowCenter: activeSyncWindowCenter,
        windowWidth: activeSyncWindowWidth,
        zoom: activeSyncZoom,
        rotation: activeSyncRotation,
        ...activeViewportSyncIdentity,
      }
    : {};

  // Broadcast local scroll changes to the peer window. Include the active
  // viewport's display state so a scroll event also keeps W/L, zoom, and
  // rotation aligned across monitors.
  useEffect(() => {
    const vpId = viewerState?.activeViewportId;
    if (status !== 'ready' || !vpId) {
      return undefined;
    }
    const element = document.getElementById(`cs3d-${vpId}`);
    if (!element) {
      return undefined;
    }

    interface StackNewImageDetail { imageIdIndex?: number; imageId?: string }
    const onStackNewImage = (e: Event): void => {
      const detail = (e as CustomEvent<StackNewImageDetail>).detail;
      const idx = detail?.imageIdIndex;
      if (typeof idx === 'number') {
        const syncIdentity = getViewportSyncIdentity(vpId, detail?.imageId);
        if (syncIdentity.viewportRole === 'prior') {
          return;
        }
        const activeViewportState = activeViewportSyncSnapshotRef.current;
        broadcastViewportSync({
          imageIdIndex: idx,
          windowCenter: activeViewportState.windowCenter,
          windowWidth: activeViewportState.windowWidth,
          zoom: activeViewportState?.zoom,
          rotation: activeViewportState?.rotation,
          ...syncIdentity,
        } as Partial<ViewportSyncState>);
      }
    };

    const eventName = csEnums.Events.STACK_NEW_IMAGE;
    element.addEventListener(eventName, onStackNewImage);
    return () => element.removeEventListener(eventName, onStackNewImage);
  }, [status, viewerState?.activeViewportId, viewportStructureKey, broadcastViewportSync, getViewportSyncIdentity]);

  useEffect(() => {
    if (status !== 'ready' || !hasActiveViewportSyncState) {
      return;
    }
    const syncIdentity = activeViewportSyncSnapshotRef.current;
    if (syncIdentity.viewportRole === 'prior') {
      return;
    }
    broadcastViewportSync({
      imageIdIndex: activeSyncImageIndex,
      windowCenter: activeSyncWindowCenter,
      windowWidth: activeSyncWindowWidth,
      zoom: activeSyncZoom,
      rotation: activeSyncRotation,
      ...syncIdentity,
    } as Partial<ViewportSyncState>);
  }, [
    status,
    hasActiveViewportSyncState,
    activeSyncImageIndex,
    activeSyncWindowCenter,
    activeSyncWindowWidth,
    activeSyncZoom,
    activeSyncRotation,
    broadcastViewportSync,
  ]);

  // Apply remote state changes from the peer window to our local viewport.
  useEffect(() => {
    if (status !== 'ready') {
      return;
    }
    const remote = remoteViewportSyncState as ViewportSyncWireState | null;
    if (!remote) {
      return;
    }
    if (remote.viewportRole === 'prior') {
      return;
    }
    const vpId = viewerState?.activeViewportId;
    if (!vpId) {
      return;
    }
    try {
      const engine = getOrCreateRenderingEngine();
      const vp = engine.getViewport(vpId);
      if (!vp) {
        return;
      }
      const targetIdentity = getViewportSyncIdentity(vpId);
      const sameStudy = !remote.studyUid || !targetIdentity.studyUid || remote.studyUid === targetIdentity.studyUid;
      const sameSeries = !remote.seriesUid || !targetIdentity.seriesUid || remote.seriesUid === targetIdentity.seriesUid;
      const sameStackLength =
        typeof remote.stackLength !== 'number' ||
        typeof targetIdentity.stackLength !== 'number' ||
        remote.stackLength === targetIdentity.stackLength;
      let changed = false;
      if (hasImageIndexControl(vp) && typeof remote.imageIdIndex === 'number' && sameStudy && sameSeries && sameStackLength) {
        let targetIndex = remote.imageIdIndex;
        if (isStackViewport(vp)) {
          const targetIds = vp.getImageIds();
          const exactIndex = remote.imageId ? targetIds.indexOf(remote.imageId) : -1;
          const sopIndex = exactIndex >= 0 || !remote.sopInstanceUid
            ? exactIndex
            : targetIds.findIndex((id) => parseWadoImageIdPath(id).sopInstanceUid === remote.sopInstanceUid);
          if (sopIndex >= 0) {
            targetIndex = sopIndex;
          }
          if (targetIndex < 0 || targetIndex >= targetIds.length) {
            targetIndex = -1;
          }
        }
        if (targetIndex >= 0) {
          vp.setImageIdIndex(targetIndex);
          changed = true;
        }
      }
      if (hasSetProperties(vp) && sameStudy && sameSeries && typeof remote.windowCenter === 'number' && typeof remote.windowWidth === 'number') {
        const lower = remote.windowCenter - remote.windowWidth / 2;
        const upper = remote.windowCenter + remote.windowWidth / 2;
        vp.setProperties({ voiRange: { lower, upper }, rotation: remote.rotation });
        changed = true;
      }
      if (hasSetCamera(vp) && sameStudy && sameSeries && typeof remote.zoom === 'number' && remote.zoom > 0) {
        vp.setCamera({ parallelScale: remote.zoom });
        changed = true;
      }
      if (changed && hasRenderableViewport(vp)) {
        vp.render();
      }
    } catch (err) {
      console.warn('[PACSViewer] Failed to apply remote viewport sync state:', err);
      // Cornerstone may be mid-teardown — silently skip; next broadcast retries.
    }
  }, [remoteViewportSyncState, status, viewerState?.activeViewportId, getViewportSyncIdentity]);

  // Open this study in a new browser window for dual-monitor reading.
  const handlePopOut = useCallback(() => {
    if (!fhirStudyId) {
      notifications.show({
        title: t('pacs.popout.title'),
        message: t('pacs.popout.fhirStudyRequired'),
        color: 'red',
      });
      return;
    }
    const url = `/emr/pacs/popout?studyId=${encodeURIComponent(`ImagingStudy/${fhirStudyId}`)}&studyUid=${encodeURIComponent(studyInstanceUid)}`;
    window.open(url, '_blank', 'noopener=yes,noreferrer=yes,width=1400,height=900');
  }, [fhirStudyId, studyInstanceUid, t]);

  // --------------------------------------------------------------------------
  // Handle viewport click (set as active)
  // --------------------------------------------------------------------------
  const handleViewportClick = useCallback(
    (viewportId: string) => {
      setActiveViewport(viewportId);
    },
    [setActiveViewport]
  );

  // --------------------------------------------------------------------------
  // Derived state & memoized callbacks — MUST be before early returns so
  // React always sees the same number of hooks on every render.
  // --------------------------------------------------------------------------
  const layout = viewerState?.viewportLayout ?? '1x1';
  const viewports = viewerState?.viewports;
  const activeViewportId = viewerState?.activeViewportId;

  // Check if the study modality supports volumetric operations (MPR/3D).
  // X-rays, ultrasound, mammograms are flat 2D — clicking MPR on them would crash.
  const studyModalities = studyInfo?.modalities?.length ? studyInfo.modalities : (studyModality ? [studyModality] : []);
  const isVolumetric = studyModalities.length > 0
    ? studyModalities.some((modality) => {
      const normalized = modality.toUpperCase();
      return normalized !== 'XA' && normalized !== 'RF' && isModalityVolumetric(normalized);
    })
    : true;
  // MPR additionally needs at least 3 slices — a single-image CT/MR is "volumetric"
  // by modality but can't reconstruct planes, so MPR must be disabled there too.
  const isMPREnabled = isVolumetric && (viewerState?.imageIds?.length ?? 0) >= 3;

  // Sub-button visibility (DEF/MIP/MIN, W/L-on-all-MPR-panes etc.) gates on
  // "is any current viewport volume-backed", derived from the viewport types.
  // Decoupling this from `isMPRActive` ensures the MPR toggle button reflects
  // only the user's MPR-toggle intent — fixing the off-then-on regression.
  const hasVolumeViewport = useMemo(() => {
    if (!viewports) return false;
    for (const vp of viewports.values()) {
      if (vp.type === 'volume' || vp.type === 'volume3d') return true;
    }
    return false;
  }, [viewports]);

  const handleToolChange = useCallback((tool: PACSViewerTool) => {
    if (isMedplumDisabled && MEDPLUM_ANNOTATION_TOOLS.has(tool)) {
      notifyMedplumOffline();
      return;
    }
    setActiveTool(tool);
    activateToolOnGroup(tool);
  }, [isMedplumDisabled, notifyMedplumOffline, setActiveTool]);

  useEffect(() => {
    const activeTool = viewerState?.activeTool;
    if (isMedplumDisabled && activeTool && MEDPLUM_ANNOTATION_TOOLS.has(activeTool)) {
      setActiveTool('StackScroll');
      activateToolOnGroup('StackScroll');
    }
  }, [isMedplumDisabled, setActiveTool, viewerState?.activeTool]);

  const handleRotateCW = useCallback(() => rotate(90), [rotate]);
  const handleRotateCCW = useCallback(() => rotate(-90), [rotate]);
  const handleFlipH = useCallback(() => flip('horizontal'), [flip]);
  const handleFlipV = useCallback(() => flip('vertical'), [flip]);

  const handleResetAll = useCallback(() => {
    resetView();
    setActiveWLPreset(null);
  }, [resetView]);

  const handleMPRToggle = useCallback(() => {
    isMPRActive ? deactivateMPR() : activateMPR();
  }, [isMPRActive, deactivateMPR, activateMPR]);

  const handle3DToggle = useCallback(() => {
    is3DActive ? deactivate3D() : activate3D();
  }, [is3DActive, deactivate3D, activate3D]);

  // ── Structure Isolation handlers ──────────────────────────────────────────
  // Resolve the three ids the engine API needs, mirroring the DEV harness:
  //   engineId = getOrCreateRenderingEngine().id
  //   vrViewportId = the VOLUME_3D (VR) pane — prefer the actual volume3d
  //     viewport so isolation works in BOTH solo-3D (where it's the active
  //     pane) AND mixed 3MPR+VR (where the active pane is usually an MPR pane,
  //     not the VR). Falls back to the active viewport id.
  //   ctVolumeId = activeVolumeIdRef.current
  const resolveIsolationIds = useCallback((): { engineId: string; vpId: string; ctVolumeId: string } | null => {
    let engineId = '';
    try {
      engineId = getOrCreateRenderingEngine().id;
    } catch (err) {
      console.warn('[PACSViewer] isolation id rendering engine lookup failed:', err);
      return null;
    }
    let vrVpId: string | undefined;
    if (viewerState?.viewports) {
      for (const [id, vp] of viewerState.viewports) {
        if (vp.type === 'volume3d') {
          vrVpId = id;
          break;
        }
      }
    }
    const vpId = vrVpId ?? viewerState?.activeViewportId ?? 'viewport-0';
    const ctVolumeId = activeVolumeIdRef.current;
    if (!engineId || !ctVolumeId) return null;
    return { engineId, vpId, ctVolumeId };
  }, [viewerState?.viewports, viewerState?.activeViewportId, activeVolumeIdRef]);

  // Reset to "show all": clear the masked render and return to idle.
  const handleIsolateReset = useCallback(() => {
    const ids = resolveIsolationIds();
    if (ids) {
      void clearIsolation(ids.engineId, ids.vpId, ids.ctVolumeId);
    }
    lastIsolateClickRef.current = null;
    setIsIsolateArmed(false);
    setIsIsolateActive(false);
    setIsIsolateLoading(false);
  }, [resolveIsolationIds]);

  // Toolbar button: if armed or active → exit (show all); otherwise arm.
  const handleIsolateToggle = useCallback(() => {
    if (isIsolateArmed || isIsolateActive) {
      handleIsolateReset();
      return;
    }
    if (!canIsolate) {
      notifications.show({
        title: t('pacs.tools.isolate'),
        message: t('pacs.tools.isolateNoPermission'),
        color: 'red',
      });
      return;
    }
    // Don't arm until the CT scalars are readable — otherwise the first click
    // returns "no-data" and the UI would wrongly blame the click location.
    const ids = resolveIsolationIds();
    if (!ids || !isCtScalarsReady(ids.ctVolumeId)) {
      notifications.show({
        title: t('pacs.tools.isolate'),
        message: t('pacs.tools.isolateLoadingData'),
        color: 'red',
      });
      return;
    }
    // Mutual exclusion: cancel crop + any cut tool so a click isolates cleanly.
    vrModeChangeRef.current('rotate');
    setCutMode('none');
    setIsIsolateArmed(true);
  }, [isIsolateArmed, isIsolateActive, canIsolate, handleIsolateReset, resolveIsolationIds, t]);

  // Core isolate call shared by the arm-click and any re-apply.
  // (Wave 8G.13: the dead "Background opacity" slider was removed, so this no
  // longer takes a ghost-percent argument — hidden tissue is fully hidden.)
  const runIsolateAt = useCallback(
    async (canvasX: number, canvasY: number): Promise<void> => {
      const ids = resolveIsolationIds();
      if (!ids) {
        notifications.show({
          title: t('pacs.tools.isolate'),
          message: t('pacs.tools.isolateDisabled'),
          color: 'red',
        });
        return;
      }
      setIsIsolateLoading(true);
      try {
        // Wave 8G.13: the dead "Background opacity" slider was removed; hidden
        // tissue is fully hidden. isolateStructureAtPoint's ghostOpacity option
        // defaults to 0 (fully hidden), so we omit it entirely now.
        // Isolate inherits the operator's CURRENT preset so the structure renders as a
        // shaded, anatomically-correct CT volume (not a flat hand-rolled TF).
        const isoPreset =
          VOLUME_PRESET_VTK_NAME[viewerState?.viewports.get(ids.vpId)?.volume3DPreset ?? 'CtVessel'] ??
          'CT-Coronary-Arteries-2';
        const result = await isolateStructureAtPoint(
          ids.engineId,
          ids.vpId,
          ids.ctVolumeId,
          canvasX,
          canvasY,
          { presetVtkName: isoPreset },
        );
        if (result.status === 'ok') {
          lastIsolateClickRef.current = { x: canvasX, y: canvasY };
          setIsIsolateArmed(false);
          setIsIsolateActive(true);
          if (fhirStudyId || studyInfo?.patientId) {
            logStructureIsolation({
              studyId: fhirStudyId || undefined,
              patientId: studyInfo?.patientId,
              description: `count=${result.count ?? 0}${result.capped ? ' capped' : ''}`,
            });
          }
        } else if (result.status === 'empty' || result.status === 'too-small') {
          // The pick didn't land on a growable structure. Leave the VR EXACTLY as
          // it was (never blank) and stay ARMED so the operator can immediately
          // re-click — ideally rotating slightly or aiming at the vessel/bone.
          notifications.show({
            title: t('pacs.tools.isolate'),
            message: t('pacs.tools.isolateEmpty'),
            color: 'red',
          });
        } else if (result.status === 'no-hit') {
          notifications.show({
            title: t('pacs.tools.isolate'),
            message: t('pacs.tools.isolateNoHit'),
            color: 'red',
          });
        } else if (result.status === 'no-data') {
          // The CT volume isn't readable yet (still streaming) — blame the loading,
          // not the click location, so the operator just waits a moment.
          notifications.show({
            title: t('pacs.tools.isolate'),
            message: t('pacs.tools.isolateLoadingData'),
            color: 'red',
          });
        } else {
          notifications.show({
            title: t('pacs.tools.isolate'),
            message: t('pacs.tools.isolateError'),
            color: 'red',
          });
        }
      } catch (err) {
        console.warn('[PACSViewer] isolateStructureAtPoint failed:', err);
        notifications.show({
          title: t('pacs.tools.isolate'),
          message: t('pacs.tools.isolateError'),
          color: 'red',
        });
      } finally {
        setIsIsolateLoading(false);
      }
    },
    [resolveIsolationIds, fhirStudyId, studyInfo?.patientId, t, viewerState?.viewports],
  );

  // Arm-click: while armed, a click on the VR pane element triggers the isolate
  // at viewport-relative coords. Cursor switches to crosshair while armed. Use
  // the SAME VR viewport id resolveIsolationIds targets (prefers the volume3d
  // pane), so the listener and the isolate call agree in mixed 3MPR+VR layouts.
  useEffect(() => {
    if (!isIsolateArmed) return undefined;
    const ids = resolveIsolationIds();
    const vpId = ids?.vpId ?? viewerState?.activeViewportId ?? 'viewport-0';
    const paneEl = document.getElementById(`cs3d-${vpId}`);
    if (!paneEl) return undefined;

    const prevCursor = paneEl.style.cursor;
    paneEl.style.cursor = 'crosshair';

    const onClick = (e: MouseEvent): void => {
      const rect = paneEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      void runIsolateAt(x, y);
    };
    paneEl.addEventListener('click', onClick);

    return () => {
      paneEl.removeEventListener('click', onClick);
      paneEl.style.cursor = prevCursor;
    };
  }, [isIsolateArmed, resolveIsolationIds, viewerState?.activeViewportId, runIsolateAt]);

  // Auto-exit isolation when the user leaves 3D / switches layout / switches
  // series. viewportStructureKey changes on any layout/pane-type/series swap, and
  // is3DActive flips when 3D mode is toggled off — either should drop isolation.
  const prevIsolationGuardRef = useRef({ structureKey: '', is3DActive });
  useEffect(() => {
    const prev = prevIsolationGuardRef.current;
    const changed = prev.structureKey !== viewportStructureKey || (prev.is3DActive && !is3DActive);
    prevIsolationGuardRef.current = { structureKey: viewportStructureKey, is3DActive };
    if (!changed) return;
    if (isIsolateArmed || isIsolateActive) {
      handleIsolateReset();
    }
    // Cuts (remove/scalpel) also drop on any layout/series/3D-off change. The old
    // volume's accumulator is keyed by its volume id and self-evicts on the next cut;
    // here we just clear the UI state so the panel doesn't show stale "Cuts: N".
    if (cutMode !== 'none' || cutCount > 0) {
      setCutMode('none');
      setCutCount(0);
    }
  }, [viewportStructureKey, is3DActive, isIsolateArmed, isIsolateActive, handleIsolateReset, cutMode, cutCount]);

  // --------------------------------------------------------------------------
  // Cut tools — Remove (click a structure → delete it) + Scalpel (drag-box cut)
  // --------------------------------------------------------------------------
  // The INVERSE of isolate: instead of keeping only the clicked structure, these
  // discard the clicked structure (or a dragged screen region) and KEEP the rest —
  // "peel the sternum/ribs off to see the heart". Both share one cumulative
  // accumulator in structureIsolation.ts (cuts combine + reset together) and re-apply
  // the operator's CURRENT preset so the volume looks normal, just minus the cut.

  /** Resolve the live VR preset's VTK name so a removal preserves the current look. */
  const resolveVrPresetVtk = useCallback(
    (vpId: string): string => {
      const tf = viewerState?.viewports.get(vpId)?.volume3DPreset;
      return VOLUME_PRESET_VTK_NAME[tf ?? 'CtVessel'] ?? 'CT-Coronary-Arteries-2';
    },
    [viewerState?.viewports],
  );

  const handleResetCuts = useCallback(() => {
    const ids = resolveIsolationIds();
    if (ids) {
      void clearRemovals(ids.engineId, ids.vpId, ids.ctVolumeId, resolveVrPresetVtk(ids.vpId));
    }
    setCutCount(0);
  }, [resolveIsolationIds, resolveVrPresetVtk]);

  const handleCutModeChange = useCallback(
    (mode: 'none' | 'remove' | 'scalpel') => {
      if (mode === 'none') {
        setCutMode('none');
        return;
      }
      if (!canIsolate) {
        notifications.show({
          title: t('pacs.tools.remove'),
          message: t('pacs.tools.isolateNoPermission'),
          color: 'red',
        });
        return;
      }
      const ids = resolveIsolationIds();
      if (!ids || !isCtScalarsReady(ids.ctVolumeId)) {
        notifications.show({
          title: t('pacs.tools.remove'),
          message: t('pacs.tools.isolateLoadingData'),
          color: 'red',
        });
        return;
      }
      // Mutual exclusion: drop isolate + crop so the click/drag performs a cut.
      if (isIsolateArmed || isIsolateActive) handleIsolateReset();
      vrModeChangeRef.current('rotate');
      setCutMode(mode);
    },
    [canIsolate, resolveIsolationIds, isIsolateArmed, isIsolateActive, handleIsolateReset, t],
  );

  const runRemoveAt = useCallback(
    async (canvasX: number, canvasY: number): Promise<void> => {
      const ids = resolveIsolationIds();
      if (!ids) {
        notifications.show({ title: t('pacs.tools.remove'), message: t('pacs.tools.isolateDisabled'), color: 'red' });
        return;
      }
      setIsCutLoading(true);
      try {
        const result = await removeStructureAtPoint(ids.engineId, ids.vpId, ids.ctVolumeId, canvasX, canvasY, {
          presetVtkName: resolveVrPresetVtk(ids.vpId),
        });
        if (result.status === 'ok') {
          setCutCount(result.cuts ?? getRemovalCutCount(ids.ctVolumeId));
          if (fhirStudyId || studyInfo?.patientId) {
            logStructureIsolation({
              studyId: fhirStudyId || undefined,
              patientId: studyInfo?.patientId,
              description: `remove count=${result.count ?? 0} cuts=${result.cuts ?? 0}`,
            });
          }
        } else if (result.status === 'empty' || result.status === 'too-small' || result.status === 'no-hit') {
          notifications.show({ title: t('pacs.tools.remove'), message: t('pacs.tools.removeEmpty'), color: 'red' });
        } else if (result.status === 'no-data') {
          notifications.show({ title: t('pacs.tools.remove'), message: t('pacs.tools.isolateLoadingData'), color: 'red' });
        } else {
          notifications.show({ title: t('pacs.tools.remove'), message: t('pacs.tools.isolateError'), color: 'red' });
        }
      } catch (err) {
        console.warn('[PACSViewer] removeStructureAtPoint failed:', err);
        notifications.show({ title: t('pacs.tools.remove'), message: t('pacs.tools.isolateError'), color: 'red' });
      } finally {
        setIsCutLoading(false);
      }
    },
    [resolveIsolationIds, resolveVrPresetVtk, fhirStudyId, studyInfo?.patientId, t],
  );

  const runScalpelCut = useCallback(
    async (rect: { x0: number; y0: number; x1: number; y1: number }): Promise<void> => {
      const ids = resolveIsolationIds();
      if (!ids) return;
      setIsCutLoading(true);
      try {
        const result = await removeFrustumByRect(ids.engineId, ids.vpId, ids.ctVolumeId, rect, resolveVrPresetVtk(ids.vpId));
        if (result.status === 'ok') {
          setCutCount(result.cuts ?? getRemovalCutCount(ids.ctVolumeId));
        } else if (result.status === 'empty' || result.status === 'too-small') {
          notifications.show({ title: t('pacs.tools.scalpel'), message: t('pacs.tools.removeEmpty'), color: 'red' });
        } else if (result.status === 'no-data') {
          notifications.show({ title: t('pacs.tools.scalpel'), message: t('pacs.tools.isolateLoadingData'), color: 'red' });
        } else if (result.status === 'no-projection') {
          notifications.show({ title: t('pacs.tools.scalpel'), message: t('pacs.tools.scalpelFailed'), color: 'red' });
        } else {
          notifications.show({ title: t('pacs.tools.scalpel'), message: t('pacs.tools.isolateError'), color: 'red' });
        }
      } catch (err) {
        console.warn('[PACSViewer] removeFrustumByRect failed:', err);
        notifications.show({ title: t('pacs.tools.scalpel'), message: t('pacs.tools.isolateError'), color: 'red' });
      } finally {
        setIsCutLoading(false);
      }
    },
    [resolveIsolationIds, resolveVrPresetVtk, t],
  );

  // Remove mode: trackball stays active (rotate to see), a CLICK on the VR pane
  // removes the clicked structure.
  useEffect(() => {
    if (cutMode !== 'remove') return undefined;
    const ids = resolveIsolationIds();
    const vpId = ids?.vpId ?? viewerState?.activeViewportId ?? 'viewport-0';
    const paneEl = document.getElementById(`cs3d-${vpId}`);
    if (!paneEl) return undefined;
    const prevCursor = paneEl.style.cursor;
    paneEl.style.cursor = 'crosshair';
    const onClick = (e: MouseEvent): void => {
      const rect = paneEl.getBoundingClientRect();
      void runRemoveAt(e.clientX - rect.left, e.clientY - rect.top);
    };
    paneEl.addEventListener('click', onClick);
    return () => {
      paneEl.removeEventListener('click', onClick);
      paneEl.style.cursor = prevCursor;
    };
  }, [cutMode, resolveIsolationIds, viewerState?.activeViewportId, runRemoveAt]);

  // Scalpel mode: drag a rectangle on the VR pane to cut away that frustum. We
  // disable the trackball while armed so an LMB drag draws the marquee instead of
  // rotating (restored on exit). The marquee is a themed accent box on document.body
  // (fixed positioning → no need to touch the CS3D viewport's layout).
  useEffect(() => {
    if (cutMode !== 'scalpel') return undefined;
    const ids = resolveIsolationIds();
    const vpId = ids?.vpId ?? viewerState?.activeViewportId ?? 'viewport-0';
    const paneEl = document.getElementById(`cs3d-${vpId}`);
    if (!paneEl) return undefined;
    const prevCursor = paneEl.style.cursor;
    paneEl.style.cursor = 'crosshair';
    try {
      getOrCreateVrToolGroup().setToolPassive(cornerstoneTools.TrackballRotateTool.toolName);
    } catch (err) {
      console.warn('[PACSViewer] failed to pause VR trackball for scalpel mode:', err);
    }

    let start: { x: number; y: number } | null = null;
    let marquee: HTMLDivElement | null = null;
    const clearMarquee = (): void => {
      marquee?.remove();
      marquee = null;
    };
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      marquee = document.createElement('div');
      marquee.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;border:2px dashed var(--emr-accent);background:rgba(49,130,206,0.12);pointer-events:none;z-index:9999;`;
      document.body.appendChild(marquee);
      e.preventDefault();
    };
    const onMove = (e: MouseEvent): void => {
      if (!start || !marquee) return;
      marquee.style.left = `${Math.min(start.x, e.clientX)}px`;
      marquee.style.top = `${Math.min(start.y, e.clientY)}px`;
      marquee.style.width = `${Math.abs(e.clientX - start.x)}px`;
      marquee.style.height = `${Math.abs(e.clientY - start.y)}px`;
    };
    const onUp = (e: MouseEvent): void => {
      if (!start) return;
      const r = paneEl.getBoundingClientRect();
      const sel = { x0: start.x - r.left, y0: start.y - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top };
      start = null;
      clearMarquee();
      if (Math.abs(sel.x1 - sel.x0) >= 5 && Math.abs(sel.y1 - sel.y0) >= 5) {
        void runScalpelCut(sel);
      }
    };
    paneEl.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      paneEl.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      clearMarquee();
      paneEl.style.cursor = prevCursor;
      try {
        getOrCreateVrToolGroup().setToolActive(cornerstoneTools.TrackballRotateTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
      } catch (err) {
        console.warn('[PACSViewer] failed to restore VR trackball after scalpel mode:', err);
      }
    };
  }, [cutMode, resolveIsolationIds, viewerState?.activeViewportId, runScalpelCut]);

  // Layout-dropdown handler. The simple grid layouts (1x1/1x2/2x1/2x2) go
  // straight through the hook's existing setViewportLayout (which preserves
  // each pane's series/W-L). MPR and 3D are mode toggles, so the grid picker
  // delegates to the same handleMPRToggle / handle3DToggle the toolbar uses —
  // no new state, no behavior change.
  const handleSelectGridLayout = useCallback(
    (target: 'mpr' | '3d' | '3d-solo' | '3d-mixed' | import('../../types/pacs').ViewportLayout) => {
      if (target === 'mpr') {
        if (!isMPRActive) activateMPR();
        return;
      }
      // Explicit entries from the layout menu pick the 3D layout deterministically
      // (instead of the context-dependent default the toolbar toggle / "3" key use).
      // HOOK-SURFACE MISMATCH (LiverRa port): UsePACSViewerReturn declares
      // `activate3D: () => void`, but the implementation accepts an optional
      // ('solo' | 'mixed') mode (verified in usePACSViewer.ts). Cast to the
      // implementation signature until the hook's return-type annotation is fixed.
      if (target === '3d-solo') {
        (activate3D as (mode?: 'solo' | 'mixed') => void)('solo');
        return;
      }
      if (target === '3d-mixed') {
        (activate3D as (mode?: 'solo' | 'mixed') => void)('mixed');
        return;
      }
      if (target === '3d') {
        if (!is3DActive) activate3D();
        return;
      }
      // A concrete simple grid was chosen — leave any volume mode first so the
      // pane types reset to STACK, then apply the grid.
      if (isMPRActive) deactivateMPR();
      if (is3DActive) deactivate3D();
      setViewportLayout(target);
    },
    [isMPRActive, is3DActive, activateMPR, activate3D, deactivateMPR, deactivate3D, setViewportLayout],
  );

  // ── Wave 1 of 3mensio-grade VR upgrade (2026-05-20) ────────────────────
  // VR-pane interaction-mode switch. In 'rotate' mode (default), LMB drives
  // TrackballRotate; the VolumeCroppingTool stays setToolEnabled (handles
  // visible but passive) so the operator SEES the crop box without
  // accidentally moving it. In 'crop' mode, LMB drives the crop handles +
  // MPR reference lines; rotation moves to setToolPassive (the operator
  // can still pan/zoom via RMB/MMB which are bound to Zoom/Pan).
  const handleVrInteractionModeChange = useCallback(
    (mode: 'rotate' | 'crop') => {
      try {
        const vrGroup = getOrCreateVrToolGroup();
        const VC = cornerstoneTools.VolumeCroppingTool.toolName;
        const TR = cornerstoneTools.TrackballRotateTool.toolName;
        const MB = cornerstoneTools.Enums.MouseBindings;
        if (mode === 'crop') {
          vrGroup.setToolPassive(TR);
          vrGroup.setToolActive(VC, { bindings: [{ mouseButton: MB.Primary }] });
          // CS3D quirk: VolumeCroppingTool.onSetToolActive (the function CS3D
          // runs when we call setToolActive) explicitly hides handles +
          // clipping planes on every activation (see VolumeCroppingTool.js:
          // lines 734-735 of the installed @cornerstonejs/tools@4.22.6). So
          // after activating we MUST flip them back on or the operator sees
          // no spheres / no MPR reference lines despite the tool being
          // technically active. The methods are on the tool instance, not
          // the group, hence the getToolInstance hop.
          const vcInstance = vrGroup.getToolInstance?.(VC) as
            | { setHandlesVisible?: (v: boolean) => void; setClippingPlanesVisible?: (v: boolean) => void }
            | undefined;
          vcInstance?.setHandlesVisible?.(true);
          vcInstance?.setClippingPlanesVisible?.(true);
        } else {
          vrGroup.setToolPassive(VC);
          vrGroup.setToolActive(TR, { bindings: [{ mouseButton: MB.Primary }] });
          // Hide only the 3D crop HANDLES (spheres) in rotate mode for a clean render.
          // CRITICAL: do NOT call setClippingPlanesVisible(false) — in @cornerstonejs/tools
          // 4.22.6 that calls mapper.removeAllClippingPlanes() and physically UN-CROPS the
          // volume. Leaving showClippingPlanes true keeps the operator's crop applied across
          // the mode switch (the user's "my cropped status must stay as I left it").
          const vcInstance = vrGroup.getToolInstance?.(VC) as
            | { setHandlesVisible?: (v: boolean) => void; setClippingPlanesVisible?: (v: boolean) => void }
            | undefined;
          vcInstance?.setHandlesVisible?.(false);
        }
      } catch (err) {

        console.warn('[PACSViewer] VR interaction-mode switch failed:', err);
      }
      // Mutual exclusion: entering crop disarms an armed isolate so a click drags
      // crop handles instead of seeding (an already-APPLIED isolation is preserved —
      // you can still crop the isolated structure).
      if (mode === 'crop') {
        setIsIsolateArmed(false);
        setCutMode('none');
      }
      setVrInteractionMode(mode);
    },
    [setVrInteractionMode],
  );

  // Keep the forward-ref to handleVrInteractionModeChange current so the isolate
  // handlers (defined earlier) can flip crop ↔ rotate without a render-order cycle.
  useEffect(() => {
    vrModeChangeRef.current = handleVrInteractionModeChange;
  }, [handleVrInteractionModeChange]);

  // Reset the crop box back to the volume extents. We delegate to the
  // VolumeCroppingControlTool instance (its resetCroppingSpheres method
  // also resyncs the corresponding VolumeCroppingTool handles in 3D).
  const handleResetCrop = useCallback(() => {
    try {
      const vrGroup = getOrCreateVrToolGroup();
      const VCC = cornerstoneTools.VolumeCroppingControlTool.toolName;
      // The MPR group also has VCC — same tool instance is shared via the
      // tool manager singleton. Calling reset on either side works.
      const toolInstance = vrGroup.getToolInstance?.(VCC)
        ?? getOrCreateToolGroup().getToolInstance?.(VCC);
      (toolInstance as { resetCroppingSpheres?: () => void } | undefined)
        ?.resetCroppingSpheres?.();
    } catch (err) {

      console.warn('[PACSViewer] reset-crop failed:', err);
    }
  }, []);

  // Full revert of the 3D view: rotation + crop. Other state (preset, blend
  // mode, slab) is owned by separate controls and intentionally NOT reset
  // here — those are operator-meaningful choices that survive a "reset
  // view" gesture in 3mensio too.
  const handleReset3DView = useCallback(() => {
    reset3DRotation();
    handleResetCrop();
    // Flip back to rotate mode so the operator's LMB is predictable after reset.
    handleVrInteractionModeChange('rotate');
  }, [reset3DRotation, handleResetCrop, handleVrInteractionModeChange]);

  // --------------------------------------------------------------------------
  // Wave 8G.13 — new 3D-panel handlers (orientation + screenshot)
  // --------------------------------------------------------------------------
  // Resolve the live VOLUME_3D viewport the SAME way reset3DRotation does in
  // usePACSViewer: scan viewerState.viewports for the 'volume3d' pane (the VR
  // pane is rarely the "active" viewport in mixed MPR+VR layouts), then ask the
  // shared rendering engine for that Cornerstone3D viewport.
  const resolveVrViewport = useCallback((): {
    vpId: string;
    csVp: {
      setCamera?: (c: { viewPlaneNormal?: number[]; viewUp?: number[] }) => void;
      resetCamera?: () => void;
      render?: () => void;
    };
  } | null => {
    if (!viewerState) {
      return null;
    }
    let vrVpId: string | null = null;
    for (const [id, vp] of viewerState.viewports.entries()) {
      if (vp.type === 'volume3d') { vrVpId = id; break; }
    }
    if (!vrVpId) {
      return null;
    }
    try {
      const csVp = getOrCreateRenderingEngine().getViewport(vrVpId) as {
        setCamera?: (c: { viewPlaneNormal?: number[]; viewUp?: number[] }) => void;
        resetCamera?: () => void;
        render?: () => void;
      } | undefined;
      if (!csVp) {
        return null;
      }
      return { vpId: vrVpId, csVp };
    } catch (err) {
      console.warn('[PACSViewer] resolveVrViewport failed:', err);
      return null;
    }
  }, [viewerState]);

  // Snap the VR camera to an anatomical pose. LPS conventions (+x=Left,
  // +y=Posterior, +z=Superior); viewPlaneNormal points focal→camera.
  // NOTE: anatomical pose needs manual verification — a headless run cannot
  // confirm 3D pixels/orientation (project rule).
  const handleOrientationPreset = useCallback(
    (axis: 'A' | 'P' | 'L' | 'R' | 'S' | 'I'): void => {
      const POSES: Record<string, { normal: number[]; up: number[] }> = {
        A: { normal: [0, -1, 0], up: [0, 0, 1] },
        P: { normal: [0, 1, 0], up: [0, 0, 1] },
        L: { normal: [1, 0, 0], up: [0, 0, 1] },
        R: { normal: [-1, 0, 0], up: [0, 0, 1] },
        S: { normal: [0, 0, 1], up: [0, -1, 0] },
        I: { normal: [0, 0, -1], up: [0, -1, 0] },
      };
      const pose = POSES[axis];
      if (!pose) {
        return;
      }
      try {
        const vr = resolveVrViewport();
        if (!vr) {
          return;
        }
        vr.csVp.setCamera?.({ viewPlaneNormal: pose.normal, viewUp: pose.up });
        vr.csVp.resetCamera?.();
        vr.csVp.render?.();
      } catch (err) {
        // Never throw from a UI handler — the viewport may not be ready.
        console.warn('[PACSViewer] orientation preset failed:', err);
      }
    },
    [resolveVrViewport],
  );

  // Capture the current VR pane as a PNG key image. Best-effort: grab the VR
  // pane's <canvas>, then reuse the existing PNG-download export path. Falls
  // back to the whole-viewer canvas if the VR pane can't be resolved.
  // NOTE: needs manual verification — a headless run cannot confirm the pixels.
  const handleCaptureScreenshot = useCallback((): void => {
    try {
      const vr = resolveVrViewport();
      const paneEl = vr ? document.getElementById(`cs3d-${vr.vpId}`) : null;
      const canvas =
        (paneEl?.querySelector('canvas') as HTMLCanvasElement | null) ??
        (viewerContainerRef.current?.querySelector('canvas') as HTMLCanvasElement | null);
      if (!canvas) {
        notifications.show({
          title: t('pacs.tools.screenshot'),
          message: t('pacs.viewer.exportImageFailed'),
          color: 'red',
        });
        return;
      }
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      const uidSuffix = studyInstanceUid.slice(-8);
      link.download = `keyimage_${uidSuffix}_${date}.png`;
      link.href = dataUrl;
      link.click();
      notifications.show({
        title: t('pacs.tools.screenshot'),
        message: t('pacs.viewer.exportImageSuccess', { filename: link.download }),
        color: 'green',
      });
      if (fhirStudyId || studyInfo?.patientId) {
        logStudyDownload({
          studyId: fhirStudyId || undefined,
          patientId: studyInfo?.patientId,
          description: 'key-image-3d',
        });
      }
    } catch (err) {
      // Never throw from a UI handler.
      console.warn('[PACSViewer] capture screenshot failed:', err);
    }
  }, [resolveVrViewport, studyInstanceUid, fhirStudyId, studyInfo?.patientId, t]);

  // 3D-controls panel visibility. Default OPEN when 3D activates so the operator
  // immediately sees the controls; collapsible + fully closable thereafter.
  const [panel3DExpanded, setPanel3DExpanded] = useState(true);
  const [panel3DVisible, setPanel3DVisible] = useState(false);
  // Auto-open the panel each time 3D mode turns on; hide it when 3D turns off.
  useEffect(() => {
    if (is3DActive) {
      setPanel3DVisible(true);
      setPanel3DExpanded(true);
    } else {
      setPanel3DVisible(false);
    }
  }, [is3DActive]);

  const handleShowDicomTags = useCallback(() => setShowTagBrowser(true), []);

  const viewportCount = viewerState?.viewports?.size ?? 0;
  const hasMultipleViewports = viewportCount > 1;
  const stableToggleScrollSync = useMemo(
    () => hasMultipleViewports ? toggleScrollSync : undefined,
    [hasMultipleViewports, toggleScrollSync]
  );
  const stableToggleWLSync = useMemo(
    () => hasMultipleViewports ? toggleWLSync : undefined,
    [hasMultipleViewports, toggleWLSync]
  );

  const stableAvailableProtocols = useMemo(
    () => [...userProtocols, ...SYSTEM_PROTOCOLS],
    [userProtocols]
  );

  const getProtocolDisplayName = useCallback((protocol: HangingProtocolRule) => {
    const nameKey = (protocol as HangingProtocolRule & { nameKey?: string }).nameKey;
    return nameKey ? t(nameKey) : protocol.name;
  }, [t]);

  const activeProtocolDisplayName = useMemo(() => {
    if (!activeProtocolName) {
      return null;
    }
    return activeConfiguration?.protocolNameKey ? t(activeConfiguration.protocolNameKey) : activeProtocolName;
  }, [activeConfiguration?.protocolNameKey, activeProtocolName, t]);

  // Memoized computed values — avoid recomputing on every render
  const formattedStudyDate = useMemo(
    () => studyInfo?.date ? new Date(studyInfo.date).toLocaleDateString() : undefined,
    [studyInfo?.date]
  );

  const activeSeriesDescription = useMemo(
    () => activeSeriesUid ? seriesItems.find((s) => s.seriesUid === activeSeriesUid)?.description : undefined,
    [activeSeriesUid, seriesItems]
  );

  // Series rail should list every real, viewable image series (with its true
  // instance count) and hide the non-image clutter — matching medspace. Two
  // filters:
  //  1. instanceCount > 0 — drops genuinely empty series.
  //  2. modality not in NON_STACKABLE_SERIES_MODALITIES — drops the derived /
  //     overlay objects that aren't a browsable image stack (SEG segmentation
  //     series like the "Aortic Root Segmentation" TAVI writes back, SR/PR/KO,
  //     RT structures, etc.). These have ≥1 instance so a count filter alone
  //     wouldn't catch them.
  // Real CT/MR reconstructions (soft-tissue, bone, thin-slice kernels) survive
  // and are loaded on demand when clicked (handleSeriesSelect).
  //
  // Ordered LARGEST-FIRST so the main diagnostic volume (e.g. the 826-slice CTA)
  // leads the rail instead of being buried at the bottom in raw DICOM-fetch
  // order. This matches the series the viewer auto-loads by default, so the
  // operator sees it at the top. Stable: equal-count series (the 320-slice
  // cardiac phases) keep their original relative order. `.slice()` first so we
  // never mutate the hook's seriesItems array in place.
  const visibleSeriesItems = useMemo(
    () => seriesItems
      .filter((s) => s.instanceCount > 0 && !NON_STACKABLE_SERIES_MODALITIES.has((s.modality || '').toUpperCase()))
      .slice()
      .sort((a, b) => b.instanceCount - a.instanceCount),
    [seriesItems]
  );

  const handleArrowTextClose = useCallback(() => {
    setShowArrowTextInput(false);
  }, []);

  const handleExportCineVideo = useCallback(() => {
    const renderFrame = async (frameIndex: number): Promise<HTMLCanvasElement> => {
      cine.seekToFrame(frameIndex);
      // Small delay to let the viewport render the new frame.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      const re = getOrCreateRenderingEngine();
      const vp = re.getViewport(activeViewportId ?? 'viewport-0');
      return vp?.canvas ?? document.createElement('canvas');
    };

    void cine.exportVideo(renderFrame);
  }, [activeViewportId, cine]);

  // Memoized callback for WindowPresets
  const handleWindowPresetChange = useCallback((presetKey: string, center: number, width: number) => {
    setActiveWLPreset((current) => {
      if (current === presetKey) {
        // Toggle off: clicking the already-active preset deselects it
        try {
          const re = getOrCreateRenderingEngine();
          if (hasVolumeViewport && viewerState?.viewports) {
            // Reset ALL volume viewports (MPR panes + VR)
            for (const vpId of viewerState.viewports.keys()) {
              const vp = re.getViewport(vpId);
              if (hasResetProperties(vp)) {
                vp.resetProperties();
              }
            }
          } else {
            const vp = re.getViewport(viewerState?.activeViewportId ?? 'viewport-0');
            if (hasResetProperties(vp)) {
              vp.resetProperties();
            }
          }
        } catch (err) {
          console.warn('[PACSViewer] Failed to reset window preset:', err);
        }
        return null;
      }
      // Activate new preset
      applyPreset(presetKey);
      try {
        const re = getOrCreateRenderingEngine();
        const voiRange = { lower: center - width / 2, upper: center + width / 2 };
        if (hasVolumeViewport && viewerState?.viewports) {
          // Apply to ALL volume viewports (MPR panes + VR)
          for (const vpId of viewerState.viewports.keys()) {
            const vp = re.getViewport(vpId);
            if (vp) {
              // setProperties exists at runtime; the public Viewport union omits it.
              (vp as unknown as { setProperties: (props: unknown) => void }).setProperties({ voiRange });
              vp.render();
            }
          }
        } else {
          const vp = re.getViewport(viewerState?.activeViewportId ?? 'viewport-0');
          if (vp) {
            // setProperties exists at runtime; the public Viewport union omits it.
            (vp as unknown as { setProperties: (props: unknown) => void }).setProperties({ voiRange });
            vp.render();
          }
        }
      } catch (err) {
        console.warn('[PACSViewer] Failed to apply window preset:', err);
      }
      return presetKey;
    });
  }, [applyPreset, viewerState?.activeViewportId, hasVolumeViewport, viewerState?.viewports]);

  // --------------------------------------------------------------------------
  // Render: No WebGL support
  // --------------------------------------------------------------------------
  if (!webGLSupported) {
    return <PACSNoWebGLState t={t} onClose={onClose} />;
  }

  // --------------------------------------------------------------------------
  // Render: Error state
  // --------------------------------------------------------------------------
  // 'load-failed' = a study/series fetch failure (e.g. a transient PACS-bridge blip);
  // route it to the SAME full-screen error+Retry as 'error' so it never falls through
  // to a blank white viewer shell. The Retry re-runs loadStudy (re-fetches the study).
  if (status === 'error' || status === 'load-failed') {
    return (
      <PACSErrorState
        t={t}
        error={error}
        onRetry={() => void loadStudy(studyInstanceUid, studyInfo)}
        onClose={onClose}
      />
    );
  }

  // --------------------------------------------------------------------------
  // Render: Loading state
  // --------------------------------------------------------------------------
  if (status === 'idle' || status === 'initializing' || status === 'loading') {
    return <PACSLoadingState t={t} status={status} onClose={onClose} />;
  }

  // --------------------------------------------------------------------------
  // Render: Ready — show viewport grid
  // --------------------------------------------------------------------------
  return (
    <div className="pacs-viewer" ref={viewerContainerRef}>
      {/* ==== Dark top menu-bar (the medspace reading-room toolbar) ====
           role="menubar" (not "toolbar") so it doesn't collide with the inner
           PACSToolbar's own role="toolbar" — that root is preserved untouched. */}
      <div className="pacs-topbar" role="menubar" aria-label={t('pacs.toolbar')}>
        {/* 1. Series-rail toggle — always visible so a collapsed rail can reopen */}
        {!hideSidebar && (
          <Tooltip label={seriesRailOpen ? t('pacs.topbar.collapseRail') : t('pacs.topbar.expandRail')} position="bottom" withArrow>
            <button
              className="pacs-topbar-btn"
              onClick={toggleSeriesRail}
              aria-label={t('pacs.topbar.toggleRail')}
              aria-pressed={seriesRailOpen}
              data-testid="pacs-rail-toggle"
            >
              {seriesRailOpen ? <IconLayoutSidebarLeftCollapse size={20} /> : <IconLayoutSidebarLeftExpand size={20} />}
            </button>
          </Tooltip>
        )}

        {/* 2. Layout dropdown — grid picker + hanging-protocol management */}
        <Menu shadow="md" width={240} position="bottom-start" withArrow classNames={PACS_MENU_CLASSNAMES}>
          <Menu.Target>
            <Tooltip label={t('pacs.topbar.layout')} position="bottom" withArrow>
              <button className="pacs-topbar-btn pacs-topbar-trigger" aria-label={t('pacs.topbar.layout')} data-testid="pacs-layout-menu">
                <IconLayout2 size={20} />
                <IconChevronDown size={12} className="pacs-group-chevron" />
              </button>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{t('pacs.topbar.layout')}</Menu.Label>
            <Menu.Item leftSection={<IconSquare size={16} />} onClick={() => handleSelectGridLayout('1x1')}>
              {t('pacs.layout.single')}
            </Menu.Item>
            <Menu.Item leftSection={<IconLayoutColumns size={16} />} onClick={() => handleSelectGridLayout('1x2')}>
              {t('pacs.layout.cols2')}
            </Menu.Item>
            <Menu.Item leftSection={<IconLayoutRows size={16} />} onClick={() => handleSelectGridLayout('2x1')}>
              {t('pacs.layout.rows2')}
            </Menu.Item>
            <Menu.Item leftSection={<IconLayoutGrid size={16} />} onClick={() => handleSelectGridLayout('2x2')}>
              {t('pacs.layout.grid4')}
            </Menu.Item>
            {studyModality === 'MG' && (
              <Menu.Item leftSection={<IconLayout2 size={16} />} onClick={() => handleSelectGridLayout('mammo-4up')}>
                {t('pacs.layout.mammo4up')}
              </Menu.Item>
            )}
            <Menu.Divider />
            <Menu.Item
              leftSection={<IconBox size={16} />}
              onClick={() => handleSelectGridLayout('mpr')}
              disabled={!isMPREnabled}
              style={isMPRActive ? { backgroundColor: 'var(--emr-accent-alpha-15)' } : undefined}
            >
              {t('pacs.tools.mpr')}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconCube size={16} />}
              onClick={() => handleSelectGridLayout('3d-solo')}
              disabled={!isVolumetric}
              style={is3DActive && !isMPRActive ? { backgroundColor: 'var(--emr-accent-alpha-15)' } : undefined}
            >
              {t('pacs.tools.3dSolo')}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconBox size={16} />}
              onClick={() => handleSelectGridLayout('3d-mixed')}
              disabled={!isMPREnabled}
              style={is3DActive && isMPRActive ? { backgroundColor: 'var(--emr-accent-alpha-15)' } : undefined}
            >
              {t('pacs.tools.mprPlus3d')}
            </Menu.Item>
            <Menu.Divider />
            <Menu.Label>{t('pacs.protocol.title')}</Menu.Label>
            <Menu.Item leftSection={<IconDeviceFloppy size={16} />} onClick={handleSaveProtocol}>
              {t('pacs.protocol.saveLayout')}
            </Menu.Item>
            <Menu.Item leftSection={<IconReload size={16} />} onClick={handleResetProtocol}>
              {t('pacs.protocol.resetDefault')}
            </Menu.Item>
            {stableAvailableProtocols.length > 0 && (
              <>
                <Menu.Divider />
                <Menu.Label>{t('pacs.protocol.available')}</Menu.Label>
                {stableAvailableProtocols.map((protocol) => (
                  <Menu.Item key={protocol.id} leftSection={<IconLayoutGrid size={16} />} onClick={() => handleSelectProtocol(protocol)}>
                    {getProtocolDisplayName(protocol)}
                  </Menu.Item>
                ))}
              </>
            )}
          </Menu.Dropdown>
        </Menu>

        {/* 3. W/L Presets dropdown — wraps the existing WindowPresets verbatim */}
        <Menu shadow="md" width={260} position="bottom-start" withArrow closeOnItemClick={false} classNames={PACS_MENU_CLASSNAMES}>
          <Menu.Target>
            <Tooltip label={t('pacs.sidebar.presets')} position="bottom" withArrow>
              <button className="pacs-topbar-btn pacs-topbar-trigger" aria-label={t('pacs.sidebar.presets')} data-testid="pacs-wl-presets-menu">
                <IconAdjustmentsHorizontal size={20} />
                <IconChevronDown size={12} className="pacs-group-chevron" />
              </button>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{t('pacs.sidebar.presets')}</Menu.Label>
            <div className="pacs-topbar-presets-wrap">
              <WindowPresets
                activePreset={activeWLPreset}
                onPresetChange={handleWindowPresetChange}
              />
            </div>
          </Menu.Dropdown>
        </Menu>

        {/* 4. The moved PACSToolbar — every prop preserved verbatim */}
        <div className="pacs-topbar-toolbar">
          <PACSErrorBoundary t={t}>
          <PACSToolbar
            activeTool={viewerState?.activeTool ?? 'StackScroll'}
            activeViewportId={viewerState?.activeViewportId}
            onToolChange={handleToolChange}
            onRotateCW={handleRotateCW}
            onRotateCCW={handleRotateCCW}
            onFlipH={handleFlipH}
            onFlipV={handleFlipV}
            onReset={handleResetAll}
            isMPRActive={isMPRActive}
            isMPREnabled={isMPREnabled}
            onMPRToggle={handleMPRToggle}
            is3DActive={is3DActive}
            is3DEnabled={isVolumetric}
            on3DToggle={handle3DToggle}
            scrollSyncEnabled={scrollSyncEnabled}
            wlSyncEnabled={wlSyncEnabled}
            onToggleScrollSync={stableToggleScrollSync}
            onToggleWLSync={stableToggleWLSync}
            modality={studyModality}
            isCalibrating={calibrationHook.isCalibrating}
            isStenosisActive={isStenosisActive}
            onCalibrate={handleCalibrate}
            onStenosis={toggleStenosis}
            isCalibrated={calibrationHook.calibration !== null}
            isDSAActive={dsa.dsaState.isActive}
            onDSAToggle={dsa.toggleDSA}
            segmentationPanelVisible={segmentationPanelVisible}
            onToggleSegmentationPanel={toggleSegmentationPanel}
            activeImageFilter={imageFilters.activeFilter}
            onApplyImageFilter={imageFilters.applyFilter}
            onClearImageFilter={imageFilters.clearFilter}
            onUndo={handleUndoAnnotation}
            onRedo={handleRedoAnnotation}
            canUndo={!isMedplumDisabled && annotations.canUndo}
            canRedo={!isMedplumDisabled && annotations.canRedo}
            onClearAnnotations={handleClearAnnotations}
          />
          </PACSErrorBoundary>
        </div>

        {/* 5. Flex spacer — pushes the right-hand cluster to the far edge */}
        <div className="pacs-topbar-spacer" />

        {/* Active hanging-protocol indicator (moved verbatim from the sidebar) */}
        {activeProtocolDisplayName && (
          <span className="pacs-protocol-indicator">
            <IconLayoutGrid size={14} />
            <span className="pacs-protocol-text">{activeProtocolDisplayName}</span>
          </span>
        )}

        {/* Reopen the 3D Controls panel after it's been closed (only while 3D
             is active and the panel is currently hidden). */}
        {is3DActive && !panel3DVisible && (
          <Tooltip label={t('pacs.panel3d.title')} position="bottom" withArrow>
            <button
              className="pacs-topbar-btn"
              onClick={() => { setPanel3DVisible(true); setPanel3DExpanded(true); }}
              aria-label={t('pacs.panel3d.title')}
              data-testid="pacs-panel3d-reopen"
            >
              <IconCube size={20} />
            </button>
          </Tooltip>
        )}

        {/* 6. Moved SidebarActions — prev/next study, measure/key-image/colorbar
             toggles, fullscreen, close (every prop preserved verbatim) */}
        <PACSSidebarActions
          t={t}
          onPrevStudy={onPrevStudy}
          onNextStudy={onNextStudy}
          hasPrevStudy={hasPrevStudy}
          hasNextStudy={hasNextStudy}
          showMeasurements={showMeasurements}
          onToggleMeasurements={toggleMeasurements}
          showKeyImages={showKeyImages}
          onToggleKeyImages={toggleKeyImages}
          showColorBar={showColorBar}
          onToggleColorBar={toggleColorBar}
          isFullScreen={isFullScreen}
          onToggleFullScreen={onToggleFullScreen}
          onClose={onClose}
        />

        {/* 7. Workflow dropdown — folds the inline workflow buttons into one
             menu. The Critical-Alert count badge stays on the TRIGGER so a
             clinician sees pending criticals at a glance. */}
        <Menu shadow="md" width={260} position="bottom-end" withArrow classNames={PACS_MENU_CLASSNAMES}>
          <Menu.Target>
            <Tooltip label={t('pacs.sidebar.workflow')} position="bottom" withArrow>
              <button
                className="pacs-topbar-btn pacs-topbar-trigger"
                aria-label={t('pacs.sidebar.workflow')}
                data-testid="pacs-workflow-menu"
                style={{ position: 'relative' }}
              >
                <IconBriefcase size={20} />
                <IconChevronDown size={12} className="pacs-group-chevron" />
                {criticalAlerts.activeAlerts.length > 0 && (
                  <span
                    className="pacs-critical-badge"
                    aria-label={t('pacs.a11y.criticalCount', {
                      count: criticalAlerts.activeAlerts.length,
                    })}
                  >
                    {criticalAlerts.activeAlerts.length}
                  </span>
                )}
              </button>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{t('pacs.sidebar.workflow')}</Menu.Label>

            {/* Report */}
            {onToggleReport && (
	              <Menu.Item
	                leftSection={hasFindings ? <IconFileReport size={16} /> : <IconClipboardCheck size={16} />}
	                onClick={onToggleReport}
	                disabled={isMedplumDisabled}
	              >
                {hasFindings ? t('pacs.toolbar.viewFindings') : t('pacs.report.openReport')}
              </Menu.Item>
            )}

            {/* Critical Finding */}
            <Menu.Item
              leftSection={<IconAlertTriangle size={16} />}
              onClick={handleOpenCriticalAlert}
              disabled={!!criticalAlertUnavailableMessage}
              color="red"
            >
              {criticalAlertUnavailableMessage || t('pacs.criticalAlert.button')}
            </Menu.Item>

            {/* Save to PACS (DICOM SR) */}
            <Menu.Item
              leftSection={dicomSR.isSaving ? <IconLoader2 size={16} className="pacs-spinner" /> : <IconUpload size={16} />}
              onClick={dicomSR.saveToSR}
              disabled={dicomSR.isSaving || dicomSR.annotationCount === 0 || !pacsReachable}
            >
              {t('pacs.sr.saveToPacs')}
            </Menu.Item>

            {/* Load from PACS */}
            <Menu.Item
              leftSection={dicomSR.isLoading ? <IconLoader2 size={16} className="pacs-spinner" /> : <IconCloudDownload size={16} />}
              onClick={dicomSR.loadFromSR}
              disabled={dicomSR.isLoading || !pacsReachable}
            >
              {t('pacs.sr.loadFromPacs')}
            </Menu.Item>

            <Menu.Divider />

            {/* Export */}
            <Menu.Item leftSection={<IconDownload size={16} />} onClick={handleExportImage}>
              {t('pacs.viewer.exportImage')}
            </Menu.Item>

            {/* Anonymize */}
            <Menu.Item
              leftSection={isAnonymizing ? <IconLoader2 size={16} className="pacs-spinner" /> : <IconShieldCheck size={16} />}
              onClick={() => void handleAnonymizeExport?.()}
              disabled={isAnonymizing}
            >
              {isAnonymizing ? t('pacs.anonymize.downloading') : t('pacs.anonymize.button')}
            </Menu.Item>

            {/* DICOM Tags */}
            <Menu.Item leftSection={<IconFileInfo size={16} />} onClick={handleShowDicomTags}>
              {t('pacs.viewer.dicomTags')}
            </Menu.Item>

            <Menu.Divider />

            {/* Pop-out to second window (PACS-P4.5 — dual-monitor) */}
            <Menu.Item leftSection={<IconExternalLink size={16} />} onClick={handlePopOut} data-testid="pacs-popout-button">
              {t('pacs.popout.openTooltip')}
            </Menu.Item>

            {/* Shortcuts */}
            <Menu.Item leftSection={<IconKeyboard size={16} />} onClick={toggleHelp}>
              {t('pacs.shortcuts.title')}
            </Menu.Item>

            {/* Feature 079 (T060) — Plan TAVI entry point. Rendered LAST in the
                workflow group so existing action ordering is preserved per the
                pacs-regression CI gates (T488 + T465). The button self-hides
                when the user lacks `plan-procedure` or the study is not a
                cardiac candidate (owner-bypass per FR-008a) — so it only ever
                appears as the final workflow entry. */}
            {studyInfo?.id && (
              <div className="pacs-workflow-tavi-slot">
                <TaviActionButton
                  studyId={studyInfo.id}
                  studyDescription={studyInfo.description}
                  modalities={studyInfo.modalities}
                />
              </div>
            )}
          </Menu.Dropdown>
        </Menu>
      </div>

      {/* ==== DSA controls strip — shown directly under the top bar when DSA
           mode is active (moved verbatim out of the old sidebar) ==== */}
      {dsa.dsaState.isActive && (
        <div className="pacs-dsa-strip">
          <DSAControls
            maskFrameIndex={dsa.dsaState.maskFrameIndex ?? 0}
            totalFrames={cine.totalFrames || 1}
            shiftX={dsa.dsaState.shiftX}
            shiftY={dsa.dsaState.shiftY}
            showOriginal={dsa.dsaState.showOriginal}
            onMaskFrameChange={dsa.setMaskFrame}
            onShiftChange={dsa.setShift}
            onToggleShowOriginal={dsa.toggleShowOriginal}
          />
        </div>
      )}

      {/* ==== Body: collapsible series rail + the unchanged right content ==== */}
      <div className="pacs-viewer-body">
        {/* Thin dark collapsible series rail (was the old sidebar's SERIES
             section). Gated on hideSidebar (pop-out / studies-drawer pass it
             true) AND seriesRailOpen (the top-bar toggle). */}
        {!hideSidebar && (
          <div className="pacs-series-rail" data-open={seriesRailOpen ? 'true' : 'false'}>
            <div className="pacs-series-rail-header">
              {t('pacs.sidebar.series')} ({visibleSeriesItems.length})
            </div>
            {visibleSeriesItems.length > 0 && (
              <SeriesBrowser
                series={visibleSeriesItems}
                activeSeriesUid={activeSeriesUid}
                onSeriesSelect={handleSeriesSelect}
              />
            )}
          </div>
        )}

      {/* ---- Right Content: cloud banner + viewport grid + side panels ---- */}
      <div className="pacs-right-content">
        <CloudOfflineBanner status={cloudStatus} onRetry={retryConnection} />

        <div className="pacs-viewer-content">
          <PACSViewportGrid
            t={t}
            layout={layout}
            viewports={viewports}
            activeViewportId={activeViewportId}
            onViewportClick={handleViewportClick}
            cine={cine}
            studyInfo={studyInfo}
            formattedStudyDate={formattedStudyDate}
            activeSeriesDescription={activeSeriesDescription}
            studyModality={studyModality}
            calibrationHook={calibrationHook}
            calibrationPixelLength={calibrationPixelLength}
            isStenosisActive={isStenosisActive}
            stenosisSubMode={stenosisSubMode}
            qca={qca}
            showColorBar={showColorBar}
            showArrowTextInput={showArrowTextInput}
            onArrowTextClose={handleArrowTextClose}
            onExportCineVideo={handleExportCineVideo}
            volume3dBuildStatus={volume3dBuildStatus}
            onRetryVolume3d={retryVolume3d}
            renderingMode={renderingMode}
            slabThickness={slabThickness}
          />

        {/* Measurement side panel — toggled by the ruler button */}
        {showMeasurements && (
          <div className="pacs-measurements-sidebar" data-testid="pacs-measurements-sidebar">
            <PACSErrorBoundary t={t}>
              <MeasurementPanel
                annotations={annotations.annotations}
                visibleAuthors={annotations.visibleAuthors}
                onToggleVisibility={annotations.toggleAuthorVisibility}
                onToggleAnnotationVisibility={toggleAnnotationVisibility}
                onToggleAnnotationLock={toggleAnnotationLock}
                trackingMode={annotations.trackingMode}
                onTrackingModeChange={annotations.setTrackingMode}
                annotationMeta={annotations.annotationMeta}
                onJumpToAnnotation={annotations.jumpToAnnotation}
                onPromoteToTracked={annotations.promoteToTracked}
              />
              {/* COMPONENT-SURFACE MISMATCH (LiverRa port): the target
                  MeasurementPanel predates the upstream SR-export/calibration-gate
                  props (studyMeta, studyInstanceUid, studyFhirId,
                  canPersistCalibrationDependentData, calibrationWarning,
                  hasActiveCalibration) — dropped here; restore when
                  MeasurementPanel is uplifted to the MediMind surface. */}
            </PACSErrorBoundary>
          </div>
        )}

        {/* Key Image Gallery side panel — toggled by the star button */}
        {showKeyImages && fhirStudyId && (
          <div className="pacs-measurements-sidebar" data-testid="pacs-key-images-sidebar">
            <PACSErrorBoundary t={t}>
              <KeyImageGallery
                studyId={fhirStudyId}
                patientId={studyInfo?.patientId}
                currentSopInstanceUid={currentSopInstanceUid}
                currentFrameNumber={cine.isMultiFrame ? cine.currentFrame : undefined}
                onNavigate={handleKeyImageNavigate}
              />
            </PACSErrorBoundary>
          </div>
        )}

        {/* Stenosis results panel — shown when stenosis mode is active */}
        {isStenosisActive && (
          <div className="pacs-measurements-sidebar" data-testid="pacs-stenosis-sidebar">
            <PACSErrorBoundary t={t}>
              {/* Mode toggle: Manual vs Semi-Auto QCA */}
              <SegmentedControl
                value={stenosisSubMode}
                onChange={(val) => {
                  setStenosisSubMode(val as 'manual' | 'qca');
                  qca.resetQCA();
                }}
                data={[
                  { label: t('pacs.stenosis.manualMode'), value: 'manual' },
                  { label: t('pacs.stenosis.qcaMode'), value: 'qca' },
                ]}
                size="xs"
                style={{ marginBottom: 8 }}
                fullWidth
              />

              {stenosisSubMode === 'manual' ? (
                <StenosisTool
                  referenceVesselDiameter={stenosisRVD}
                  minimumLumenDiameter={stenosisMLD}
                  isCalibrated={calibrationHook.calibration !== null}
                />
              ) : (
                <>
                  <StenosisTool
                    referenceVesselDiameter={qca.result?.rvd ?? null}
                    minimumLumenDiameter={qca.result?.mld ?? null}
                    isCalibrated={calibrationHook.calibration !== null}
                    qcaResult={qca.result}
                    qcaMode={qca.mode}
                    qcaError={qca.error}
                  />
                  {/* QCA action buttons */}
                  {qca.mode === 'idle' && (
                    <Button
                      size="compact-sm"
                      variant="light"
                      color="blue"
                      onClick={qca.activateQCA}
                      disabled={!calibrationHook.calibration}
                      fullWidth
                      style={{ marginTop: 8 }}
                      styles={{ label: { overflow: 'visible', height: 'auto' } }}
                    >
                      {t('pacs.qca.startAnalysis')}
                    </Button>
                  )}
                  {(qca.mode === 'results' || qca.mode === 'picking_start' || qca.mode === 'picking_end') && (
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      color="gray"
                      onClick={qca.resetQCA}
                      fullWidth
                      style={{ marginTop: 4 }}
                      styles={{ label: { overflow: 'visible', height: 'auto' } }}
                    >
                      {t('pacs.qca.reset')}
                    </Button>
                  )}
                </>
              )}
            </PACSErrorBoundary>
          </div>
        )}

        {/* Segmentation panel — toggled by the segmentation panel button in toolbar */}
        <div
          className={`pacs-segmentation-sidebar ${segmentationPanelVisible ? 'open' : ''}`}
          data-testid="pacs-segmentation-sidebar"
        >
          {segmentationPanelVisible && (
            <PACSErrorBoundary t={t}>
              <SegmentationPanel
                segments={segmentation.segments}
                activeSegmentId={segmentation.activeSegmentId}
                activeTool={segmentation.activeTool}
                onSetActiveTool={segmentation.setActiveTool}
                onCreateSegment={segmentation.createSegment}
                onDeleteSegment={segmentation.deleteSegment}
                onSetActiveSegment={segmentation.setActiveSegment}
                onToggleVisibility={segmentation.toggleVisibility}
                thresholdMin={segThresholdMin}
                thresholdMax={segThresholdMax}
                onThresholdChange={handleThresholdChange}
              />
            </PACSErrorBoundary>
          )}
        </div>

        {/* 3D Controls panel — relocated from the toolbar. Docks on the right
            (mirrors the segmentation sidebar idiom) and is shown only while 3D
            mode is active and the panel hasn't been dismissed. All 3D handlers
            that used to go to PACSToolbar feed it instead. */}
        {is3DActive && panel3DVisible && (
          <PACSErrorBoundary t={t}>
            <Panel3DControls
              expanded={panel3DExpanded}
              onToggleExpanded={() => setPanel3DExpanded((v) => !v)}
              onClose={() => setPanel3DVisible(false)}
              vrInteractionMode={vrInteractionMode}
              onVrInteractionModeChange={handleVrInteractionModeChange}
              onIsolateToggle={handleIsolateToggle}
              isIsolateArmed={isIsolateArmed}
              isIsolateActive={isIsolateActive}
              onIsolateReset={handleIsolateReset}
              isIsolateLoading={isIsolateLoading}
              canIsolate={canIsolate}
              cutMode={cutMode}
              onCutModeChange={handleCutModeChange}
              cutCount={cutCount}
              onResetCuts={handleResetCuts}
              isCutLoading={isCutLoading}
              canRemove={canIsolate}
              onPresetChange={setTransferFunctionPreset}
              activePreset={viewerState?.viewports.get(viewerState.activeViewportId)?.volume3DPreset}
              onOrientationPreset={handleOrientationPreset}
              renderingMode={renderingMode}
              onRenderingModeChange={handleRenderingModeChange}
              slabThickness={slabThickness}
              onSlabThicknessChange={handleSlabThicknessChange}
              onReset3DRotation={reset3DRotation}
              onResetCrop={handleResetCrop}
              onReset3DView={handleReset3DView}
              onCaptureScreenshot={handleCaptureScreenshot}
            />
          </PACSErrorBoundary>
        )}
      </div>
      </div>
      </div>

      {/* Keyboard shortcuts help overlay — toggled by '?' key or toolbar button */}
      <PACSErrorBoundary t={t}>
        <KeyboardShortcutsHelp
          opened={isHelpOpen}
          onClose={closeHelp}
          shortcuts={shortcuts}
        />
      </PACSErrorBoundary>

      {/* DICOM tag browser modal */}
      <PACSErrorBoundary t={t}>
        <DicomTagBrowser
          opened={showTagBrowser}
          onClose={() => setShowTagBrowser(false)}
          studyInstanceUid={studyInstanceUid}
        />
      </PACSErrorBoundary>

      {/* Critical finding alert modal */}
      <CriticalAlertModal
        opened={criticalAlertOpen}
        onClose={() => setCriticalAlertOpen(false)}
        onCreateAlert={criticalAlerts.createAlert}
        reportId={criticalAlertReportId}
        patientId={studyInfo?.patientId ?? ''}
        defaultRecipientId={defaultCriticalRecipientId}
        recipients={criticalAlertRecipients}
      />

    </div>
  );
}
