// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RefinementView — `/cases/:id/refine` (T180 production rewrite).
 *
 * Plain-English:
 *   The mask-editing workbench. A reviewer opens a case, grabs the
 *   exclusive "review seat" (so only one surgeon edits at a time), and
 *   clicks tools to add/subtract mask voxels or prompt the lesion model.
 *   Every click is wired through `useRefinementDispatch` which writes to
 *   the offline queue first, so nothing is lost when the network blinks.
 *
 * What this file owns (and what it does NOT own):
 *   - OWNS: seat lifecycle binding, keyboard shortcuts, undo/redo HUD,
 *     offline/sync badge, dev-only synthetic overlay flash on dispatch,
 *     permission-gated read-only mode, mobile rail → drawer layout.
 *   - DELEGATES: real pixel editing (LiverViewer3D + RefineTools own the
 *     Cornerstone3D plumbing; they're intentionally left as shells for
 *     v1), takeover protocol (TakeoverRequestToast), conflict resolution
 *     (ConflictResolutionModal self-mounts on 409 events).
 *
 * Why the synthetic overlay?
 *   Real Cornerstone3D mask-editing requires the ML backend. For v1 UX
 *   review we need to *feel* that edits happen. Behind `?devMockMask=1`
 *   every successful dispatch flashes a semi-transparent overlay on the
 *   viewer for ~600 ms, fading in/out (CSS transition; respected by
 *   `prefers-reduced-motion`). Production traffic never sees the flag.
 *
 * Spec refs: FR-015, FR-016, FR-017, FR-017a, FR-018c, plan §Review seat
 * concurrency, plan §Offline reviewer-edit durability.
 */

import { Badge, Box, Group, Kbd, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowLeft,
  IconCloud,
  IconCloudOff,
  IconEdit,
  IconKeyboard,
  IconLock,
} from '@tabler/icons-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import refinementStyles from './RefinementView.module.css';
import { RecordLockBanner } from '../../components/access-control';
import { FailedEditsAlert } from '../../components/cases/FailedEditsAlert';
import { LesionsList } from '../../components/cases/LesionsList';
import { MarkersList } from '../../components/cases/MarkersList';
import { SegmentsList } from '../../components/cases/SegmentsList';
import {
  EMRAlert,
  EMRButton,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRSkeleton,
} from '../../components/common';
import { CouinaudLegend } from '../../components/liver/CouinaudLegend';
import { LayerToggle, type LayerToggleState } from '../../components/liver/LayerToggle';
import { LiverViewer3D } from '../../components/liver/LiverViewer3D';
import { MarkerLabelPopover } from '../../components/liver/MarkerLabelPopover';
import { RefineTools, type RefineToolId } from '../../components/liver/RefineTools';
import { ReviewTools } from '../../components/liver/ReviewTools';
import { TakeoverRequestToast } from '../../components/liver/TakeoverRequestToast';
import { ConflictResolutionModal } from '../../components/offline/ConflictResolutionModal';
import { useTranslation } from '../../contexts/TranslationContext';
import { useRefinementUndo } from '../../contexts/RefinementUndoContext';
import { useAnalysis } from '../../hooks/useAnalysis';
import { useAnalysisResults } from '../../hooks/useAnalysisResults';
import { useMarkers } from '../../hooks/useMarkers';
import {
  useRefinementDispatch,
  type DispatchMaskRefineInput,
  type DispatchLesionPromptInput,
  type DispatchMarkerInput,
} from '../../hooks/useRefinementDispatch';
import { useReviewSeat } from '../../hooks/useReviewSeat';
import { useSync } from '../../contexts/SyncContext';
import { useAuth } from '../../services/auth';
import { maskUrl } from '../../services/pacs/niftiLoader';

/** Required permission for refining masks (outer guard usually catches missing). */
const REQUIRED_PERMISSION = 'review.refine_mask';

/** How long the dev-only synthetic overlay stays visible per dispatch (ms). */
const OVERLAY_FLASH_MS = 600;

/** Keyboard shortcut → tool mapping. */
const TOOL_KEY_MAP: Record<string, RefineToolId> = {
  v: 'add',
  b: 'subtract',
  l: 'prompt',
};

/** Default starting layer state — parenchyma on, segments/vessels/lesions off. */
const DEFAULT_LAYERS: LayerToggleState = {
  parenchyma: true,
  segments: false,
  vessels: false,
  lesions: false,
};

