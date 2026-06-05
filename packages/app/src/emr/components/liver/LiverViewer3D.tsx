// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LiverViewer3D — Pass C (MPR + lesion + FLR plane overlays)
 *
 * Plain-English: this is the dark center pane on `/cases/{id}`. It supports
 * two view modes:
 *   - "axial": single Cornerstone3D StackViewport (Pass B behaviour). Used
 *     by default on mobile and as a fallback when MPR fails.
 *   - "mpr":   three OrthographicViewports (axial / sagittal / coronal)
 *     fed by a streaming volume. Synced scroll across all three.
 *
 * On top of every viewport sit lightweight 2D-canvas overlays:
 *   - parenchyma mask (Pass B)
 *   - lesion bboxes  (Pass C2 — yellow rectangles, hover tooltip)
 *   - FLR cutting plane (Pass C3 — translucent purple band/perimeter)
 *
 * This keeps the rendering pipeline simple: Cornerstone owns the CT
 * pixels, our DOM owns the analytic overlays. Pass C5 (proper Cornerstone
 * Segmentation labelmap) is a future upgrade.
 *
 * Why a 2D canvas overlay instead of Cornerstone's segmentation labelmap:
 *   - Stack mode in CS3D 4.x supports labelmap representations only when
 *     the labelmap is provided as a per-instance image array, which would
 *     require us to slice the NIfTI into N PNG-shaped images upfront.
 *   - The canvas-overlay pattern is what most clinical viewers (3D Slicer's
 *     2D mode, Horos, OsiriX) do and it's simpler to debug.
 *   - It costs ~3ms per slice on M1 — negligible compared to a CT decode.
 *
 * Composition:
 *   1. <PacsStudyViewerView> rendering pattern — proven to render real CT
 *      slices via the existing dicomweb client and `cornerstoneInit`.
 *   2. NIfTI parenchyma mask fetched once via
 *      `/api/v1/analyses/{id}/mask/liver` (auth-checked FastAPI proxy).
 *   3. A second `<canvas>` stacked on top of the Cornerstone canvas;
 *      redrawn on every IMAGE_RENDERED event with the current slice's
 *      mask voxels.
 *   4. <LayerTogglePanel> for visibility — only the parenchyma toggle is
 *      wired in this pass.
 *   5. <WindowPresets> reused from the PACS viewer for liver / soft tissue
 *      / bone presets.
 *
 * Mobile-first: the layer panel collapses gracefully on narrow widths
 * (44×44 tap targets, semi-transparent so the CT remains visible).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Group, Loader, Select, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import {
  IconCircleDashed,
  IconLayoutGrid,
  IconSquare,
} from '@tabler/icons-react';
import {
  Enums,
  eventTarget,
  setVolumesForViewports,
  volumeLoader,
  cache,
  type RenderingEngine,
  type Types,
} from '@cornerstonejs/core';
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';
import * as cornerstoneTools from '@cornerstonejs/tools';

import { EMRAlert } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';
import {
  activateToolOnGroup,
  attachLabelmapToViewports,
  configureDicomAuth,
  createLabelmapFromNifti,
  destroyCornerstone,
  getOrCreateRenderingEngine,
  getOrCreateToolGroup,
  initCornerstone,
  removeLabelmapSegmentation,
  RENDERING_ENGINE_ID,
  setLabelmapVisibility,
  WINDOW_LEVEL_PRESETS,
} from '../../services/pacs/cornerstoneInit';
import { useDicomWebClient } from '../../hooks/useDicomWebClient';
import type { DicomJsonObject } from '../../services/pacs/dicomwebClient';
import { WindowPresets } from '../pacs/WindowPresets';
import {
  LayerTogglePanel,
  COUINAUD_ALL_OFF,
  type CouinaudVisibility,
  type LayerVisibility,
} from './LayerTogglePanel';
import { loadNiftiAsLabelmap, maskUrl, type NiftiMask } from '../../services/pacs/niftiLoader';
import { resolveCanvasClick, resolveSegmentationId } from '../../services/pacs/viewerClickBridge';
import { LesionOverlay, type LesionDatum, type ViewOrientation } from './LesionOverlay';
import { FlrPlaneOverlay, type FlrPlaneInput } from './FlrPlaneOverlay';
import { MarkerOverlay } from './MarkerOverlay';
import type { ReviewerMarker } from '../../hooks/useMarkers';

const VIEWPORT_ID = 'liverra-cases-stack';
const MPR_AXIAL_ID = 'liverra-mpr-axial';
const MPR_SAGITTAL_ID = 'liverra-mpr-sagittal';
const MPR_CORONAL_ID = 'liverra-mpr-coronal';
const MPR_VIEWPORT_IDS = [MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID] as const;

// MPR-only tool group id. Kept separate from the shared
// `liverra-pacs-toolgroup` so CrosshairsTool (which crashes on
// single-viewport readers — see cornerstoneInit.ts:508) is opted in only
// when all three orthographic viewports are mounted together.
const MPR_TOOL_GROUP_ID = 'liverra-mpr-toolgroup';

// ---------------------------------------------------------------------------
// Pass D6 — anatomy-key derivation + colour palette
// ---------------------------------------------------------------------------
// Cornerstone labelmaps register under a stable per-anatomy key. The mask
// endpoint accepts the same key shape (`liver`, `couinaud-i..viii`,
// `portal-vein`, `hepatic-vein`).
type AnatomyKey =
  | 'liver'
  | 'couinaud-i'
  | 'couinaud-ii'
  | 'couinaud-iii'
  | 'couinaud-iv'
  | 'couinaud-v'
  | 'couinaud-vi'
  | 'couinaud-vii'
  | 'couinaud-viii'
  | 'vessels'
  | 'portal-vein'
  | 'hepatic-vein';

const COUINAUD_NUMBER_TO_KEY: Record<number, AnatomyKey> = {
  1: 'couinaud-i',
  2: 'couinaud-ii',
  3: 'couinaud-iii',
  4: 'couinaud-iv',
  5: 'couinaud-v',
  6: 'couinaud-vi',
  7: 'couinaud-vii',
  8: 'couinaud-viii',
};

/** Wong-Bang colour-blind-safe palette per Couinaud segment, RGBA. */
const COUINAUD_COLORS_RGBA: Record<AnatomyKey, [number, number, number, number]> = {
  liver:           [86, 199, 119, 100],
  'couinaud-i':    [230, 159, 0, 100],
  'couinaud-ii':   [86, 180, 233, 100],
  'couinaud-iii':  [0, 158, 115, 100],
  'couinaud-iv':   [240, 228, 66, 100],
  'couinaud-v':    [0, 114, 178, 100],
  'couinaud-vi':   [213, 94, 0, 100],
  'couinaud-vii':  [204, 121, 167, 100],
  'couinaud-viii': [100, 100, 100, 100],
  vessels:         [220, 38, 38, 110],
  'portal-vein':   [180, 50, 60, 110],
  'hepatic-vein':  [200, 100, 160, 110],
};

/** Minimal segmentation row shape from `/results.segmentations[]`. */
export interface SegmentationRow {
  id: string;
  anatomy_category?: string | null;
  anatomy_detail?: string | null;
  volume_ml?: string | number | null;
  mask_url?: string | null;
}

/**
 * Map a segmentation row to its canonical anatomy key. Returns `null` for
 * rows we don't know how to render (e.g. lesions, future categories).
 */
function anatomyKeyOf(row: SegmentationRow): AnatomyKey | null {
  const cat = (row.anatomy_category ?? '').toLowerCase().trim();
  if (cat === 'liver' || cat === 'parenchyma') return 'liver';
  if (cat === 'vessels' || cat === 'vessel' || cat === 'liver_vessels') return 'vessels';
  if (cat === 'portal_vein' || cat === 'portal-vein') return 'portal-vein';
  if (cat === 'hepatic_vein' || cat === 'hepatic-vein') return 'hepatic-vein';
  if (cat === 'couinaud') {
    const detail = (row.anatomy_detail ?? '').toString().toLowerCase().trim();
    // Detail can be a roman numeral ("ii"), a number ("2"), "segment_2", etc.
    const romanMatch = detail.match(/^(viii|vii|vi|v|iv|iii|ii|i)$/);
    if (romanMatch) return `couinaud-${romanMatch[1]}` as AnatomyKey;
    const numMatch = detail.match(/(\d+)/);
    if (numMatch) {
      const n = Number(numMatch[1]);
      if (n in COUINAUD_NUMBER_TO_KEY) return COUINAUD_NUMBER_TO_KEY[n];
    }
  }
  return null;
}

/** Props. */
export interface LiverViewer3DProps {
  analysisId: string;
  ready?: boolean;
  studyInstanceUid?: string;
  parenchymaMaskUri?: string;
  /** All segmentation rows from `/results.segmentations[]` — drives the
   *  per-anatomy MPR labelmaps (Pass D6). Shape mirrors the API. */
  segmentations?: SegmentationRow[];
  /** Lesion count from `/results` — gates the lesions toggle in the panel. */
  lesionCount?: number;
  /** Lesion list from `/results` — drives the bbox overlay (Pass C2). */
  lesions?: LesionDatum[];
  /** FLR default (plane_normal/offset/pose) for the cutting-plane overlay (Pass C3). */
  flrDefault?: FlrPlaneInput | null;
  /** Reviewer-placed markers from `/markers` — drives the marker-pin overlay (Phase H9). */
  markers?: ReviewerMarker[];
  /**
   * Currently-selected refine tool. When set, the viewer attaches DOM click
   * listeners on each viewport and emits `liverra:viewer-click` CustomEvents
   * with resolved voxel coords. When null/undefined, no listeners attach
   * (read-only viewing on the Case page stays click-inert).
   */
  activeTool?: 'add' | 'subtract' | 'prompt' | 'marker' | null;
  'data-testid'?: string;
}

