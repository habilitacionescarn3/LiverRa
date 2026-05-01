// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * PacsStudyViewerView.
 *
 * Plain-English: opens an Orthanc-hosted DICOM study in the Cornerstone3D
 * stack viewer. Walks Study → Series (first) → Instances, pre-registers
 * metadata with the DICOM image loader, and drives a single stack
 * viewport. No AI overlays, no segmentation, no layers — just pixels.
 *
 * Why metadata pre-registration? Cornerstone3D's WADO-RS loader needs the
 * series metadata (Rows/Columns/BitsAllocated/PixelRepresentation…)
 * before it can decode any frame. Fetching `/metadata` once at startup
 * and stuffing each instance into the loader's `metaDataManager` is
 * dramatically faster than letting the loader lazy-fetch per image.
 *
 * Cleanup: unmount destroys the rendering engine + tool group so GPU
 * buffers are freed when the user navigates away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Group,
  Loader,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconEye,
} from '@tabler/icons-react';

import {
  EMRAlert,
  EMRPageHeader,
} from '../../components/common';
import { Enums, type RenderingEngine, type Types } from '@cornerstonejs/core';
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';

import {
  activateToolOnGroup,
  configureDicomAuth,
  destroyCornerstone,
  getOrCreateRenderingEngine,
  getOrCreateToolGroup,
  initCornerstone,
  RENDERING_ENGINE_ID,
  WINDOW_LEVEL_PRESETS,
} from '../../services/pacs/cornerstoneInit';
import { useDicomWebClient } from '../../hooks/useDicomWebClient';
import type { DicomJsonObject } from '../../services/pacs/dicomwebClient';
import { useTranslation } from '../../contexts/TranslationContext';
import { PACSErrorBoundary } from '../../components/pacs/PACSErrorBoundary';
import { WindowPresets } from '../../components/pacs/WindowPresets';
import ViewportOverlay from '../../components/pacs/ViewportOverlay';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VIEWPORT_ID = 'liverra-pacs-stack';

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
// Viewer
// ---------------------------------------------------------------------------