/**
 * Widened analysis shape — `useAnalysis()` types its return as the minimal
 * `Analysis` from AnalysisContext (just id + status + stage), but the actual
 * `/api/v1/analyses/{id}` payload includes `study_instance_uid`. Mirrors the
 * `BackendAnalysis` pattern in AnalysisDetailView. Without this, the viewer
 * receives `studyInstanceUid=undefined` and renders the "No DICOM study
 * attached" empty state.
 */
interface BackendAnalysis {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'partial';
  study_instance_uid?: string;
}

function readApiBaseUrl(fallback: string): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? fallback).replace(/\/$/, '');
}

/**
 * Resolve a viewer-click anatomy key (e.g. 'parenchyma', 'couinaud-vii') to
 * the actual segmentation row UUID from the cascade results. Returns null
 * when no row matches — the caller surfaces a user-visible error instead
 * of firing a request the backend will 422 on.
 *
 * The viewer-click bridge emits anatomy keys derived from labelmap samples;
 * the mask-refine endpoint requires the UUID of the segmentation row being
 * edited. This bridges the two namespaces.
 */
function resolveSegmentationUuid(
  anatomyKey: string,
  segmentations:
    | ReadonlyArray<{ id?: string; anatomy_category?: string | null; anatomy_detail?: string | null }>
    | undefined,
): string | null {
  if (!segmentations || segmentations.length === 0) return null;
  const key = anatomyKey.toLowerCase();
  for (const row of segmentations) {
    const cat = (row.anatomy_category ?? '').toLowerCase();
    if (key === 'parenchyma' && (cat === 'liver' || cat === 'parenchyma')) {
      return row.id ?? null;
    }
    if (key.startsWith('couinaud-')) {
      if (cat !== 'couinaud') continue;
      const wantRoman = key.replace('couinaud-', '').toUpperCase();
      const haveRoman = (row.anatomy_detail ?? '').toUpperCase();
      if (haveRoman === wantRoman) return row.id ?? null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inner component — providers (RefinementUndoProvider etc.) are expected to
// be wrapped at the route boundary in AnalysisDetailProviders. This file
// deliberately does NOT re-wrap them so tests can mock the hooks directly.
// ---------------------------------------------------------------------------

function RefinementViewInner(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { id: analysisId } = useParams<{ id: string }>();

  const auth = useAuth();
  const seat = useReviewSeat(analysisId);
  const sync = useSync();
  const undo = useRefinementUndo();
  const dispatch = useRefinementDispatch();
  const { analysis: analysisRaw } = useAnalysis(analysisId);
  const analysis = analysisRaw as BackendAnalysis | undefined;

  // Cascade results — same query key as the Case page so the cache is shared.
  const baseUrl = readApiBaseUrl('/api/v1');
  const { data: results } = useAnalysisResults(
    analysisId,
    baseUrl,
    analysis?.status,
  );

  // Phase H9 — markers feed the viewer's MarkerOverlay. Shares the
  // TanStack cache entry `['analysis', id, 'markers']` with the rail's
  // MarkersList, so the two stay in lock-step without a second fetch.
  const { data: markersData } = useMarkers(analysisId, baseUrl);
  const markers = markersData ?? [];

  // Layer-gating flags derived from the cascade output. `parenchymaMaskUri`
  // mirrors the Case-page pattern (LiverViewer3D accepts a direct URI for
  // backward compat with the older parenchyma-only render path).
  const hasParenchymaMask = Boolean(
    results?.segmentations?.some((s) => {
      const cat = (s.anatomy_category ?? '').toLowerCase();
      return cat === 'liver' || cat === 'parenchyma';
    }),
  );
  const hasCouinaud = Boolean(
    results?.segmentations?.some(
      (s) => (s.anatomy_category ?? '').toLowerCase() === 'couinaud',
    ),
  );
  const hasVessels = Boolean(
    results?.segmentations?.some((s) => {
      const cat = (s.anatomy_category ?? '').toLowerCase();
      return (
        cat === 'portal_vein' ||
        cat === 'portal' ||
        cat === 'hepatic_vein' ||
        cat === 'hepatic'
      );
    }),
  );
  const hasFlrPlane = Boolean(
    results?.flr_default?.plane_pose ?? results?.flr_default?.plane_normal,
  );
  const lesionCount = results?.lesions?.length ?? 0;
  // Touch hasCouinaud/hasVessels so they're available for future LayerToggle
  // gating without tripping the unused-var lint rule. (Viewer already gates
  // rendering on actual mask presence; explicit row-disable is Phase E.)
  void hasCouinaud;
  void hasVessels;
  void hasFlrPlane;
  const parenchymaMaskUri =
    hasParenchymaMask && analysisId ? maskUrl(analysisId, 'liver') : undefined;

  // Dev-bypass mirrors the auth dev-bypass: when `VITE_LIVERRA_DEV_BYPASS=true`,
  // skip the review-seat lock so the single dev user isn't locked out of the
  // toolbar by heartbeat flakiness (Vite proxy buffers, slow laptop, tab refocus
  // all trigger spurious 'lost' states). Production behaviour is unchanged.
  const devBypass =
    (import.meta as unknown as { env?: { VITE_LIVERRA_DEV_BYPASS?: string } })
      .env?.VITE_LIVERRA_DEV_BYPASS === 'true';

  // Dev-only synthetic overlay flash (behind ?devMockMask=1). Read via
  // react-router's useLocation so MemoryRouter-backed tests can drive it.
  const devMockMask = useMemo(() => {
    try {
      return (
        new URLSearchParams(location.search).get('devMockMask') === '1'
      );
    } catch (e) {
      // L-CATCH-6: malformed search string is dev-only territory; we
      // want a console.debug trace so the symptom is visible but the
      // user-facing UI must keep working.
      // eslint-disable-next-line no-console
      console.debug('[Refinement] URLSearchParams parse failed', { e });
      return false;
    }
  }, [location.search]);
  const [overlayFlash, setOverlayFlash] = useState<boolean>(false);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activeTool, setActiveTool] = useState<RefineToolId | null>(null);
  const [layers, setLayers] = useState<LayerToggleState>(DEFAULT_LAYERS);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  // Local "redo stack" — RefinementUndoContext only supports undo, so redo
  // is a thin in-memory mirror we reset whenever a new edit lands.
  const [redoStack, setRedoStack] = useState<string[]>([]);

  // Phase G5: when a marker dispatch succeeds we open an inline popover
  // anchored to the click position so the reviewer can add a label +
  // optional note without leaving the viewer.
  const viewerWrapRef = useRef<HTMLDivElement | null>(null);
  const [pendingMarker, setPendingMarker] = useState<{
    markerId: string;
    anchorX: number;
    anchorY: number;
  } | null>(null);

  const hasPermission = auth.permissions.includes(REQUIRED_PERMISSION);
  const isReadOnly = !devBypass && (!seat.hasSeat || !hasPermission);

  // ----- Seat lifecycle: acquire on mount, release on unmount ----------------
  //
  // C-REFINE-5: only release on unmount when we actually acquired the
  // seat. The previous version always called release() even when
  // acquire() had failed with seat-taken, which then fired a spurious
  // sendBeacon to /release for a review_id we don't own. We track
  // ``acquiredRef`` so cleanup is a strict no-op until the await
  // resolves successfully.
  //
  // M-REFINE-1: reset acquireAttemptedRef on .catch so a transient
  // failure (network blip, 503) doesn't latch the user out for the
  // lifetime of the view — the explicit "Retry" button clears the ref
  // too, but autoload should self-heal.
  //
  // M-REFINE-2: ref-pin ``seat.release`` so the cleanup callback always
  // reads the latest function reference rather than a stale closure.
  const acquireAttemptedRef = useRef<string | null>(null);
  const acquiredRef = useRef<boolean>(false);
  const releaseRef = useRef<typeof seat.release>(seat.release);
  releaseRef.current = seat.release;

  useEffect(() => {
    if (!analysisId) return undefined;
    // Only fire acquire once per analysisId to avoid hammering the API.
    if (acquireAttemptedRef.current !== analysisId) {
      acquireAttemptedRef.current = analysisId;
      // Only attempt if we don't already hold the seat. Tolerate mocks that
      // return undefined instead of a Promise.
      if (!seat.hasSeat) {
        try {
          const result = seat.acquire(analysisId) as unknown;
          if (
            result &&
            typeof (result as { then?: unknown }).then === 'function'
          ) {
            (result as Promise<unknown>)
              .then(() => {
                acquiredRef.current = true;
              })
              .catch(() => {
                // M-REFINE-1: clear the latch so a subsequent auto-mount
                // (e.g. tab refocus) can re-attempt without the user
                // having to click "Retry".
                acquireAttemptedRef.current = null;
              });
          } else {
            // Synchronous mocks — assume happy path.
            acquiredRef.current = true;
          }
        } catch {
          /* acquire threw synchronously — UI still renders */
          acquireAttemptedRef.current = null;
        }
      } else {
        acquiredRef.current = true;
      }
    }
    return () => {
      // C-REFINE-5: best-effort release ONLY if we actually held the seat.
      if (!acquiredRef.current) return;
      acquiredRef.current = false;
      try {
        const result = releaseRef.current();
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {
            /* ignore */
          });
        }
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps — we intentionally
    // run this only when the analysis id changes; ``seat.release`` is
    // pinned via releaseRef so a stale closure cannot fire.
  }, [analysisId]);

  // ----- Dispatch wrapper: on success, flash overlay + clear redo ------------
  const triggerOverlayFlash = useCallback((): void => {
    if (!devMockMask) return;
    setOverlayFlash(true);
    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = setTimeout(
      () => setOverlayFlash(false),
      OVERLAY_FLASH_MS,
    );
  }, [devMockMask]);

  useEffect(() => {
    return () => {
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    };
  }, []);

  const runMaskDispatch = useCallback(
    async (input: DispatchMaskRefineInput): Promise<void> => {
      setDispatchError(null);
      try {
        await dispatch.dispatchMaskRefine(input);
        setRedoStack([]);
        triggerOverlayFlash();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? 'dispatch failed');
        setDispatchError(
          t('refine:view.dispatchError', { message }),
        );
      }
    },
    [dispatch, triggerOverlayFlash, t],
  );

  const runLesionPromptDispatch = useCallback(
    async (input: DispatchLesionPromptInput): Promise<void> => {
      setDispatchError(null);
      try {
        await dispatch.dispatchLesionPrompt(input);
        triggerOverlayFlash();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? 'dispatch failed');
        setDispatchError(
          t('refine:view.dispatchError', { message }),
        );
      }
    },
    [dispatch, triggerOverlayFlash, t],
  );

  const runMarkerDispatch = useCallback(
    async (
      input: DispatchMarkerInput,
      anchor?: { screenX: number; screenY: number },
    ): Promise<void> => {
      setDispatchError(null);
      try {
        const editId = await dispatch.dispatchMarker(input);
        triggerOverlayFlash();
        // Phase G5: open the inline popover so the reviewer can add a
        // label + note. Anchor coords are converted from screen → viewer-
        // wrapper-relative so absolute positioning is correct even on
        // scrolled pages. The offline-queue editId stands in as the
        // popover's transient marker key — once PATCH /marker lands
        // (G7) we'll swap to the row id returned by the POST.
        if (anchor) {
          const wrap = viewerWrapRef.current;
          const rect = wrap?.getBoundingClientRect();
          const anchorX = rect ? anchor.screenX - rect.left : anchor.screenX;
          const anchorY = rect ? anchor.screenY - rect.top : anchor.screenY;
          setPendingMarker({ markerId: editId, anchorX, anchorY });
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? 'dispatch failed');
        setDispatchError(
          t('refine:view.dispatchError', { message }),
        );
      }
    },
    [dispatch, triggerOverlayFlash, t],
  );

  // Exposed on window for the LiverViewer3D sibling to hook into without
  // refactoring its Cornerstone event plumbing. Parent owns *when* a click
  // becomes a dispatch; viewer stays presentational.
  //
  // H-REFINE-3: every mask-edit dispatch carries an ``inverse`` so the
  // undo stack gets a poppable entry. Lesion-prompt clicks go to a
  // separate dispatch path (no inverse — prompts spawn new lesion rows,
  // the inverse is "delete that lesion" which is a different operation).
  // Marker tool is intentionally a no-op at the dispatch layer until the
  // measurement/marker FHIR Observation flow lands.
  useEffect(() => {
    if (!analysisId) return undefined;
    const onViewerClick = (ev: Event): void => {
      const detail = (
        ev as CustomEvent<{
          voxel: [number, number, number];
          clickType?: 'add' | 'subtract' | 'point';
          segmentationId?: string;
          couinaudSegment?: string;
          screenX?: number;
          screenY?: number;
        }>
      ).detail;
      if (!detail || !detail.voxel) return;

      // Route by active tool — the viewer can hint via detail.clickType
      // but the toolbar selection wins when no explicit hint is provided.
      if (activeTool === 'prompt' || detail.clickType === 'point') {
        void runLesionPromptDispatch({
          analysisId,
          voxel: detail.voxel,
          couinaudSegment: detail.couinaudSegment,
        });
        return;
      }
      if (activeTool === 'marker') {
        const anchor =
          typeof detail.screenX === 'number' && typeof detail.screenY === 'number'
            ? { screenX: detail.screenX, screenY: detail.screenY }
            : undefined;
        void runMarkerDispatch(
          {
            analysisId,
            voxel: detail.voxel,
            couinaudSegment: detail.couinaudSegment,
            segmentationId: detail.segmentationId,
            // label/note left undefined — captured by the inline popover (G5).
          },
          anchor,
        );
        return;
      }

      const clickType: 'add' | 'subtract' =
        detail.clickType === 'subtract' || activeTool === 'subtract'
          ? 'subtract'
          : 'add';
      const inverseClickType: 'add' | 'subtract' =
        clickType === 'add' ? 'subtract' : 'add';

      // The viewer-click bridge emits anatomy keys ('parenchyma',
      // 'couinaud-vii', ...) but the backend's mask-refine endpoint
      // requires the UUID of the segmentation row being edited. Resolve
      // from the cached cascade results — when no row matches, surface a
      // user-visible error rather than firing a 422.
      const anatomyKey = detail.segmentationId ?? 'parenchyma';
      const segmentationUuid = resolveSegmentationUuid(
        anatomyKey,
        results?.segmentations,
      );
      if (!segmentationUuid) {
        setDispatchError(
          t('refine:view.dispatchError', {
            message: `No segmentation row for "${anatomyKey}" at this voxel.`,
          }),
        );
        return;
      }

      void runMaskDispatch({
        analysisId,
        segmentationId: segmentationUuid,
        clickType,
        voxel: detail.voxel,
        inverse: { clickType: inverseClickType, voxel: detail.voxel },
      });
    };
    window.addEventListener(
      'liverra:viewer-click',
      onViewerClick as EventListener,
    );
    return () => {
      window.removeEventListener(
        'liverra:viewer-click',
        onViewerClick as EventListener,
      );
    };
  }, [analysisId, activeTool, runMaskDispatch, runLesionPromptDispatch, runMarkerDispatch]);

  // ----- Undo / redo handlers ------------------------------------------------
  const handleUndo = useCallback(async (): Promise<void> => {
    const popped = await undo.undo();
    if (popped) {
      setRedoStack((prev) => [...prev, popped.id]);
    }
  }, [undo]);

  const handleRedo = useCallback((): void => {
    // RefinementUndoContext does not expose a real redo. We surface this as
    // a UI affordance so power-users aren't surprised, but it is a no-op
    // beyond popping our own mirror stack.
    setRedoStack((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
  }, []);

  // ----- Keyboard shortcuts --------------------------------------------------
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable
      );
    };

    const onKey = (ev: KeyboardEvent): void => {
      if (isTypingTarget(ev.target)) return;

      const mod = ev.ctrlKey || ev.metaKey;
      const key = ev.key.toLowerCase();

      // Undo: Ctrl/Cmd + Z (without Shift)
      // C-REFINE-4: re-entrancy guard. Without this, mashing Ctrl-Z
      // before the previous undo has completed double-pops the stack
      // and double-enqueues inverses.
      if (mod && key === 'z' && !ev.shiftKey) {
        ev.preventDefault();
        if (undo.isUndoing) return;
        void handleUndo();
        return;
      }
      // Redo: Ctrl+Y OR Ctrl+Shift+Z
      if ((mod && key === 'y') || (mod && ev.shiftKey && key === 'z')) {
        ev.preventDefault();
        if (undo.isUndoing) return;
        handleRedo();
        return;
      }
      // Tool shortcuts require the seat + permission.
      if (isReadOnly) return;
      if (ev.key === '?') {
        // Keyboard-hint short-cut opens the glossary/help section.
        ev.preventDefault();
        navigate('/help#keyboard');
        return;
      }
      if (ev.key === 'Escape') {
        setActiveTool(null);
        return;
      }
      const toolKey = TOOL_KEY_MAP[key];
      if (toolKey && !mod && !ev.altKey) {
        ev.preventDefault();
        setActiveTool((prev) => (prev === toolKey ? null : toolKey));
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo, isReadOnly, navigate, undo.isUndoing]);

  // ----- Conflict modal wiring ----------------------------------------------
  // `ConflictResolutionModal` listens to LIVERRA_ERROR_EVENTS.ConflictResolution
  // and self-mounts — we just render it once below. The `useRefinementDispatch`
  // path pushes via offlineQueue → syncWorker → `conflictResolver.resolve()`
  // which fires that event on 409. No extra wiring needed here.

  // ----- Early returns: missing id / acquiring / taken / permission ----------
  if (!analysisId) {
    return (
      <Box p="md" data-testid="refinement-view-missing-id">
        <EMRAlert variant="warning">{t('refine:view.missingId')}</EMRAlert>
      </Box>
    );
  }

  if (seat.status === 'acquiring') {
    return (
      <Stack gap="md" p="md" data-testid="refinement-view-acquiring">
        <EMRSkeleton height={48} />
        <Text c="dimmed" size="sm">
          {t('refine:view.acquiring')}
        </Text>
        <EMRSkeleton height={400} />
      </Stack>
    );
  }

  if (
    !devBypass &&
    seat.status === 'idle' &&
    seat.holderDisplayName &&
    !seat.hasSeat
  ) {
    const retry = (): void => {
      acquireAttemptedRef.current = null;
      void seat.acquire(analysisId).catch(() => undefined);
    };
    return (
      <Box p="md" data-testid="refinement-view-seat-taken">
        <EMRAlert variant="warning" title={t('refine:view.seatTakenTitle')}>
          <Stack gap="xs">
            <Text size="sm">
              {t('refine:view.seatHeldBy', { holder: seat.holderDisplayName })}
            </Text>
            <Text size="sm" c="dimmed">
              {t('refine:view.seatTakenBody')}
            </Text>
            <Group>
              <EMRButton
                size="sm"
                variant="outline"
                onClick={retry}
                data-testid="refinement-view-retry-acquire"
              >
                {t('refine:view.retryAcquire')}
              </EMRButton>
              <EMRButton
                size="sm"
                variant="ghost"
                icon={IconArrowLeft}
                onClick={() => navigate(`/cases/${analysisId}`)}
              >
                {t('refine:view.back')}
              </EMRButton>
            </Group>
          </Stack>
        </EMRAlert>
      </Box>
    );
  }

  // ----- Main layout ---------------------------------------------------------

  const caseRef = analysis?.id ?? analysisId;
  const undoDepth = undo.stack.length;
  const redoDepth = redoStack.length;
  const lastEdit = undo.stack.length > 0
    ? undo.stack[undo.stack.length - 1]
    : null;

  const syncColor =
    sync.status === 'offline'
      ? 'var(--emr-warning)'
      : sync.status === 'syncing'
        ? 'var(--emr-accent)'
        : 'var(--emr-success)';

  const seatPillColor = (seat.hasSeat || devBypass)
    ? 'var(--emr-success)'
    : 'var(--emr-error)';

  return (
    <Stack
      gap={0}
      data-testid="refinement-view"
      style={{
        height: '100%',
        minHeight: 'calc(100vh - 64px)',
        background: 'var(--emr-bg-page)',
      }}
    >
      <Box px="md" pt="md">
        <EMRPageHeader
          icon={IconEdit}
          title={t('refine:view.title')}
          subtitle={t('refine:view.subtitle', { caseRef })}
          showBack
          onBack={() => navigate(`/cases/${analysisId}`)}
          actions={
            <Group gap="xs" wrap="wrap">
              <Badge
                variant="light"
                color="gray"
                leftSection={
                  <IconLock
                    size={12}
                    style={{ color: seatPillColor }}
                    aria-hidden
                  />
                }
                data-testid="refinement-view-seat-pill"
              >
                {seat.hasSeat || devBypass
                  ? t('refine:tools.heading')
                  : t('refine:view.seatLostTitle')}
              </Badge>
              <Badge
                variant="light"
                color="gray"
                leftSection={
                  <Box
                    component="span"
                    aria-hidden
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      color: syncColor,
                    }}
                  >
                    {sync.status === 'offline' ? (
                      <IconCloudOff size={12} />
                    ) : (
                      <IconCloud size={12} />
                    )}
                  </Box>
                }
                data-testid="refinement-view-sync-pill"
              >
                {sync.status === 'offline'
                  ? t('sync:offlineWithQueue', { count: sync.queueDepth })
                  : t('sync:onlineWithQueue', { count: sync.queueDepth })}
              </Badge>
            </Group>
          }
        />
      </Box>

      {seat.status === 'lost' && !devBypass && (
        <Box px="md" pt="xs">
          <RecordLockBanner
            status={{
              isLocked: true,
              timeRemainingMs: 0,
              canOverride: false,
            }}
          />
        </Box>
      )}

      {sync.status === 'offline' && sync.queueDepth > 0 && (
        <Box px="md" pt="xs">
          <EMRAlert
            variant="warning"
            data-testid="refinement-view-offline-banner"
          >
            {t('refine:view.offlineBanner')}
          </EMRAlert>
        </Box>
      )}

      {/* Phase H4 — surfaces edits the sync worker has given up on
          (typically 404s on deleted analyses). Renders nothing when
          there are none, so no chrome in the happy path. */}
      <FailedEditsAlert analysisId={analysisId} />

      {/* Phase H6 — read-only banner. The "another reviewer holds the
          seat" case is handled by the early-return alert above; this
          covers the residual states (no permission, or seat-not-yet-
          acquired without a known holder) so disabled tools never look
          unexplained. */}
      {isReadOnly && (
        <Box px="md" pt="xs">
          <EMRAlert
            variant="info"
            data-testid="refinement-view-readonly-banner"
          >
            {!hasPermission
              ? t('refine:readOnly.noPermission')
              : t('refine:readOnly.acquireCta')}
          </EMRAlert>
        </Box>
      )}


      {dispatchError && (
        <Box px="md" pt="xs">
          <EMRAlert
            variant="error"
            withCloseButton
            onClose={() => setDispatchError(null)}
            data-testid="refinement-view-dispatch-error"
          >
            {dispatchError}
          </EMRAlert>
        </Box>
      )}

      {/* Two-pane body. Rail collapses to a top strip on narrow viewports.
          L-REFINE-2: mobile-rail collapse rule lives in
          ``RefinementView.module.css`` (``.body``) instead of inline. */}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 280px) minmax(0, 1fr)',
          gap: 'var(--emr-spacing-md, 16px)',
          padding: 'var(--emr-spacing-md, 16px)',
          flex: 1,
          minHeight: 0,
        }}
        className={refinementStyles.body}
        data-testid="refinement-view-body"
      >

        {/* Left rail — tools + layers + undo HUD. */}
        <Stack
          gap="md"
          p="md"
          style={{
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-border-color, var(--emr-gray-200))',
            borderRadius: 'var(--emr-border-radius-lg, 12px)',
            minWidth: 0,
          }}
          data-testid="refinement-view-rail"
        >
          <Box>
            <Text
              fw="var(--emr-font-semibold, 600)"
              size="sm"
              mb="xs"
              c="var(--emr-text-primary)"
            >
              {t('refine:view.toolsHeading')}
            </Text>
            <Tooltip
              disabled={hasPermission}
              label={t('refine:view.permissionDeniedTooltip')}
              withArrow
            >
              <Box>
                <RefineTools
                  activeTool={activeTool}
                  onToolChange={setActiveTool}
                  disabled={isReadOnly}
                  data-testid="refinement-view-refine-tools"
                />
              </Box>
            </Tooltip>
          </Box>

          <ReviewTools
            analysisId={analysisId}
            onToolChange={setActiveTool}
          />

          <Box>
            <LayerToggle
              state={layers}
              onChange={setLayers}
              showLesions={lesionCount > 0}
            />
          </Box>

          <CouinaudLegend />

          {analysisId && (
            <Stack gap="xs" data-testid="refinement-view-segments-block">
              <Text
                fz="var(--emr-font-sm)"
                fw={600}
                c="var(--emr-text-primary)"
              >
                {t('refine:rail.segmentsHeading')}
              </Text>
              <SegmentsList analysisId={analysisId} apiBaseUrl={baseUrl} />
            </Stack>
          )}

          {analysisId && (
            <Stack gap="xs" data-testid="refinement-view-lesions-block">
              <Text
                fz="var(--emr-font-sm)"
                fw={600}
                c="var(--emr-text-primary)"
              >
                {t('refine:rail.lesionsHeading')}
              </Text>
              <LesionsList analysisId={analysisId} apiBaseUrl={baseUrl} />
            </Stack>
          )}

          {analysisId && (
            <Stack gap="xs" data-testid="refinement-view-markers-block">
              <Text
                fz="var(--emr-font-sm)"
                fw={600}
                c="var(--emr-text-primary)"
              >
                {t('refine:rail.markersHeading')}
              </Text>
              <MarkersList analysisId={analysisId} apiBaseUrl={baseUrl} />
            </Stack>
          )}

          {/* Undo / redo HUD. */}
          <Stack gap="xs" data-testid="refinement-view-undo-hud">
            <Group gap="xs" wrap="wrap">
              <EMRButton
                size="sm"
                variant="outline"
                icon={IconArrowBackUp}
                disabled={undoDepth === 0 || undo.isUndoing}
                onClick={() => void handleUndo()}
                data-testid="refinement-view-undo-button"
              >
                {t('refine:view.undo')}
              </EMRButton>
              <EMRButton
                size="sm"
                variant="outline"
                icon={IconArrowForwardUp}
                disabled={redoDepth === 0}
                onClick={handleRedo}
                data-testid="refinement-view-redo-button"
              >
                {t('refine:view.redo')}
              </EMRButton>
              {undoDepth > 0 && (
                <Badge size="sm" variant="light" color="gray">
                  {undoDepth === 1
                    ? t('refine:view.editCount', { count: undoDepth })
                    : t('refine:view.editCountPlural', { count: undoDepth })}
                </Badge>
              )}
            </Group>
            {lastEdit && (
              <Text size="xs" c="dimmed">
                {t('refine:view.lastEdit', { label: lastEdit.label })}
              </Text>
            )}
            <Tooltip
              withArrow
              multiline
              w={240}
              label={t('refine:view.keyboardList')}
            >
              <Box>
                <EMRButton
                  size="sm"
                  variant="ghost"
                  icon={IconKeyboard}
                  onClick={() => navigate('/help#keyboard')}
                  data-testid="refinement-view-keyboard-hint"
                >
                  {t('refine:view.keyboardHintShort')}
                </EMRButton>
              </Box>
            </Tooltip>
            <Group gap={4} wrap="wrap">
              <Kbd>V</Kbd>
              <Kbd>B</Kbd>
              <Kbd>L</Kbd>
              <Text size="xs" c="dimmed">
                · <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd>
              </Text>
            </Group>
          </Stack>
        </Stack>

        {/* Viewer pane — relative-positioned so the synthetic overlay can
            cover it without disturbing layout. */}
        <Box
          ref={viewerWrapRef}
          style={{
            position: 'relative',
            minHeight: 400,
            minWidth: 0,
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-border-color, var(--emr-gray-200))',
            borderRadius: 'var(--emr-border-radius-lg, 12px)',
            overflow: 'hidden',
          }}
          data-testid="refinement-view-viewer-wrap"
        >
          <LiverViewer3D
            analysisId={analysisId}
            ready={analysis?.status === 'completed'}
            studyInstanceUid={analysis?.study_instance_uid}
            parenchymaMaskUri={parenchymaMaskUri}
            segmentations={results?.segmentations}
            lesions={results?.lesions}
            lesionCount={lesionCount}
            flrDefault={results?.flr_default}
            markers={markers}
            activeTool={isReadOnly ? null : activeTool}
          />
          {devMockMask && (
            <Box
              aria-hidden
              data-testid="refinement-view-synthetic-overlay"
              data-flash-active={overlayFlash ? 'true' : 'false'}
              className={refinementStyles.syntheticOverlay}
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                background: 'var(--emr-secondary-alpha-20)',
                opacity: overlayFlash ? 1 : 0,
                transition: 'opacity 0.2s ease',
              }}
            />
          )}
          {/* Phase G5: inline label/note popover anchored to the click
              position. Closes on Save, Skip, Esc, click-outside, 8s timeout. */}
          {pendingMarker && seat.reviewId && analysisId && (
            <MarkerLabelPopover
              markerId={pendingMarker.markerId}
              analysisId={analysisId}
              reviewId={seat.reviewId}
              apiBaseUrl={baseUrl}
              anchorX={pendingMarker.anchorX}
              anchorY={pendingMarker.anchorY}
              onClose={() => setPendingMarker(null)}
            />
          )}
        </Box>
      </Box>

      {/* Always-mounted global helpers. */}
      <TakeoverRequestToast />
      <ConflictResolutionModal />
    </Stack>
  );
}

/** Public entry point. Wrapped in an error boundary per view-shell contract. */
export default function RefinementView(): ReactElement {
  return (
    <EMRErrorBoundary componentName="RefinementView">
      <RefinementViewInner />
    </EMRErrorBoundary>
  );
}