// ---------------------------------------------------------------------------
// Tiny DICOM tag helpers (kept local — same shapes as PacsStudyViewerView)
// ---------------------------------------------------------------------------

function firstString(tag: DicomJsonObject[string] | undefined): string | undefined {
  const v = tag?.Value?.[0];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}
function sopInstanceUid(instance: DicomJsonObject): string | undefined {
  return firstString(instance['00080018']);
}
function seriesInstanceUid(series: DicomJsonObject): string | undefined {
  return firstString(series['0020000E']);
}
function seriesDescription(series: DicomJsonObject): string {
  return firstString(series['0008103E']) ?? 'Series';
}
function seriesModality(series: DicomJsonObject): string {
  return firstString(series['00080060']) ?? '';
}
function seriesNumber(series: DicomJsonObject): number {
  const n = firstString(series['00200011']);
  return n ? Number(n) : 0;
}

// ---------------------------------------------------------------------------
// Heuristic: pick the "best" series for primary rendering
// ---------------------------------------------------------------------------
// CT studies often contain 5-15 series (multiple phases, reformats, scout).
// For liver work the arterial phase 1.0mm reconstruction is the most useful
// default. We score each series and pick the highest.
//
// Scoring (simple, transparent):
//   +50  if description contains "arterial"
//   +20  if description contains "phase"
//   +10  per implied 1mm thickness keyword
//   −30  if description contains "scout" / "topogram" / "localizer"
//   −20  if description contains "MIP" / "MPR" / "VR" (already-reformatted)
//   tiebreaker: highest InstanceCount wins
// ---------------------------------------------------------------------------
function scoreSeries(s: DicomJsonObject): number {
  const desc = (firstString(s['0008103E']) ?? '').toLowerCase();
  const count = Number(firstString(s['00201209'])) || 0;
  let score = 0;
  if (desc.includes('arterial')) score += 50;
  if (desc.includes('phase')) score += 20;
  if (desc.match(/\b1\.?0?\s?mm\b/)) score += 10;
  if (desc.match(/(scout|topogram|localizer|surview)/)) score -= 30;
  if (desc.match(/\b(mip|mpr|vr|3d)\b/)) score -= 20;
  // Prefer larger series (more slices = primary rendering)
  score += Math.min(count / 50, 5);
  return score;
}

// ---------------------------------------------------------------------------
// Mask overlay rasteriser
// ---------------------------------------------------------------------------
// Plain-English: given the parsed NIfTI voxel buffer and a slice index,
// blit a single XY-plane of the volume onto a 2D canvas. The canvas sits
// directly on top of Cornerstone's WebGL canvas with mix-blend "screen"
// so non-zero mask pixels appear as a green tint over the CT.
//
// IMPORTANT: NIfTI vs DICOM slice ordering.
//   - DICOM stack instances are sorted by InstanceNumber (acquisition order).
//   - NIfTI z-axis depends on how the mask was generated. The MVP cascade
//     uses SimpleITK with default orientation (LPS / axial top-down) which
//     in our case matches DICOM. If we ever see flipped overlays the fix
//     is `slice = (zMax - 1 - sliceIndex)` here.
function drawMaskSlice(
  canvas: HTMLCanvasElement,
  mask: NiftiMask,
  sliceIndex: number,
  rgba: [number, number, number, number],
): void {
  const [w, h, d] = mask.dims;
  if (w <= 0 || h <= 0 || d <= 0) return;
  const safeIdx = Math.max(0, Math.min(d - 1, sliceIndex));

  // Draw at the mask's native resolution; Cornerstone scales the underlying
  // CT canvas via WebGL, and this overlay canvas is sized to fill the same
  // container — so as long as both have the same logical aspect they line
  // up. CT slices are typically 512×512 and the mask is too, so this is
  // a 1:1 paint in the common case.
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) return;

  const img = ctx.createImageData(w, h);
  const sliceStride = w * h;
  const start = safeIdx * sliceStride;
  const [r, g, b, a] = rgba;

  for (let i = 0; i < sliceStride; i++) {
    const v = mask.voxels[start + i];
    const off = i * 4;
    if (v && v !== 0) {
      img.data[off] = r;
      img.data[off + 1] = g;
      img.data[off + 2] = b;
      img.data[off + 3] = a;
    }
    // else leave alpha=0 (transparent)
  }
  ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// QIDO series loader (memoised by react-query)
// ---------------------------------------------------------------------------
function useStudySeries(studyInstanceUid: string | undefined): {
  series: DicomJsonObject[];
  isLoading: boolean;
  error: Error | null;
} {
  const client = useDicomWebClient();
  const q = useQuery<DicomJsonObject[], Error>({
    queryKey: ['liverra-study-series', studyInstanceUid],
    queryFn: async () => client.qidoSeries(studyInstanceUid!, undefined),
    enabled: !!studyInstanceUid,
    staleTime: 60_000,
  });
  return { series: q.data ?? [], isLoading: q.isLoading, error: q.error ?? null };
}

