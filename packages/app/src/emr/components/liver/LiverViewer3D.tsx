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
import { LesionOverlay, type LesionDatum, type ViewOrientation } from './LesionOverlay';
import { FlrPlaneOverlay, type FlrPlaneInput } from './FlrPlaneOverlay';

const VIEWPORT_ID = 'liverra-cases-stack';
const MPR_AXIAL_ID = 'liverra-mpr-axial';
const MPR_SAGITTAL_ID = 'liverra-mpr-sagittal';
const MPR_CORONAL_ID = 'liverra-mpr-coronal';
const MPR_VIEWPORT_IDS = [MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID] as const;

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
  'data-testid': testId = 'liver-viewer-3d',
}: LiverViewer3DProps): React.ReactElement {
  const { t } = useTranslation();
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

  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [windowCenter, setWindowCenter] = useState<number | undefined>(undefined);
  const [windowWidth, setWindowWidth] = useState<number | undefined>(undefined);

  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>({
    parenchyma: true,
    couinaud: { ...COUINAUD_ALL_OFF },
    vessels: false,
    lesions: lesionCount > 0,
    flrPlane: !!(flrDefault && (flrDefault.plane_pose || flrDefault.plane_normal)),
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
  const [registrationTick, setRegistrationTick] = useState(0);
  const [mprError, setMprError] = useState<string | null>(null);

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

  // --- Cornerstone init -----------------------------------------------------
  // The init effect re-runs when viewMode changes so the engine is rebuilt
  // for the right viewport topology (1 stack viewport vs. 3 orthographic).
  useEffect(() => {
    if (!ready || !studyInstanceUid) return undefined;
    let cancelled = false;
    (async () => {
      try {
        await initCornerstone();
        configureDicomAuth(() => '');
        if (cancelled) return;

        const engine = getOrCreateRenderingEngine();
        engineRef.current = engine;

        if (viewMode === 'axial') {
          if (!elementRef.current) return;
          engine.enableElement({
            viewportId: VIEWPORT_ID,
            element: elementRef.current,
            type: Enums.ViewportType.STACK,
          });
          const tg = getOrCreateToolGroup();
          tg.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);
          activateToolOnGroup('StackScroll');
        } else {
          // MPR — three orthographic viewports.
          const ax = mprAxialRef.current;
          const sa = mprSagittalRef.current;
          const co = mprCoronalRef.current;
          if (!ax || !sa || !co) return;
          engine.setViewports([
            {
              viewportId: MPR_AXIAL_ID,
              element: ax,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: { orientation: Enums.OrientationAxis.AXIAL },
            },
            {
              viewportId: MPR_SAGITTAL_ID,
              element: sa,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: { orientation: Enums.OrientationAxis.SAGITTAL },
            },
            {
              viewportId: MPR_CORONAL_ID,
              element: co,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: { orientation: Enums.OrientationAxis.CORONAL },
            },
          ]);
          const tg = getOrCreateToolGroup();
          for (const id of [MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID]) {
            try { tg.addViewport(id, RENDERING_ENGINE_ID); } catch { /* already in */ }
          }
          activateToolOnGroup('StackScroll');
        }
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      // Free the volume cache on teardown so switching modes doesn't leak.
      if (activeVolumeIdRef.current) {
        try { cache.removeVolumeLoadObject(activeVolumeIdRef.current); } catch { /* gone */ }
        activeVolumeIdRef.current = null;
      }
      try {
        destroyCornerstone();
      } catch {
        /* engine already torn down */
      }
      engineRef.current = null;
    };
  }, [ready, studyInstanceUid, viewMode]);

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

  // --- Series load (set stack) ----------------------------------------------
  useEffect(() => {
    if (!ready || !studyInstanceUid || !selectedSeries) return undefined;
    let cancelled = false;
    const ctrl = new AbortController();

    async function waitForEngine(): Promise<RenderingEngine | null> {
      for (let i = 0; i < 30; i++) {
        if (cancelled) return null;
        if (engineRef.current) return engineRef.current;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    }

    (async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
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
        const engine = await waitForEngine();
        if (cancelled || !engine) return;

        const liverPreset = WINDOW_LEVEL_PRESETS.liver ?? WINDOW_LEVEL_PRESETS.softTissue;

        if (viewMode === 'axial') {
          const viewport = engine.getViewport(VIEWPORT_ID) as Types.IStackViewport | undefined;
          if (!viewport) {
            setLoadError(t('analysis:viewer.loadFailed'));
            setIsLoading(false);
            return;
          }
          await viewport.setStack(imageIds);
          if (cancelled) return;
          engine.resize();

          viewport.setProperties({
            voiRange: {
              lower: liverPreset.center - liverPreset.width / 2,
              upper: liverPreset.center + liverPreset.width / 2,
            },
          });
          viewport.render();
        } else {
          // ── MPR path ──
          // Build a streaming 3-D volume from the per-slice image stack,
          // then attach it to the three orthographic viewports.
          const volumeId = `cornerstoneStreamingImageVolume:liverra-${selectedSeries}-${Date.now()}`;
          try {
            const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
            activeVolumeIdRef.current = volumeId;
            await volume.load();
            if (cancelled) return;
            await setVolumesForViewports(
              engine,
              [{ volumeId }],
              [MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID],
            );
            if (cancelled) return;
            // Reset cameras so each plane is centred, then apply the LIVER preset.
            for (const id of [MPR_AXIAL_ID, MPR_SAGITTAL_ID, MPR_CORONAL_ID]) {
              const vp = engine.getViewport(id) as Types.IVolumeViewport | undefined;
              if (vp) {
                vp.resetCamera();
                try {
                  vp.setProperties({
                    voiRange: {
                      lower: liverPreset.center - liverPreset.width / 2,
                      upper: liverPreset.center + liverPreset.width / 2,
                    },
                  });
                } catch { /* properties API may differ across CS versions */ }
                vp.render();
              }
            }
            engine.resize();

            // Capture initial slice depth per orientation for overlays.
            // VolumeViewport exposes getNumberOfSlices() (CS3D 4.x).
            const dims = {
              axial: 0,
              sagittal: 0,
              coronal: 0,
            };
            for (const [id, key] of [
              [MPR_AXIAL_ID, 'axial'] as const,
              [MPR_SAGITTAL_ID, 'sagittal'] as const,
              [MPR_CORONAL_ID, 'coronal'] as const,
            ]) {
              const vp = engine.getViewport(id) as
                | (Types.IVolumeViewport & { getNumberOfSlices?: () => number })
                | undefined;
              const n = vp?.getNumberOfSlices?.() ?? imageIds.length;
              dims[key] = n;
            }
            setMprDims(dims);
            setMprSlices({
              axial: Math.floor(dims.axial / 2),
              sagittal: Math.floor(dims.sagittal / 2),
              coronal: Math.floor(dims.coronal / 2),
            });
          } catch (volErr) {
            // MPR volume build failed — drop back to axial mode and surface
            // a friendly message rather than blanking the viewer.
            const msg = volErr instanceof Error ? volErr.message : String(volErr);
            setMprError(msg);
            setViewMode('axial');
            setIsLoading(false);
            return;
          }
        }

        setImageCount(imageIds.length);
        setCurrentSlice(0);
        setWindowCenter(liverPreset.center);
        setWindowWidth(liverPreset.width);
        setActivePreset('liver');
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
    };
  }, [client, ready, studyInstanceUid, selectedSeries, t, viewMode]);

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
    if (viewMode !== 'mpr') return undefined;
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
  }, [viewMode, analysisId, imageCount, desiredVisibilityByKey, availableAnatomyKeys]);

  // --- Pass D6: tear down all registered labelmaps on unmount only ----------
  // Plain-English: keep labelmaps cached across Axial⇄MPR toggles so flipping
  // the view is instant. We only drop them when the analysis itself changes
  // (different case loaded) or the component unmounts. The MPR-only attach
  // effect above is idempotent, so re-entering MPR re-attaches without re-fetch.
  useEffect(() => {
    return () => {
      const ids = Object.values(activeSegsRef.current);
      activeSegsRef.current = {};
      for (const segId of ids) {
        try { removeLabelmapSegmentation(segId); } catch { /* gone */ }
      }
    };
  }, [analysisId]);

  // --- Pass D6: apply per-anatomy visibility on every toggle change --------
  useEffect(() => {
    if (viewMode !== 'mpr') return;
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
            volumeDims={parenchymaMask?.dims ?? [512, 512, Math.max(imageCount, 1)]}
            orientation="axial"
            visible={layerVisibility.lesions}
          />

          {/* Pass C3 — FLR cutting plane overlay (axial). */}
          <FlrPlaneOverlay
            flr={flrDefault}
            orientation="axial"
            sliceIndex={currentSlice}
            totalSlices={imageCount}
            volumeDims={parenchymaMask?.dims ?? [512, 512, Math.max(imageCount, 1)]}
            visible={layerVisibility.flrPlane}
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
              volumeDims={parenchymaMask?.dims ?? [512, 512, Math.max(imageCount, 1)]}
              orientation="axial"
              visible={layerVisibility.lesions}
            />
            <FlrPlaneOverlay
              flr={flrDefault}
              orientation="axial"
              sliceIndex={mprSlices.axial}
              totalSlices={mprDims.axial || imageCount}
              volumeDims={parenchymaMask?.dims ?? [512, 512, Math.max(imageCount, 1)]}
              visible={layerVisibility.flrPlane}
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
              volumeDims={parenchymaMask?.dims ?? [512, 512, Math.max(imageCount, 1)]}
              orientation="sagittal"
              visible={layerVisibility.lesions}
            />
            <FlrPlaneOverlay
              flr={flrDefault}
              orientation="sagittal"
              sliceIndex={mprSlices.sagittal}
              totalSlices={mprDims.sagittal || imageCount}
              volumeDims={parenchymaMask?.dims ?? [512, 512, Math.max(imageCount, 1)]}
              visible={layerVisibility.flrPlane}
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
              volumeDims={parenchymaMask?.dims ?? [512, 512, Math.max(imageCount, 1)]}
              orientation="coronal"
              visible={layerVisibility.lesions}
            />
            <FlrPlaneOverlay
              flr={flrDefault}
              orientation="coronal"
              sliceIndex={mprSlices.coronal}
              totalSlices={mprDims.coronal || imageCount}
              volumeDims={parenchymaMask?.dims ?? [512, 512, Math.max(imageCount, 1)]}
              visible={layerVisibility.flrPlane}
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
