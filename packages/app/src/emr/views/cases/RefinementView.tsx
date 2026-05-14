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
import { RefineTools, type RefineToolId } from '../../components/liver/RefineTools';
import { ReviewTools } from '../../components/liver/ReviewTools';
import { TakeoverRequestToast } from '../../components/liver/TakeoverRequestToast';
import { ConflictResolutionModal } from '../../components/offline/ConflictResolutionModal';
import { useTranslation } from '../../contexts/TranslationContext';
import { useRefinementUndo } from '../../contexts/RefinementUndoContext';
import { useAnalysis } from '../../hooks/useAnalysis';
import {
  useRefinementDispatch,
  type DispatchMaskRefineInput,
} from '../../hooks/useRefinementDispatch';
import { useReviewSeat } from '../../hooks/useReviewSeat';
import { useSync } from '../../contexts/SyncContext';
import { useAuth } from '../../services/auth';

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
  const { analysis } = useAnalysis(analysisId);

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

  const hasPermission = auth.permissions.includes(REQUIRED_PERMISSION);
  const isReadOnly = !seat.hasSeat || !hasPermission;

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

  // Exposed on window for the LiverViewer3D sibling to hook into without
  // refactoring its Cornerstone event plumbing. Parent owns *when* a click
  // becomes a dispatch; viewer stays presentational.
  //
  // H-REFINE-3: every dispatch carries an ``inverse`` so the undo stack
  // gets a poppable entry. The inverse of an ``add`` at voxel V is a
  // ``subtract`` at the same voxel; vice versa. ``point`` clicks (used
  // to seed lesion prompts, not directly mutate masks) are mapped to
  // an inverse ``subtract`` placeholder — the undo will surface an
  // empty/no-op delta the viewer can ignore.
  useEffect(() => {
    if (!analysisId) return undefined;
    const onViewerClick = (ev: Event): void => {
      const detail = (
        ev as CustomEvent<{
          voxel: [number, number, number];
          clickType?: 'add' | 'subtract' | 'point';
          segmentationId?: string;
        }>
      ).detail;
      if (!detail || !detail.voxel) return;
      const clickType =
        detail.clickType ?? (activeTool === 'subtract' ? 'subtract' : 'add');
      const inverseClickType: 'add' | 'subtract' | 'point' =
        clickType === 'add'
          ? 'subtract'
          : clickType === 'subtract'
            ? 'add'
            : 'point';
      void runMaskDispatch({
        analysisId,
        segmentationId: detail.segmentationId ?? 'parenchyma',
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
  }, [analysisId, activeTool, runMaskDispatch]);

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

  const seatPillColor = seat.hasSeat
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
                {seat.hasSeat
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

      {seat.status === 'lost' && (
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
              showLesions
            />
          </Box>

          <CouinaudLegend />

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