// ---------------------------------------------------------------------------
// Mask loader (react-query so it's cached + dedup'd across re-renders)
// ---------------------------------------------------------------------------
function useParenchymaMask(
  analysisId: string,
  enabled: boolean,
): {
  mask: NiftiMask | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const q = useQuery<NiftiMask, Error>({
    queryKey: ['liverra-mask', analysisId, 'liver'],
    queryFn: () => loadNiftiAsLabelmap(maskUrl(analysisId, 'liver')),
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return { mask: q.data, isLoading: q.isLoading, error: q.error ?? null };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LiverViewer3D({
  analysisId,
  ready = false,
  studyInstanceUid,
  parenchymaMaskUri,
  segmentations = [],
  lesionCount = 0,
  lesions = [],
  flrDefault = null,
  markers = [],
  activeTool = null,
  'data-testid': testId = 'liver-viewer-3d',
}: LiverViewer3DProps): React.ReactElement {
  const { t } = useTranslation();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<RenderingEngine | null>(null);
  const client = useDicomWebClient();

  // Mobile breakpoint — under 768 px we force single-axial view because
  // a 3-up grid is illegible on phones (per CLAUDE.md mobile-first rule).
  const isMobile = useMediaQuery('(max-width: 767px)');

  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [imageCount, setImageCount] = useState(0);
  const [currentSlice, setCurrentSlice] = useState(0);

  // Pass C1: view mode — 'axial' (Pass B fallback) or 'mpr' (3-up).
  // Default to MPR on desktop, Axial on mobile / when MPR fails.
  const [viewMode, setViewMode] = useState<'axial' | 'mpr'>(() =>
    typeof window !== 'undefined' && window.innerWidth >= 768 ? 'mpr' : 'axial',
  );
  // If the device flips below 768 (e.g. browser resize) force axial.
  useEffect(() => {
    if (isMobile && viewMode !== 'axial') setViewMode('axial');
  }, [isMobile, viewMode]);

  // Wheel gate: plain wheel anywhere in the viewer scrolls the PAGE.
  // Slice scrolling only fires when the user holds Shift while wheeling.
  // Cornerstone3D's internal wheel listener calls preventDefault, which
  // would otherwise block page scroll — we stop the event in the capture
  // phase so Cornerstone never sees it. When Shift is held, we let the
  // event through and Cornerstone's StackScrollTool (bound to Wheel in
  // the MPR tool group) fires, advancing slices.
  //
  // Applies to both axial and MPR modes for a consistent rule.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;
    const onWheelCapture = (e: WheelEvent) => {
      if (e.shiftKey) return;
      e.stopPropagation();
    };
    wrapper.addEventListener('wheel', onWheelCapture, { capture: true, passive: true });
    return () => {
      wrapper.removeEventListener('wheel', onWheelCapture, { capture: true });
    };
  }, []);

  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [windowCenter, setWindowCenter] = useState<number | undefined>(undefined);
  const [windowWidth, setWindowWidth] = useState<number | undefined>(undefined);

  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>({
    parenchyma: true,
    couinaud: { ...COUINAUD_ALL_OFF },
    vessels: false,
    lesions: lesionCount > 0,
    flrPlane: !!(flrDefault && (flrDefault.plane_pose || flrDefault.plane_normal)),
    markers: markers.length > 0,
  });

  // MPR slice indices per viewport. Each viewport scrolls independently
  // through its own depth axis; we track them so overlays can show the
  // right plane.
  const [mprSlices, setMprSlices] = useState<{ axial: number; sagittal: number; coronal: number }>(
    { axial: 0, sagittal: 0, coronal: 0 },
  );
  const [mprDims, setMprDims] = useState<{ axial: number; sagittal: number; coronal: number }>(
    { axial: 0, sagittal: 0, coronal: 0 },
  );
  const mprAxialRef = useRef<HTMLDivElement>(null);
  const mprSagittalRef = useRef<HTMLDivElement>(null);
  const mprCoronalRef = useRef<HTMLDivElement>(null);
  const activeVolumeIdRef = useRef<string | null>(null);
  // Pass D6 — track every anatomy labelmap registered with Cornerstone in
  // MPR mode. Keyed by anatomy key (`liver`, `couinaud-i`, …). Each entry
  // remembers the segmentationId so visibility toggles + teardown can
  // target it precisely. The ref shape is intentional: we mutate it across
  // re-renders without triggering them; a separate "tick" state forces a
  // re-render of the visibility-apply effect when needed.
  const activeSegsRef = useRef<Record<string, string>>({});
  // Cache of every NIfTI labelmap we've registered, keyed by AnatomyKey.
  // Used by the viewer-click bridge (Phase F) to sample voxel values and
  // resolve which Couinaud segment / parenchyma the reviewer clicked on.
  // Cleared when the analysis changes.
  const loadedMasksRef = useRef<Map<string, NiftiMask>>(new Map());
  const [registrationTick, setRegistrationTick] = useState(0);
  const [mprError, setMprError] = useState<string | null>(null);

  // Lesion + FLR labelmap registries (declared here, alongside activeSegsRef,
  // so the Phase-1 re-attach helper below can reference them). Their populating
  // effects live further down with the rest of the labelmap logic.
  const activeLesionSegsRef = useRef<Record<string, string>>({});
  const activeFlrSegsRef = useRef<Record<string, string>>({});

  // --- Phase 1 (case-viewer uplift): decouple the CT volume from the layout --
  // The rendering engine + (large) CT volume are created ONCE per series in
  // Effect A and survive every layout switch; only the viewport topology
  // rebuilds per viewMode in Effect B, which re-binds the CACHED volume (no
  // re-download, no stale-texture risk because the engine stays alive) and
  // re-attaches the labelmap representations the disabled panes dropped.
  //   • ctEpoch    — bumped by Effect A when the CT volume is ready → triggers B.
  //   • boundEpoch — bumped by Effect B after it binds + re-attaches → triggers
  //                  the labelmap-create effects so new toggles attach only
  //                  AFTER the panes hold the base volume (matches prior order).
  //   • enabledViewportIdsRef — panes currently registered, so a layout switch
  //                  disables exactly them (engine + volume left intact).
  const [ctEpoch, setCtEpoch] = useState(0);
  const [boundEpoch, setBoundEpoch] = useState(0);
  const imageIdsRef = useRef<string[]>([]);
  const enabledViewportIdsRef = useRef<string[]>([]);

  // Re-attach every registered labelmap representation to the given viewport
  // set after a layout rebuild (CS3D drops per-viewport representations when a
  // pane is disabled). Idempotent. Bumps registrationTick so the visibility
  // effects re-apply the right on/off state to the fresh representations.
  const reattachLabelmaps = useCallback(async (viewportIds: string[]): Promise<void> => {
    const entries: Array<[string, [number, number, number, number]]> = [];
    for (const [key, segId] of Object.entries(activeSegsRef.current)) {
      entries.push([segId, COUINAUD_COLORS_RGBA[key as AnatomyKey]]);
    }
    for (const segId of Object.values(activeLesionSegsRef.current)) {
      entries.push([segId, [250, 204, 21, 140]]);
    }
    for (const segId of Object.values(activeFlrSegsRef.current)) {
      entries.push([segId, [220, 38, 38, 130]]);
    }
    for (const [segId, color] of entries) {
      try {
        await attachLabelmapToViewports(segId, viewportIds, color);
      } catch {
        /* engine mid-teardown — the next rebuild will re-attach */
      }
    }
    if (entries.length > 0) setRegistrationTick((n) => n + 1);
  }, []);

  // --- Series discovery -----------------------------------------------------
  const { series, isLoading: seriesLoading, error: seriesError } = useStudySeries(
    ready ? studyInstanceUid : undefined,
  );
  const [selectedSeries, setSelectedSeries] = useState<string | null>(null);

  // Auto-pick the highest-scoring series once metadata lands.
  useEffect(() => {
    if (selectedSeries || series.length === 0) return;
    const ranked = [...series].sort((a, b) => scoreSeries(b) - scoreSeries(a));
    const uid = ranked[0] ? seriesInstanceUid(ranked[0]) : null;
    if (uid) setSelectedSeries(uid);
  }, [series, selectedSeries]);

  // --- Mask fetch ------------------------------------------------------------
  // Fetch the parenchyma mask whenever the cascade has produced one, either
  // via the legacy `parenchymaMaskUri` prop OR via a `'liver'` row in the
  // segmentations[] array (the path the cascade uses today). Without this
  // OR-condition the canvas overlay never renders in axial mode for cases
  // that come through segmentations[] only.
  const hasLiverSegRow = segmentations.some((s) => {
    const cat = (s.anatomy_category ?? '').toLowerCase().trim();
    return cat === 'liver' || cat === 'parenchyma';
  });
  const maskEnabled = ready && (!!parenchymaMaskUri || hasLiverSegRow);
  const { mask: parenchymaMask, error: maskError } = useParenchymaMask(analysisId, maskEnabled);

  // --- Effect A: Cornerstone engine + CT volume (once per series) -----------
  // Plain-English: build the rendering engine and load the (large) CT volume
  // a SINGLE time per series. Deliberately NOT keyed on viewMode — the engine
  // and the cached volume survive every layout switch, so toggling Axial / MPR
  // / 3D never re-downloads the scan and never hits the stale-GL-texture trap
  // (which only bites when a volume is kept across an engine *destroy*; here
  // the engine stays alive). Viewport topology + volume binding live in
  // Effect B below; this effect only owns the engine and the pixels.
  useEffect(() => {
    if (!ready || !studyInstanceUid || !selectedSeries) return undefined;
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        await initCornerstone();
        configureDicomAuth(() => '');
        if (cancelled) return;

        const engine = getOrCreateRenderingEngine();
        engineRef.current = engine;

        // Series metadata → ordered imageIds (sorted by InstanceNumber).
        const seriesMetadata = await client.retrieveSeriesMetadata(
          studyInstanceUid as string,
          selectedSeries as string,
          ctrl.signal,
        );
        if (cancelled) return;
        const sorted = [...seriesMetadata].sort((a, b) => {
          const na = Number(firstString(a['00200013'])) || 0;
          const nb = Number(firstString(b['00200013'])) || 0;
          return na - nb;
        });
        const metaDataManager = (
          cornerstoneDICOMImageLoader as unknown as {
            wadors: { metaDataManager: { add: (id: string, md: unknown) => void } };
          }
        ).wadors.metaDataManager;
        const imageIds: string[] = [];
        for (const inst of sorted) {
          const sop = sopInstanceUid(inst);
          if (!sop) continue;
          const id = client.wadoInstance(studyInstanceUid as string, selectedSeries as string, sop);
          try {
            metaDataManager.add(id, JSON.parse(JSON.stringify(inst)));
          } catch {
            /* strict-mode double-mount, ignore */
          }
          imageIds.push(id);
        }
        if (imageIds.length === 0) {
          setLoadError(t('analysis:viewer.loadFailed'));
          setIsLoading(false);
          return;
        }
        imageIdsRef.current = imageIds;

        // Stable, layout-INDEPENDENT volume id → reused on every layout switch
        // (cache hit, no re-download). Reuse the cached volume if already
        // loaded; otherwise create + load it once.
        const volumeId = `cornerstoneStreamingImageVolume:liverra-${selectedSeries}`;
        let volume = cache.getVolume(volumeId) as
          | (Types.IImageVolume & { loadStatus?: { loaded?: boolean } })
          | undefined;
        if (!volume) {
          volume = (await volumeLoader.createAndCacheVolume(volumeId, { imageIds })) as typeof volume;
        }
        activeVolumeIdRef.current = volumeId;
        if (volume && !volume.loadStatus?.loaded) {
          await volume.load();
        }
        if (cancelled) return;

        const liverPreset = WINDOW_LEVEL_PRESETS.liver ?? WINDOW_LEVEL_PRESETS.softTissue;
        setImageCount(imageIds.length);
        setCurrentSlice(0);
        setWindowCenter(liverPreset.center);
        setWindowWidth(liverPreset.width);
        setActivePreset('liver');
        // Signal "volume ready" → Effect B builds the viewports + binds it.
        setCtEpoch((e) => e + 1);
        setIsLoading(false);
      } catch (err) {
        if (cancelled || ctrl.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('abort')) return;
        setLoadError(msg);
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
      // Series / analysis change (or unmount): evict THIS series' CT volume and
      // drop the labelmaps registered against it (they are keyed to the
      // volume). The rendering engine itself is torn down only on unmount
      // (Effect D) so layout switches keep it — and the cached CT — alive.
      if (activeVolumeIdRef.current) {
        try { cache.removeVolumeLoadObject(activeVolumeIdRef.current); } catch { /* gone */ }
        activeVolumeIdRef.current = null;
      }
      const allLabelmapSegIds = [
        ...Object.values(activeSegsRef.current),
        ...Object.values(activeLesionSegsRef.current),
        ...Object.values(activeFlrSegsRef.current),
      ];
      for (const segId of allLabelmapSegIds) {
        try { removeLabelmapSegmentation(segId); } catch { /* gone */ }
        try { cache.removeVolumeLoadObject(segId); } catch { /* gone */ }
      }
      activeSegsRef.current = {};
      activeLesionSegsRef.current = {};
      activeFlrSegsRef.current = {};
      loadedMasksRef.current.clear();
      setImageCount(0);
    };
  }, [ready, studyInstanceUid, selectedSeries, client, t]);

  // Resize observer — fits the WebGL canvas to the container.
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      try {
        engineRef.current?.resize();
      } catch {
        /* not yet initialized */
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // --- Effect B: viewport topology + volume bind (per layout) ---------------
  // Plain-English: (re)build the viewports for the current layout and bind the
  // ALREADY-LOADED CT volume to them. Runs on every viewMode change and once
  // the volume becomes ready (ctEpoch). Because the engine is alive and the
  // volume is cached, the bind is a cache hit — instant, no re-download. After
  // binding we re-attach the labelmap representations that the disabled panes
  // dropped, then bump boundEpoch so the labelmap-create effects fire only
  // once the panes hold the base volume (preserves the old attach-after-bind
  // ordering). Layout teardown disables ONLY the viewports + the MPR tool
  // group; the engine, CT volume and segmentations survive.
  useEffect(() => {
    if (!ready || ctEpoch === 0) return undefined;
    const engine = engineRef.current;
    const volumeId = activeVolumeIdRef.current;
    if (!engine || !volumeId) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const liverPreset = WINDOW_LEVEL_PRESETS.liver ?? WINDOW_LEVEL_PRESETS.softTissue;
        const imageIds = imageIdsRef.current;
        const applyLiverVoi = (vp: Types.IVolumeViewport | undefined): void => {
          if (!vp) return;
          vp.resetCamera();
          try {
            vp.setProperties({
              voiRange: {
                lower: liverPreset.center - liverPreset.width / 2,
                upper: liverPreset.center + liverPreset.width / 2,
              },
            });
          } catch { /* properties API differs across CS versions */ }
          vp.render();
        };

        if (viewMode === 'axial') {
          // Single ORTHOGRAPHIC volume viewport (same renderer as MPR) so the
          // green parenchyma / yellow lesion / red FLR labelmaps register
          // identically here.
          if (!elementRef.current) return;
          engine.enableElement({
            viewportId: MPR_AXIAL_ID,
            element: elementRef.current,
            type: Enums.ViewportType.ORTHOGRAPHIC,
            defaultOptions: { orientation: Enums.OrientationAxis.AXIAL },
          });
          enabledViewportIdsRef.current = [MPR_AXIAL_ID];
          const tg = getOrCreateToolGroup();
          tg.addViewport(MPR_AXIAL_ID, RENDERING_ENGINE_ID);
          activateToolOnGroup('StackScroll');

          await setVolumesForViewports(engine, [{ volumeId }], [MPR_AXIAL_ID]);
          if (cancelled) return;
          const vp = engine.getViewport(MPR_AXIAL_ID) as Types.IVolumeViewport | undefined;
          applyLiverVoi(vp);
          engine.resize();
          const nSlices = (vp as (Types.IVolumeViewport & { getNumberOfSlices?: () => number }) | undefined)?.getNumberOfSlices?.() ?? imageIds.length;
          setMprDims({ axial: nSlices, sagittal: 0, coronal: 0 });
          // Jump to first lesion's z-center so the surgeon doesn't have to scroll.
          const firstBox = lesions.length > 0 ? lesions[0]?.bbox3d : null;
          const target =
            firstBox && firstBox.z !== undefined && firstBox.dz !== undefined
              ? Math.round(firstBox.z + firstBox.dz / 2)
              : Math.floor(nSlices / 2);
          setMprSlices((prev) => ({ ...prev, axial: target }));
          setCurrentSlice(target);
          try {
            const curIdx = (vp as (Types.IVolumeViewport & { getSliceIndex?: () => number }) | undefined)?.getSliceIndex?.() ?? 0;
            const delta = target - curIdx;
            if (delta !== 0) (vp as unknown as { scroll?: (d: number) => void })?.scroll?.(delta);
          } catch { /* viewport torn down */ }
          await reattachLabelmaps([MPR_AXIAL_ID]);
        } else {
          // MPR — three orthographic viewports.
          const ax = mprAxialRef.current;
          const sa = mprSagittalRef.current;
          const co = mprCoronalRef.current;
          if (!ax || !sa || !co) return;
          engine.setViewports([
            { viewportId: MPR_AXIAL_ID, element: ax, type: Enums.ViewportType.ORTHOGRAPHIC, defaultOptions: { orientation: Enums.OrientationAxis.AXIAL } },
            { viewportId: MPR_SAGITTAL_ID, element: sa, type: Enums.ViewportType.ORTHOGRAPHIC, defaultOptions: { orientation: Enums.OrientationAxis.SAGITTAL } },
            { viewportId: MPR_CORONAL_ID, element: co, type: Enums.ViewportType.ORTHOGRAPHIC, defaultOptions: { orientation: Enums.OrientationAxis.CORONAL } },
          ]);
          enabledViewportIdsRef.current = [MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID];
          // IMPORTANT: MPR viewports must belong to EXACTLY ONE tool group
          // (CrosshairsTool throws "Multiple tool groups found" otherwise). The
          // shared `liverra-pacs-toolgroup` is reserved for the axial fallback
          // + ComparisonView; MPR viewports are exclusive to `liverra-mpr-toolgroup`.
          const mprTg =
            cornerstoneTools.ToolGroupManager.getToolGroup(MPR_TOOL_GROUP_ID) ??
            cornerstoneTools.ToolGroupManager.createToolGroup(MPR_TOOL_GROUP_ID);
          if (mprTg) {
            for (const id of [MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID]) {
              try { mprTg.addViewport(id, RENDERING_ENGINE_ID); } catch { /* already in */ }
            }
            for (const toolName of ['Zoom', 'Pan', 'WindowLevel'] as const) {
              try { mprTg.addTool(toolName); } catch { /* already added */ }
            }
            try { mprTg.setToolActive('Zoom', { bindings: [{ numTouchPoints: 2 }] }); } catch { /* ignore */ }
            try { mprTg.setToolActive('Pan', { bindings: [{ numTouchPoints: 1 }, { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }] }); } catch { /* ignore */ }
            try { mprTg.setToolActive('WindowLevel', { bindings: [{ numTouchPoints: 3 }, { mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }] }); } catch { /* ignore */ }
          }

          try {
            await setVolumesForViewports(engine, [{ volumeId }], [MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID]);
            if (cancelled) return;
            for (const id of [MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID]) {
              applyLiverVoi(engine.getViewport(id) as Types.IVolumeViewport | undefined);
            }
            engine.resize();

            const dims = { axial: 0, sagittal: 0, coronal: 0 };
            for (const [id, key] of [
              [MPR_AXIAL_ID, 'axial'] as const,
              [MPR_SAGITTAL_ID, 'sagittal'] as const,
              [MPR_CORONAL_ID, 'coronal'] as const,
            ]) {
              const vp = engine.getViewport(id) as (Types.IVolumeViewport & { getNumberOfSlices?: () => number }) | undefined;
              dims[key] = vp?.getNumberOfSlices?.() ?? imageIds.length;
            }
            setMprDims(dims);
            // Default each plane toward the first lesion's bbox center so the
            // yellow ROI is visible on load (volume center if no lesions).
            const firstBox = lesions.length > 0 ? lesions[0]?.bbox3d : null;
            const lesionAx = firstBox && firstBox.z !== undefined && firstBox.dz !== undefined ? Math.round(firstBox.z + firstBox.dz / 2) : null;
            const lesionSa = firstBox && firstBox.x !== undefined && firstBox.dx !== undefined ? Math.round(firstBox.x + firstBox.dx / 2) : null;
            const lesionCo = firstBox && firstBox.y !== undefined && firstBox.dy !== undefined ? Math.round(firstBox.y + firstBox.dy / 2) : null;
            const targetSlices = {
              axial: lesionAx ?? Math.floor(dims.axial / 2),
              sagittal: lesionSa ?? Math.floor(dims.sagittal / 2),
              coronal: lesionCo ?? Math.floor(dims.coronal / 2),
            };
            setMprSlices(targetSlices);
            for (const [vpId, key] of [
              [MPR_AXIAL_ID, 'axial'] as const,
              [MPR_SAGITTAL_ID, 'sagittal'] as const,
              [MPR_CORONAL_ID, 'coronal'] as const,
            ]) {
              try {
                const vp = engine.getViewport(vpId) as (Types.IVolumeViewport & { scroll?: (d: number) => void; getSliceIndex?: () => number }) | undefined;
                const curIdx = vp?.getSliceIndex?.() ?? 0;
                const delta = targetSlices[key] - curIdx;
                if (delta !== 0 && vp?.scroll) vp.scroll(delta);
              } catch { /* viewport may be torn down */ }
            }

            // CrosshairsTool + StackScrollTool only AFTER the volume binds —
            // CrosshairsTool.initializeViewport reads FoR + camera state that
            // are undefined until setVolumesForViewports() runs.
            const mprTg2 = cornerstoneTools.ToolGroupManager.getToolGroup(MPR_TOOL_GROUP_ID);
            if (mprTg2) {
              try { mprTg2.addTool(cornerstoneTools.CrosshairsTool.toolName); } catch { /* already added */ }
              try {
                mprTg2.setToolActive(cornerstoneTools.CrosshairsTool.toolName, {
                  bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
                });
              } catch (e) {
                // eslint-disable-next-line no-console
                console.warn('[LiverViewer3D] CrosshairsTool activation failed:', e);
              }
              try { mprTg2.addTool(cornerstoneTools.StackScrollTool.toolName); } catch { /* already added */ }
              try {
                mprTg2.setToolActive(cornerstoneTools.StackScrollTool.toolName, {
                  bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
                });
              } catch (e) {
                // eslint-disable-next-line no-console
                console.warn('[LiverViewer3D] StackScrollTool activation failed:', e);
              }
            }
            await reattachLabelmaps([MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID]);
          } catch (volErr) {
            // MPR bind failed — drop back to axial mode with a friendly message.
            const msg = volErr instanceof Error ? volErr.message : String(volErr);
            setMprError(msg);
            setViewMode('axial');
            return;
          }
        }

        if (cancelled) return;
        // Panes now hold the base volume → let the labelmap-create effects run.
        setBoundEpoch((e) => e + 1);
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      // Layout switch: tear down ONLY the viewports + the MPR-only tool group.
      // The engine (Effect D), CT volume + labelmaps (Effect A) survive, so the
      // next layout re-binds the cached volume with no re-download.
      try {
        cornerstoneTools.ToolGroupManager.destroyToolGroup(MPR_TOOL_GROUP_ID);
      } catch {
        /* never created on this mount */
      }
      const eng = engineRef.current;
      if (eng) {
        for (const id of enabledViewportIdsRef.current) {
          try { eng.disableElement(id); } catch { /* gone */ }
        }
      }
      enabledViewportIdsRef.current = [];
    };
  }, [ready, viewMode, ctEpoch, reattachLabelmaps]);

  // --- Effect D: rendering-engine teardown on unmount ONLY ------------------
  // The CT volume + labelmaps are evicted by Effect A's series-change cleanup;
  // this tears down the engine itself, but only when the component truly
  // unmounts — layout switches must keep the engine (and the cached CT) alive.
  useEffect(() => {
    return () => {
      try { destroyCornerstone(); } catch { /* already gone */ }
      engineRef.current = null;
    };
  }, []);

  // --- Slice change tracking (drives mask overlay redraw) -------------------
  // Cornerstone fires an IMAGE_RENDERED event after each slice paint; the
  // event payload contains `imageId` from which we derive the index by
  // looking at the viewport. We listen on the global event target because
  // the stack-scroll tool fires per-frame and we want every redraw.
  useEffect(() => {
    if (!ready) return undefined;
    const handler = (evt: { detail?: { viewportId?: string } }): void => {
      const id = evt?.detail?.viewportId;
      if (!id) return;
      if (id === VIEWPORT_ID) {
        const vp = engineRef.current?.getViewport(VIEWPORT_ID) as
          | Types.IStackViewport
          | undefined;
        if (!vp) return;
        const idx = vp.getCurrentImageIdIndex?.() ?? 0;
        setCurrentSlice(idx);
        return;
      }
      // MPR viewports — read sliceIndex via getCurrentImageIdIndex (works
      // for VolumeViewports in CS3D 4.x; falls back to 0).
      if (id === MPR_AXIAL_ID || id === MPR_SAGITTAL_ID || id === MPR_CORONAL_ID) {
        const vp = engineRef.current?.getViewport(id) as
          | (Types.IVolumeViewport & {
              getCurrentImageIdIndex?: () => number;
              getSliceIndex?: () => number;
            })
          | undefined;
        if (!vp) return;
        const idx = vp.getSliceIndex?.() ?? vp.getCurrentImageIdIndex?.() ?? 0;
        setMprSlices((prev) => {
          if (id === MPR_AXIAL_ID && prev.axial !== idx) return { ...prev, axial: idx };
          if (id === MPR_SAGITTAL_ID && prev.sagittal !== idx) return { ...prev, sagittal: idx };
          if (id === MPR_CORONAL_ID && prev.coronal !== idx) return { ...prev, coronal: idx };
          return prev;
        });
      }
    };
    eventTarget.addEventListener(Enums.Events.IMAGE_RENDERED, handler as EventListener);
    return () => {
      eventTarget.removeEventListener(Enums.Events.IMAGE_RENDERED, handler as EventListener);
    };
  }, [ready]);

  // --- Phase F5/F6: viewer-click → dispatch ---------------------------------
  // When a refine tool is active, every left-click on a managed viewport is
  // translated to a voxel coordinate + segmentation ID and emitted as a
  // `liverra:viewer-click` CustomEvent. RefinementView's window listener
  // (`useEffect` at RefinementView.tsx:onViewerClick) is the consumer.
  //
  // Why DOM `click` and not a custom Cornerstone tool: we want to capture
  // the click without claiming the active tool slot (which is owned by
  // WindowLevel/Pan/Zoom). Right + middle buttons stay with Cornerstone.
  useEffect(() => {
    if (!activeTool || !ready) return undefined;

    const elements = [
      elementRef.current,
      mprAxialRef.current,
      mprSagittalRef.current,
      mprCoronalRef.current,
    ].filter((el): el is HTMLDivElement => el !== null);
    if (elements.length === 0) return undefined;

    const handler = (evt: MouseEvent): void => {
      // Left-click only — right/middle stay with Cornerstone's Pan/WL tools.
      if (evt.button !== 0) return;
      if (!analysisId) return;

      const engine = engineRef.current;
      if (!engine) return;

      // Find which viewport this click belongs to by matching the DOM element.
      const target = evt.currentTarget as HTMLElement;
      const allVps = engine.getViewports();
      const vp = allVps.find((v) => v.element === target);
      if (!vp) return;

      const rect = target.getBoundingClientRect();
      const click = resolveCanvasClick(vp, [
        evt.clientX - rect.left,
        evt.clientY - rect.top,
      ]);
      if (!click) return;

      const { segmentationId, couinaudSegment } = resolveSegmentationId(
        click.voxel,
        loadedMasksRef.current,
      );

      window.dispatchEvent(
        new CustomEvent('liverra:viewer-click', {
          detail: {
            voxel: click.voxel,
            segmentationId,
            couinaudSegment,
            // Phase G5: include the raw screen coordinates so the
            // MarkerLabelPopover can anchor its card next to the cursor.
            // Wrapper-relative conversion happens in the consumer
            // (RefinementView) — the viewer wrapper's bounding rect is
            // what the popover ultimately positions against.
            screenX: evt.clientX,
            screenY: evt.clientY,
            // NOTE: clickType is intentionally omitted — RefinementView's
            // activeTool-based routing is the single source of truth.
          },
        }),
      );
    };

    elements.forEach((el) => el.addEventListener('click', handler));
    return () => {
      elements.forEach((el) => el.removeEventListener('click', handler));
    };
  }, [activeTool, ready, analysisId, viewMode, registrationTick]);

  // --- Phase H8: liverra:focus-voxel listener -------------------------------
  // When the user hovers a row in MarkersList (or, later, LesionsList) the
  // row dispatches `liverra:focus-voxel` with the voxel coord it wants the
  // viewer to focus on. We translate the voxel back to world coords via the
  // volume's `indexToWorld` and call `setCamera({ focalPoint })` on each MPR
  // viewport. Stack viewport ignores — it's a 2D axial-only view that can't
  // re-center on an arbitrary voxel without changing the loaded slice (out
  // of scope for v1).
  //
  // Why a window listener and not a prop: MarkersList lives in a sibling
  // rail several DOM layers away. A CustomEvent on `window` avoids prop-
  // drilling through Refine + the rail's TanStack provider.
  useEffect(() => {
    if (!ready) return undefined;

    const handler = (evt: Event): void => {
      const detail = (evt as CustomEvent<{ voxel?: [number, number, number] }>)
        .detail;
      const voxel = detail?.voxel;
      if (!voxel || voxel.length !== 3) return;
      const engine = engineRef.current;
      if (!engine) return;

      for (const id of MPR_VIEWPORT_IDS) {
        const vp = engine.getViewport(id) as
          | (Types.IVolumeViewport & {
              getImageData?: () => { imageData?: { indexToWorld?: (i: [number, number, number]) => [number, number, number] } } | undefined;
              setCamera?: (opts: { focalPoint?: [number, number, number] }) => void;
              render?: () => void;
            })
          | undefined;
        if (!vp) continue;
        try {
          const imageData = vp.getImageData?.()?.imageData;
          const focal = imageData?.indexToWorld?.(voxel);
          if (!focal) continue;
          vp.setCamera?.({ focalPoint: focal });
          vp.render?.();
        } catch {
          // Cornerstone3D occasionally throws when a viewport's actor hasn't
          // been wired yet. Swallow — the next hover will retry.
        }
      }
    };

    window.addEventListener('liverra:focus-voxel', handler);
    return () => {
      window.removeEventListener('liverra:focus-voxel', handler);
    };
  }, [ready]);

  // --- Pass D6: build a per-anatomy "desired visibility" map ----------------
  // Plain-English: every toggle in the panel maps to one anatomy key. This
  // little helper turns the LayerVisibility state into a flat map so the
  // registration + visibility effects can iterate uniformly.
  const desiredVisibilityByKey = useMemo<Record<AnatomyKey, boolean>>(() => ({
    liver: layerVisibility.parenchyma,
    'couinaud-i':    layerVisibility.couinaud.i,
    'couinaud-ii':   layerVisibility.couinaud.ii,
    'couinaud-iii':  layerVisibility.couinaud.iii,
    'couinaud-iv':   layerVisibility.couinaud.iv,
    'couinaud-v':    layerVisibility.couinaud.v,
    'couinaud-vi':   layerVisibility.couinaud.vi,
    'couinaud-vii':  layerVisibility.couinaud.vii,
    'couinaud-viii': layerVisibility.couinaud.viii,
    vessels:         layerVisibility.vessels,
    // Portal/hepatic stay off until the cascade emits separate masks; the
    // UI exposes a single "vessels" toggle that maps to the combined mask.
    'portal-vein':   false,
    'hepatic-vein':  false,
  }), [layerVisibility]);

  // Available anatomy keys — set of keys derived from `segmentations[]` so
  // we never try to fetch a mask the cascade didn't produce.
  const availableAnatomyKeys = useMemo<Set<AnatomyKey>>(() => {
    const out = new Set<AnatomyKey>();
    for (const s of segmentations) {
      const k = anatomyKeyOf(s);
      if (k) out.add(k);
    }
    return out;
  }, [segmentations]);

  // --- Pass D6: lazy-load + register labelmaps as toggles flip on ----------
  // Plain-English: when the MPR view is active and the user enables a
  // toggle, we fetch the corresponding NIfTI mask and register it with
  // Cornerstone. We never re-fetch (idempotent on segId), and we keep the
  // labelmap around even after the toggle is flipped off so re-toggling is
  // instant. Teardown happens on unmount / mode switch only.
  useEffect(() => {
    if (viewMode !== 'mpr' && viewMode !== 'axial') return undefined;
    const volumeId = activeVolumeIdRef.current;
    if (!volumeId) return undefined;

    let cancelled = false;
    const keysToLoad: AnatomyKey[] = [];
    for (const key of Object.keys(desiredVisibilityByKey) as AnatomyKey[]) {
      if (!desiredVisibilityByKey[key]) continue;
      if (!availableAnatomyKeys.has(key)) continue;
      if (activeSegsRef.current[key]) continue; // already registered
      keysToLoad.push(key);
    }
    if (keysToLoad.length === 0) return undefined;

    (async () => {
      for (const key of keysToLoad) {
        if (cancelled) return;
        const segId = `liverra-seg-${key}-${analysisId}`;
        try {
          const nii = await loadNiftiAsLabelmap(maskUrl(analysisId, key));
          if (cancelled) return;
          // Phase F4: cache the parsed NIfTI so the viewer-click bridge can
          // sample it for segment-ID resolution without re-fetching.
          loadedMasksRef.current.set(key, nii);
          await createLabelmapFromNifti(volumeId, nii, segId);
          if (cancelled) return;
          await attachLabelmapToViewports(segId, [...MPR_VIEWPORT_IDS], COUINAUD_COLORS_RGBA[key]);
          if (cancelled) return;
          activeSegsRef.current[key] = segId;
          // Apply current visibility for THIS key immediately so the user
          // sees the labelmap on the next paint.
          const visible = desiredVisibilityByKey[key];
          for (const vpId of MPR_VIEWPORT_IDS) {
            setLabelmapVisibility(vpId, segId, visible);
          }
          try {
            engineRef.current?.renderViewports([...MPR_VIEWPORT_IDS]);
          } catch {
            /* engine may be mid-teardown */
          }
          // Force the visibility-apply effect to re-evaluate against the
          // freshly registered seg.
          setRegistrationTick((n) => n + 1);
        } catch (err) {
          console.warn(`[LiverViewer3D] failed to register labelmap for ${key}`, err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [viewMode, analysisId, boundEpoch, desiredVisibilityByKey, availableAnatomyKeys]);

  // --- Lesion mask labelmaps (renders the actual tumor contour, not a bbox) -
  // Plain-English: for every lesion the analysis surfaced, fetch its NIfTI
  // mask from `/lesion-mask/{lesion_id}` and register it as a yellow
  // labelmap. This gives the surgeon the same tumor outline they see in the
  // PDF report instead of the misleading bounding-rectangle.
  // (activeLesionSegsRef is declared up top alongside activeSegsRef so the
  //  Phase-1 re-attach helper can reference it.)
  useEffect(() => {
    if (viewMode !== 'mpr' && viewMode !== 'axial') return undefined;
    const volumeId = activeVolumeIdRef.current;
    if (!volumeId) return undefined;
    if (!layerVisibility.lesions || lesions.length === 0) return undefined;

    let cancelled = false;
    (async () => {
      for (const les of lesions) {
        if (cancelled) return;
        if (activeLesionSegsRef.current[les.id]) continue;
        const segId = `liverra-seg-lesion-${les.id}`;
        try {
          const url = `/api/v1/analyses/${encodeURIComponent(analysisId)}/lesion-mask/${encodeURIComponent(les.id)}`;
          const nii = await loadNiftiAsLabelmap(url);
          if (cancelled) return;
          await createLabelmapFromNifti(volumeId, nii, segId);
          if (cancelled) return;
          await attachLabelmapToViewports(segId, [...MPR_VIEWPORT_IDS], [250, 204, 21, 140]);
          if (cancelled) return;
          activeLesionSegsRef.current[les.id] = segId;
          for (const vpId of MPR_VIEWPORT_IDS) {
            setLabelmapVisibility(vpId, segId, true);
          }
          try {
            engineRef.current?.renderViewports([...MPR_VIEWPORT_IDS]);
          } catch { /* engine torn down */ }
          setRegistrationTick((n) => n + 1);
        } catch (err) {
          console.warn(`[LiverViewer3D] failed to register lesion mask ${les.id}`, err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [viewMode, analysisId, boundEpoch, layerVisibility.lesions, lesions]);

  // Toggle visibility of all lesion labelmaps when the "Lesions" checkbox flips.
  useEffect(() => {
    if (viewMode !== 'mpr' && viewMode !== 'axial') return;
    const map = activeLesionSegsRef.current;
    if (Object.keys(map).length === 0) return;
    for (const segId of Object.values(map)) {
      for (const vpId of MPR_VIEWPORT_IDS) {
        setLabelmapVisibility(vpId, segId, layerVisibility.lesions);
      }
    }
    try {
      engineRef.current?.renderViewports([...MPR_VIEWPORT_IDS]);
    } catch { /* torn down */ }
  }, [viewMode, layerVisibility.lesions, registrationTick]);

  // --- FLR cutting plane: visualise the resection by colouring removed
  // Couinaud segments in red. The cascade's segment-aware FLR plan emits
  // `plane_normal` + `plane_offset_mm` as null and provides a list of
  // removed segments instead (e.g. right hepatectomy → [V, VI, VII, VIII]).
  // Loading each removed segment's mask as a red labelmap lets the surgeon
  // see exactly what tissue is being resected; the boundary between red
  // and non-red is the cutting surface (Cantlie line for this case).
  // (activeFlrSegsRef is declared up top alongside activeSegsRef so the
  //  Phase-1 re-attach helper can reference it.)
  useEffect(() => {
    if (viewMode !== 'mpr' && viewMode !== 'axial') return undefined;
    const volumeId = activeVolumeIdRef.current;
    if (!volumeId) return undefined;
    if (!layerVisibility.flrPlane || !flrDefault) return undefined;
    const removed = (flrDefault.plane_pose?.removed_segments ?? []) as string[];
    if (removed.length === 0) return undefined;

    let cancelled = false;
    (async () => {
      for (const roman of removed) {
        if (cancelled) return;
        const key = `couinaud-${roman.toLowerCase()}` as AnatomyKey;
        if (activeFlrSegsRef.current[roman]) continue;
        const segId = `liverra-seg-flr-${key}-${analysisId}`;
        try {
          const nii = await loadNiftiAsLabelmap(maskUrl(analysisId, key));
          if (cancelled) return;
          await createLabelmapFromNifti(volumeId, nii, segId);
          if (cancelled) return;
          await attachLabelmapToViewports(segId, [...MPR_VIEWPORT_IDS], [220, 38, 38, 130]);
          if (cancelled) return;
          activeFlrSegsRef.current[roman] = segId;
          for (const vpId of MPR_VIEWPORT_IDS) {
            setLabelmapVisibility(vpId, segId, true);
          }
          try {
            engineRef.current?.renderViewports([...MPR_VIEWPORT_IDS]);
          } catch { /* torn down */ }
          setRegistrationTick((n) => n + 1);
        } catch (err) {
          console.warn(`[LiverViewer3D] failed to register FLR mask ${roman}`, err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [viewMode, analysisId, boundEpoch, layerVisibility.flrPlane, flrDefault]);

  // Toggle visibility of FLR red labelmaps with the FLR checkbox.
  useEffect(() => {
    if (viewMode !== 'mpr' && viewMode !== 'axial') return;
    const map = activeFlrSegsRef.current;
    if (Object.keys(map).length === 0) return;
    for (const segId of Object.values(map)) {
      for (const vpId of MPR_VIEWPORT_IDS) {
        setLabelmapVisibility(vpId, segId, layerVisibility.flrPlane);
      }
    }
    try {
      engineRef.current?.renderViewports([...MPR_VIEWPORT_IDS]);
    } catch { /* torn down */ }
  }, [viewMode, layerVisibility.flrPlane, registrationTick]);

  // --- Pass D6: tear down all registered labelmaps on unmount only ----------
  // Plain-English: keep labelmaps cached across Axial⇄MPR toggles so flipping
  // the view is instant. We only drop them when the analysis itself changes
  // (different case loaded) or the component unmounts. The MPR-only attach
  // effect above is idempotent, so re-entering MPR re-attaches without re-fetch.
  useEffect(() => {
    return () => {
      const ids = [
        ...Object.values(activeSegsRef.current),
        ...Object.values(activeLesionSegsRef.current),
        ...Object.values(activeFlrSegsRef.current),
      ];
      activeSegsRef.current = {};
      activeLesionSegsRef.current = {};
      activeFlrSegsRef.current = {};
      loadedMasksRef.current.clear();
      for (const segId of ids) {
        try { removeLabelmapSegmentation(segId); } catch { /* gone */ }
      }
    };
  }, [analysisId]);

  // --- Pass D6: apply per-anatomy visibility on every toggle change --------
  useEffect(() => {
    if (viewMode !== 'mpr' && viewMode !== 'axial') return;
    const map = activeSegsRef.current;
    if (Object.keys(map).length === 0) return;
    for (const key of Object.keys(map) as AnatomyKey[]) {
      const segId = map[key];
      if (!segId) continue;
      const visible = desiredVisibilityByKey[key] ?? false;
      for (const vpId of MPR_VIEWPORT_IDS) {
        setLabelmapVisibility(vpId, segId, visible);
      }
    }
    try {
      engineRef.current?.renderViewports([...MPR_VIEWPORT_IDS]);
    } catch {
      /* engine torn down — ignore */
    }
  }, [viewMode, desiredVisibilityByKey, registrationTick]);

  // --- Mask overlay redraw on slice / mask / visibility change --------------
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    if (!parenchymaMask || !layerVisibility.parenchyma || imageCount === 0) {
      // Clear the overlay when toggled off or mask not loaded.
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    // Map CT slice index to mask z-index. In v1 the mask is sometimes
    // shipped at a downsampled resolution (e.g. 128³) instead of matching
    // the original CT geometry — proportional mapping keeps the overlay
    // visually consistent across the volume even when geometries differ.
    // Once Pass C5 wires the real Triton parenchyma model end-to-end,
    // dims will match exactly and this becomes a 1:1 lookup.
    const maskZ = parenchymaMask.dims[2];
    const proportional = Math.floor((currentSlice / Math.max(imageCount - 1, 1)) * (maskZ - 1));
    drawMaskSlice(canvas, parenchymaMask, proportional, [72, 187, 120, 130]);
  }, [parenchymaMask, currentSlice, imageCount, layerVisibility.parenchyma]);

  // --- Handlers --------------------------------------------------------------
  const handlePresetChange = useCallback(
    (presetKey: string, center: number, width: number): void => {
      const engine = engineRef.current;
      if (!engine) return;
      const ids =
        viewMode === 'axial'
          ? [VIEWPORT_ID]
          : [MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID];
      for (const id of ids) {
        const vp = engine.getViewport(id) as
          | (Types.IStackViewport | Types.IVolumeViewport)
          | undefined;
        if (!vp) continue;
        try {
          vp.setProperties({ voiRange: { lower: center - width / 2, upper: center + width / 2 } });
          vp.render();
        } catch { /* viewport not yet ready */ }
      }
      setActivePreset(presetKey);
      setWindowCenter(center);
      setWindowWidth(width);
    },
    [viewMode],
  );

  const seriesOptions = useMemo(
    () =>
      series
        .map((s) => {
          const uid = seriesInstanceUid(s);
          if (!uid) return null;
          return {
            value: uid,
            label: `${seriesNumber(s)}. ${seriesDescription(s)}${seriesModality(s) ? ` · ${seriesModality(s)}` : ''}`,
          };
        })
        .filter((o): o is NonNullable<typeof o> => o !== null),
    [series],
  );

  // --- Empty / not-ready states ---------------------------------------------
  if (!ready) {
    return (
      <Stack
        data-testid={testId}
        p="lg"
        gap="sm"
        align="center"
        justify="center"
        style={{ height: '100%', background: 'var(--emr-gray-50)' }}
      >
        <IconCircleDashed size={48} stroke={1.25} color="var(--emr-gray-400)" aria-hidden="true" />
        <Text fz="var(--emr-font-md)" fw={600} c="var(--emr-text-primary)">
          {t('analysis:viewer.statusNotReady')}
        </Text>
        <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)" ta="center" maw={360}>
          {t('analysis:viewer.loading')}
        </Text>
      </Stack>
    );
  }

  if (!studyInstanceUid) {
    return (
      <Stack
        data-testid={testId}
        p="lg"
        gap="sm"
        align="center"
        justify="center"
        style={{ height: '100%', background: 'var(--emr-gray-50)' }}
      >
        <EMRAlert variant="info" title={t('analysis:viewer.statusNotReady')}>
          {t('analysis:viewer.noStudy')}
        </EMRAlert>
      </Stack>
    );
  }

  // ---------------------------------------------------------------------------
  return (
    <Box
      ref={wrapperRef}
      data-testid={testId}
      role="application"
      aria-label={t('analysis:viewer.ariaLabel')}
      tabIndex={0}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 420,
        background: '#000',
        outline: 'none',
        borderRadius: 'var(--emr-border-radius-lg, 12px)',
        overflow: 'hidden',
      }}
    >
      {viewMode === 'axial' ? (
        <>
          {/* The Cornerstone3D mount target. */}
          <div
            ref={elementRef}
            data-testid="liver-viewer-cs-mount"
            style={{ position: 'absolute', inset: 0 }}
            aria-hidden="true"
          />

          {/* Parenchyma mask overlay — same as Pass B. */}
          <canvas
            ref={overlayCanvasRef}
            data-testid="liver-viewer-mask-overlay"
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              mixBlendMode: 'screen',
              imageRendering: 'pixelated',
              opacity: layerVisibility.parenchyma && parenchymaMask ? 1 : 0,
              transition: 'opacity 120ms ease',
            }}
          />

          {/* Pass C2 — lesion bbox overlay (axial). */}
          <LesionOverlay
            lesions={lesions}
            sliceIndex={currentSlice}
            totalSlices={imageCount}
            volumeDims={[512, 512, Math.max(imageCount, 1)]}
            orientation="axial"
            visible={layerVisibility.lesions}
          />

          {/* Pass C3 — FLR cutting plane overlay (axial). */}
          <FlrPlaneOverlay
            flr={flrDefault}
            orientation="axial"
            sliceIndex={currentSlice}
            totalSlices={imageCount}
            volumeDims={[512, 512, Math.max(imageCount, 1)]}
            visible={layerVisibility.flrPlane}
          />

          {/* Phase H9 — reviewer-marker pin overlay (axial). */}
          <MarkerOverlay
            markers={markers}
            sliceIndex={currentSlice}
            totalSlices={imageCount}
            volumeDims={[512, 512, Math.max(imageCount, 1)]}
            orientation="axial"
            visible={layerVisibility.markers}
          />
        </>
      ) : (
        // ── MPR 3-up grid ──
        // Axial top-left (60% width), sagittal + coronal stacked on the right.
        // Each viewport gets its own analytic overlays. The CT is rendered
        // by Cornerstone's OrthographicViewport into the inner div.
        <Box
          data-testid="liver-viewer-mpr-grid"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            gridTemplateColumns: '3fr 2fr',
            gridTemplateRows: '1fr 1fr',
            gap: 4,
            background: '#000',
            padding: 4,
          }}
        >
          {/* Axial — spans both rows on the left. */}
          <Box
            style={{
              gridColumn: '1 / 2',
              gridRow: '1 / 3',
              position: 'relative',
              background: '#000',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <div
              ref={mprAxialRef}
              data-testid="liver-viewer-mpr-axial"
              style={{ position: 'absolute', inset: 0 }}
              aria-hidden="true"
            />
            <Text
              fz="var(--emr-font-xs)"
              fw={600}
              style={{
                position: 'absolute',
                top: 6,
                left: 8,
                color: 'rgba(255,255,255,0.85)',
                textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                letterSpacing: 0.4,
                zIndex: 4,
                pointerEvents: 'none',
              }}
            >
              {t('analysis:viewer.viewMode.panelTitle.axial')}
            </Text>
            <LesionOverlay
              lesions={lesions}
              sliceIndex={mprSlices.axial}
              totalSlices={mprDims.axial || imageCount}
              volumeDims={[512, 512, Math.max(imageCount, 1)]}
              orientation="axial"
              visible={layerVisibility.lesions}
            />
            <FlrPlaneOverlay
              flr={flrDefault}
              orientation="axial"
              sliceIndex={mprSlices.axial}
              totalSlices={mprDims.axial || imageCount}
              volumeDims={[512, 512, Math.max(imageCount, 1)]}
              visible={layerVisibility.flrPlane}
            />
            <MarkerOverlay
              markers={markers}
              sliceIndex={mprSlices.axial}
              totalSlices={mprDims.axial || imageCount}
              volumeDims={[512, 512, Math.max(imageCount, 1)]}
              orientation="axial"
              visible={layerVisibility.markers}
            />
          </Box>

          {/* Sagittal — top right. */}
          <Box
            style={{
              gridColumn: '2 / 3',
              gridRow: '1 / 2',
              position: 'relative',
              background: '#000',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <div
              ref={mprSagittalRef}
              data-testid="liver-viewer-mpr-sagittal"
              style={{ position: 'absolute', inset: 0 }}
              aria-hidden="true"
            />
            <Text
              fz="var(--emr-font-xs)"
              fw={600}
              style={{
                position: 'absolute',
                top: 6,
                left: 8,
                color: 'rgba(255,255,255,0.85)',
                textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                letterSpacing: 0.4,
                zIndex: 4,
                pointerEvents: 'none',
              }}
            >
              {t('analysis:viewer.viewMode.panelTitle.sagittal')}
            </Text>
            <LesionOverlay
              lesions={lesions}
              sliceIndex={mprSlices.sagittal}
              totalSlices={mprDims.sagittal || imageCount}
              volumeDims={[512, 512, Math.max(imageCount, 1)]}
              orientation="sagittal"
              visible={layerVisibility.lesions}
            />
            <FlrPlaneOverlay
              flr={flrDefault}
              orientation="sagittal"
              sliceIndex={mprSlices.sagittal}
              totalSlices={mprDims.sagittal || imageCount}
              volumeDims={[512, 512, Math.max(imageCount, 1)]}
              visible={layerVisibility.flrPlane}
            />
            <MarkerOverlay
              markers={markers}
              sliceIndex={mprSlices.sagittal}
              totalSlices={mprDims.sagittal || imageCount}
              volumeDims={[512, 512, Math.max(imageCount, 1)]}
              orientation="sagittal"
              visible={layerVisibility.markers}
            />
          </Box>

          {/* Coronal — bottom right. */}
          <Box
            style={{
              gridColumn: '2 / 3',
              gridRow: '2 / 3',
              position: 'relative',
              background: '#000',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <div
              ref={mprCoronalRef}
              data-testid="liver-viewer-mpr-coronal"
              style={{ position: 'absolute', inset: 0 }}
              aria-hidden="true"
            />
            <Text
              fz="var(--emr-font-xs)"
              fw={600}
              style={{
                position: 'absolute',
                top: 6,
                left: 8,
                color: 'rgba(255,255,255,0.85)',
                textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                letterSpacing: 0.4,
                zIndex: 4,
                pointerEvents: 'none',
              }}
            >
              {t('analysis:viewer.viewMode.panelTitle.coronal')}
            </Text>
            <LesionOverlay
              lesions={lesions}
              sliceIndex={mprSlices.coronal}
              totalSlices={mprDims.coronal || imageCount}
              volumeDims={[512, 512, Math.max(imageCount, 1)]}
              orientation="coronal"
              visible={layerVisibility.lesions}
            />
            <FlrPlaneOverlay
              flr={flrDefault}
              orientation="coronal"
              sliceIndex={mprSlices.coronal}
              totalSlices={mprDims.coronal || imageCount}
              volumeDims={[512, 512, Math.max(imageCount, 1)]}
              visible={layerVisibility.flrPlane}
            />
            <MarkerOverlay
              markers={markers}
              sliceIndex={mprSlices.coronal}
              totalSlices={mprDims.coronal || imageCount}
              volumeDims={[512, 512, Math.max(imageCount, 1)]}
              orientation="coronal"
              visible={layerVisibility.markers}
            />
          </Box>
        </Box>
      )}

      {/* Top toolbar — series picker (when >1) + W/L presets. */}
      <Box
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          right: 12,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
          zIndex: 4,
          pointerEvents: 'none',
        }}
      >
        {seriesOptions.length > 1 ? (
          <Box style={{ pointerEvents: 'auto', maxWidth: 320, flex: '1 1 220px', minWidth: 0 }}>
            <Select
              data={seriesOptions}
              value={selectedSeries}
              onChange={setSelectedSeries}
              size="xs"
              searchable={false}
              allowDeselect={false}
              data-testid="liver-viewer-series-select"
              styles={{
                input: {
                  background: 'rgba(15,23,42,0.78)',
                  color: 'var(--emr-text-inverse, #fff)',
                  border: '1px solid rgba(255,255,255,0.15)',
                },
              }}
            />
          </Box>
        ) : (
          <span />
        )}
        <Box style={{ pointerEvents: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {!isMobile && (
            <Group gap={4} wrap="nowrap" data-testid="liver-viewer-view-mode-toggle">
              <Button
                size="compact-sm"
                variant={viewMode === 'axial' ? 'filled' : 'light'}
                color="gray"
                leftSection={<IconSquare size={14} />}
                onClick={() => setViewMode('axial')}
                aria-label={t('analysis:viewer.viewMode.switchToAxial')}
                data-testid="view-mode-axial"
                styles={{ root: { background: viewMode === 'axial' ? 'rgba(59,130,246,0.85)' : 'rgba(15,23,42,0.78)', color: '#fff', border: '1px solid rgba(255,255,255,0.15)' } }}
              >
                {t('analysis:viewer.viewMode.axial')}
              </Button>
              <Button
                size="compact-sm"
                variant={viewMode === 'mpr' ? 'filled' : 'light'}
                color="gray"
                leftSection={<IconLayoutGrid size={14} />}
                onClick={() => setViewMode('mpr')}
                aria-label={t('analysis:viewer.viewMode.switchToMpr')}
                data-testid="view-mode-mpr"
                styles={{ root: { background: viewMode === 'mpr' ? 'rgba(59,130,246,0.85)' : 'rgba(15,23,42,0.78)', color: '#fff', border: '1px solid rgba(255,255,255,0.15)' } }}
              >
                {t('analysis:viewer.viewMode.mpr')}
              </Button>
            </Group>
          )}
          <WindowPresets
            activePreset={activePreset}
            onPresetChange={handlePresetChange}
            disabled={isLoading}
          />
        </Box>
      </Box>

      {/* Bottom-left: layer toggle. */}
      <LayerTogglePanel
        visibility={layerVisibility}
        onChange={setLayerVisibility}
        hasParenchymaMask={!!parenchymaMask || availableAnatomyKeys.has('liver')}
        hasCouinaud={
          availableAnatomyKeys.has('couinaud-i') ||
          availableAnatomyKeys.has('couinaud-ii') ||
          availableAnatomyKeys.has('couinaud-iii') ||
          availableAnatomyKeys.has('couinaud-iv') ||
          availableAnatomyKeys.has('couinaud-v') ||
          availableAnatomyKeys.has('couinaud-vi') ||
          availableAnatomyKeys.has('couinaud-vii') ||
          availableAnatomyKeys.has('couinaud-viii')
        }
        hasVessels={
          availableAnatomyKeys.has('vessels') ||
          availableAnatomyKeys.has('portal-vein') ||
          availableAnatomyKeys.has('hepatic-vein')
        }
        lesionCount={lesionCount}
        hasFlrPlane={!!(flrDefault && (flrDefault.plane_pose || flrDefault.plane_normal))}
        markerCount={markers.length}
      />

      {/* Bottom-right: slice counter. */}
      {imageCount > 0 && (
        <Box
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            padding: '4px 10px',
            borderRadius: 'var(--emr-border-radius-md, 8px)',
            background: 'rgba(15,23,42,0.78)',
            color: 'var(--emr-text-inverse, #fff)',
            fontSize: 'var(--emr-font-xs)',
            zIndex: 5,
          }}
          data-testid="liver-viewer-slice-counter"
        >
          {t('analysis:viewer.sliceCounter', {
            current: String(currentSlice + 1),
            total: String(imageCount),
          })}
          {windowCenter !== undefined && windowWidth !== undefined && (
            <span style={{ opacity: 0.7, marginLeft: 8 }}>
              W/L: {Math.round(windowWidth)} / {Math.round(windowCenter)}
            </span>
          )}
        </Box>
      )}

      {/* Loading state — Cornerstone needs a moment to decode its first frame. */}
      {(isLoading || seriesLoading) && (
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            pointerEvents: 'none',
            zIndex: 6,
          }}
        >
          <Stack gap="xs" align="center">
            <Loader color="gray" size="sm" />
            <Text c="white" fz="var(--emr-font-xs)">
              {t('analysis:viewer.loadingSeries')}
            </Text>
          </Stack>
        </Box>
      )}

      {/* Error states */}
      {(loadError || seriesError) && (
        <Box style={{ position: 'absolute', inset: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 7 }}>
          <EMRAlert variant="error" title={t('analysis:viewer.loadFailed')}>
            {loadError ?? seriesError?.message}
          </EMRAlert>
        </Box>
      )}
      {mprError && !loadError && viewMode === 'axial' && (
        <Box
          style={{
            position: 'absolute',
            top: 60,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 6,
            maxWidth: 360,
            pointerEvents: 'none',
          }}
          data-testid="liver-viewer-mpr-error"
        >
          <EMRAlert variant="info" title={t('analysis:viewer.viewMode.mprUnavailable')}>
            {mprError}
          </EMRAlert>
        </Box>
      )}
      {maskError && !loadError && (
        <Box
          style={{
            position: 'absolute',
            top: 60,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 6,
            maxWidth: 360,
            pointerEvents: 'none',
          }}
        >
          <EMRAlert variant="info" title={t('analysis:viewer.maskLoadFailed')}>
            {maskError.message}
          </EMRAlert>
        </Box>
      )}
    </Box>
  );
}

export default LiverViewer3D;