export default function PacsStudyViewerView(): JSX.Element {
  const { studyInstanceUid } = useParams<{ studyInstanceUid: string }>();
  const navigate = useNavigate();
  const client = useDicomWebClient();
  const { t } = useTranslation();
  const elementRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<RenderingEngine | null>(null);

  const [series, setSeries] = useState<DicomJsonObject[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<string | null>(null);
  const [imageCount, setImageCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Window/Level preset tracking — fed into <WindowPresets> for aria-checked
  // state and into <ViewportOverlay> for the W/L readout.
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [windowCenter, setWindowCenter] = useState<number | undefined>(undefined);
  const [windowWidth, setWindowWidth] = useState<number | undefined>(undefined);

  // Document title — surfaces a recognisable string in the browser tab strip.
  useEffect(() => {
    const base = t('pacs.header.title') ?? 'PACS viewer';
    const short = studyInstanceUid ? studyInstanceUid.slice(-12) : '';
    document.title = short ? `${base} · ${short} · LiverRa` : `${base} · LiverRa`;
  }, [t, studyInstanceUid]);

  // ---- 1. Init Cornerstone + enable a stack viewport ---------------------
  // Uses the shared engine + tool group from cornerstoneInit. On unmount we
  // call destroyCornerstone() which tears down the engine fully; React
  // Strict Mode's second mount then re-runs this effect with a fresh
  // engine. Staying on this "destroy + recreate" path keeps the whole
  // setup deterministic — earlier attempts to share state across mounts
  // left in-flight decodes orphaned and the setStack promise hanging.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await initCornerstone();
        configureDicomAuth(() => '');
        if (cancelled || !elementRef.current) return;

        const engine = getOrCreateRenderingEngine();
        engineRef.current = engine;

        engine.enableElement({
          viewportId: VIEWPORT_ID,
          element: elementRef.current,
          type: Enums.ViewportType.STACK,
        });

        const toolGroup = getOrCreateToolGroup();
        toolGroup.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);
        activateToolOnGroup('StackScroll');
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      destroyCornerstone();
      engineRef.current = null;
    };
  }, []);

  // ---- 1b. Keep the WebGL canvas sized to the container ------------------
  // Without this, Cornerstone3D fixes its internal canvas at whatever size
  // the container had on first mount (often before layout settles) and
  // never grows it. Symptom: tiny CT slices pinned to a corner.
  //
  // We intentionally use the default resize() args (immediate=false,
  // keepCamera=false) — matching medplum_medimind PACSViewer.tsx:1117 —
  // so every resize event re-fits the camera to the new canvas. An
  // earlier version passed keepCamera=true to preserve user pan/zoom,
  // but ResizeObserver.observe() fires once *immediately* with whatever
  // size the container has at observe-time; if that's pre-layout (tiny),
  // the camera gets locked at that zoom and later setStack auto-fits are
  // clobbered. A single-viewport viewer doesn't have enough user-pan
  // state for keepCamera=true to be worth the race.
  useEffect(() => {
    const container = elementRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      try {
        engineRef.current?.resize();
      } catch {
        // Engine may not be initialised yet or already torn down — ignore.
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ---- 2. Fetch series list ----------------------------------------------
  useEffect(() => {
    if (!studyInstanceUid) return;
    let cancelled = false;
    const ctrl = new AbortController();

    (async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const list = await client.qidoSeries(studyInstanceUid, undefined, ctrl.signal);
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => seriesNumber(a) - seriesNumber(b));
        setSeries(sorted);
        const firstUid = sorted[0] ? seriesInstanceUid(sorted[0]) : null;
        setSelectedSeries(firstUid ?? null);
        if (!firstUid) {
          setIsLoading(false);
        }
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
  }, [client, studyInstanceUid]);

  // ---- 3. Load the selected series into the viewport ---------------------
  // Note: this effect doesn't declare engineRef as a dependency (refs are
  // stable, React warns if you do). When the init effect races the stack
  // effect (Strict Mode double-mount), we poll briefly for the engine to
  // show up rather than giving up on the first tick.
  useEffect(() => {
    if (!studyInstanceUid || !selectedSeries) return;
    let cancelled = false;
    const ctrl = new AbortController();

    async function waitForEngine(): Promise<RenderingEngine | null> {
      // Try immediately, then back off up to ~1 s. Covers the common case
      // where the init effect's `initCornerstone()` promise settles after
      // this effect first runs.
      for (let i = 0; i < 20; i++) {
        if (cancelled) return null;
        if (engineRef.current) return engineRef.current;
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      return null;
    }

    (async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        // Fetch series metadata to extract the per-instance SOP UIDs we need
        // to build imageIds. We used to also pre-register each instance's
        // metadata with Cornerstone's wadors.metaDataManager, but that path
        // left setStack hanging for reasons the Cornerstone internals don't
        // surface — probably a mismatch between the key shape we seeded
        // (full `wadors:…/frames/1` URL) and the key shape the loader
        // actually looks up. Letting Cornerstone fetch /metadata itself is
        // slightly slower on first paint but deterministic.
        const seriesMetadata = await client.retrieveSeriesMetadata(
          studyInstanceUid,
          selectedSeries,
          ctrl.signal,
        );
        if (cancelled) return;

        // Sort by InstanceNumber (tag 00200013) so slice ordering matches
        // the scanner's emission order — avoids flipped stacks.
        const sortedByInstance = [...seriesMetadata].sort((a, b) => {
          const na = Number(firstString(a['00200013'])) || 0;
          const nb = Number(firstString(b['00200013'])) || 0;
          return na - nb;
        });

        // Pre-register each instance's metadata so Cornerstone's WADO-RS
        // loader can decode without a second /metadata round-trip per
        // frame. We deep-clone each metadata object because Cornerstone's
        // metaDataManager.add() uses `Object.defineProperty` with the
        // default (non-configurable) descriptor to stamp `isMultiframe`
        // onto the object — on React Strict Mode's double-mount the
        // second add() throws silently when re-stamping the same object,
        // which hangs setStack forever. Fresh objects each call = fresh
        // property definitions = no silent throw.
        const metaDataManager = (
          cornerstoneDICOMImageLoader as unknown as {
            wadors: { metaDataManager: { add: (id: string, md: unknown) => void } };
          }
        ).wadors.metaDataManager;

        const imageIds: string[] = [];
        for (const inst of sortedByInstance) {
          const sop = sopInstanceUid(inst);
          if (!sop) continue;
          const imageId = client.wadoInstance(studyInstanceUid, selectedSeries, sop);
          try {
            metaDataManager.add(imageId, JSON.parse(JSON.stringify(inst)));
          } catch {
            /* defineProperty race (Strict Mode) — lookup still works via fallback */
          }
          imageIds.push(imageId);
        }

        if (imageIds.length === 0) {
          setLoadError('This series has no renderable instances.');
          setIsLoading(false);
          return;
        }

        const engine = await waitForEngine();
        if (cancelled || !engine) return;
        const viewport = engine.getViewport(VIEWPORT_ID) as Types.IStackViewport | undefined;
        if (!viewport) {
          setLoadError('Viewport was not initialized — try reloading.');
          setIsLoading(false);
          return;
        }
        await viewport.setStack(imageIds);
        if (cancelled) return;

        // Belt-and-braces: Cornerstone3D auto-fits the camera during
        // setStack() using the canvas size AT THAT MOMENT — which may
        // still be init-time dimensions. engine.resize() with default
        // args (keepCamera=false) both resizes the canvas to match the
        // container AND re-fits the camera. Without this, the image
        // stays tiny in the middle of a big canvas.
        engine.resize();

        // Apply an initial window/level so CT pixels aren't clamped to black.
        // Prefer DICOM WindowCenter/WindowWidth (00281050 / 00281051) from
        // the first instance; fall back to the soft-tissue preset. The
        // metaDataManager.add() call above is wrapped in a silent try/catch
        // for Strict-Mode safety, so Cornerstone's automatic VOI pickup
        // isn't guaranteed — setting voiRange explicitly guarantees pixels.
        const firstInst = sortedByInstance[0];
        const wc = Number(firstString(firstInst?.['00281050']))
          || WINDOW_LEVEL_PRESETS.softTissue.center;
        const ww = Number(firstString(firstInst?.['00281051']))
          || WINDOW_LEVEL_PRESETS.softTissue.width;
        viewport.setProperties({
          voiRange: { lower: wc - ww / 2, upper: wc + ww / 2 },
        });

        viewport.render();
        if (cancelled) return;
        setImageCount(imageIds.length);
        setWindowCenter(wc);
        setWindowWidth(ww);
        setActivePreset(null); // DICOM VOI picked, not a preset
        setIsLoading(false);
      } catch (err) {
        // Aborts are normal on series-switch, unmount, or React Strict Mode's
        // double-mount. Swallow them silently no matter how they surface.
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
  }, [client, studyInstanceUid, selectedSeries]);

  // ---- Preset handlers ---------------------------------------------------
  // Called by <WindowPresets>. Matches the component's prop signature
  // `(key, center, width) => void`. Updates both the cornerstone viewport
  // AND the local tracking state so <ViewportOverlay> can show the current
  // W/L and <WindowPresets> can highlight the active button.
  const handlePresetChange = useCallback(
    (presetKey: string, center: number, width: number): void => {
      if (!engineRef.current) return;
      const viewport = engineRef.current.getViewport(VIEWPORT_ID) as
        | Types.IStackViewport
        | undefined;
      if (!viewport) return;
      viewport.setProperties({
        voiRange: { lower: center - width / 2, upper: center + width / 2 },
      });
      viewport.render();
      setActivePreset(presetKey);
      setWindowCenter(center);
      setWindowWidth(width);
    },
    [],
  );

  // Retry callback for PACSErrorBoundary. A full-route reload is simpler than
  // trying to thread recovery through all the useEffect cleanup paths — the
  // boundary only fires on crashes, so `location.reload()` is the honest UX.
  const handleRetry = useCallback((): void => {
    window.location.reload();
  }, []);

  // ---- Derived UI state --------------------------------------------------
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

  // Resolve the selected series object so <ViewportOverlay> can show
  // modality + description + (if present) patient name from DICOM tags.
  const selectedSeriesObj = useMemo(
    () => series.find((s) => seriesInstanceUid(s) === selectedSeries),
    [series, selectedSeries],
  );
  const overlayModality = selectedSeriesObj ? seriesModality(selectedSeriesObj) : undefined;
  const overlaySeriesDesc = selectedSeriesObj ? seriesDescription(selectedSeriesObj) : undefined;
  // PatientName (00100010) is a DICOM PersonName — may be { Alphabetic: "..." }
  const overlayPatientName = useMemo((): string | undefined => {
    const pn = selectedSeriesObj?.['00100010']?.Value?.[0];
    if (!pn) return undefined;
    if (typeof pn === 'string') return pn;
    if (typeof pn === 'object' && 'Alphabetic' in pn) {
      return String((pn as { Alphabetic?: string }).Alphabetic ?? '');
    }
    return undefined;
  }, [selectedSeriesObj]);
  const overlayStudyDate = useMemo((): string | undefined => {
    const d = firstString(selectedSeriesObj?.['00080020']);
    if (!d || d.length !== 8) return d;
    // DICOM DA format: YYYYMMDD → YYYY-MM-DD for humans
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }, [selectedSeriesObj]);

  if (!studyInstanceUid) {
    return (
      <Box p={{ base: 'md', md: 'lg' }}>
        <EMRAlert
          variant="error"
          icon={IconAlertTriangle}
          title="Missing study UID"
        >
          Route parameter <code>:studyInstanceUid</code> was not supplied.
        </EMRAlert>
      </Box>
    );
  }

  return (
    <PACSErrorBoundary onRetry={handleRetry} t={t}>
      <Stack
        gap="md"
        p={{ base: 'md', md: 'lg' }}
        data-testid="pacs-study-viewer"
      >
        <EMRPageHeader
          icon={IconEye}
          title={t('pacs.header.title')}
          subtitle={studyInstanceUid}
          showBack
          onBack={() => navigate('/pacs/studies')}
          actions={
            <WindowPresets
              activePreset={activePreset}
              onPresetChange={handlePresetChange}
              disabled={isLoading}
            />
          }
        />

        {seriesOptions.length > 1 && (
          <Select
            label={t('pacs.seriesBrowser.label')}
            data={seriesOptions}
            value={selectedSeries}
            onChange={setSelectedSeries}
            searchable={false}
            allowDeselect={false}
            maw={480}
            data-testid="pacs-series-select"
          />
        )}

        {loadError && (
          <EMRAlert
            variant="error"
            icon={IconAlertTriangle}
            title={t('pacs.error.viewerCrashTitle')}
          >
            {loadError}
          </EMRAlert>
        )}

        <Box
          // The viewport element. Cornerstone3D paints its WebGL canvas into
          // this div. Fixed aspect / min-height so the canvas always has
          // room even before the first image lands.
          ref={elementRef}
          data-testid="pacs-viewport"
          style={{
            width: '100%',
            height: 'min(70vh, 720px)',
            background: '#000',
            position: 'relative',
            borderRadius: 'var(--emr-border-radius-lg, 12px)',
            overflow: 'hidden',
            border: '1px solid var(--emr-border-color, var(--emr-gray-200))',
          }}
        >
          {/* DICOM burn-in overlays (patient + W/L + frame). Rendered in the
              viewport corners; pointer-events:none so the canvas still receives
              scroll / drag events through it. */}
          <ViewportOverlay
            patientName={overlayPatientName}
            studyDate={overlayStudyDate}
            modality={overlayModality}
            seriesDescription={overlaySeriesDesc}
            totalImages={imageCount > 0 ? imageCount : undefined}
            windowWidth={windowWidth}
            windowCenter={windowCenter}
          />
          {isLoading && (
            <Group
              justify="center"
              align="center"
              style={{ position: 'absolute', inset: 0, color: 'white', pointerEvents: 'none', zIndex: 10 }}
            >
              <Loader color="gray" />
              <Text c="white">{t('pacs.loading')}</Text>
            </Group>
          )}
        </Box>

        {imageCount > 0 && !isLoading && (
          <Text size="sm" c="dimmed">
            {imageCount} {t('pacs.images')} · {t('pacs.shortcuts.hint')}
          </Text>
        )}
      </Stack>
    </PACSErrorBoundary>
  );
}
