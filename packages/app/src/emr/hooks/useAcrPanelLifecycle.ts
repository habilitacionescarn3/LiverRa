// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useAcrPanelLifecycle — encapsulates the "panel was opened" side effects
 * for the ACR Structured Readout (M-ACR-5).
 *
 * Plain-English: the readout panel needs to do three things when it
 * appears on screen:
 *
 *   1. Drain any audit events that were queued offline in a previous
 *      session (FR-035).
 *   2. Fire the `acr_readout_viewed` telemetry exactly once per
 *      (analysisId × successful-load).
 *   3. Show a one-time tooltip pointing at the "Copy to clipboard"
 *      button (FR-027), keyed by user id in `localStorage`.
 *
 * Previously these three concerns lived as separate `useEffect` /
 * `useState` blocks inside `ACRStructuredReadout`, contributing 6 hooks
 * to a "god component" 16-hook count. Pulling them out:
 *
 *   - keeps the render component focused on layout + composition
 *   - makes the lifecycle individually testable (mount once, hook tests
 *     in isolation)
 *   - lets the render component drop unused imports (`useState`,
 *     `useRef`, etc.) when its own state surface shrinks further
 *
 * The hook is intentionally "fire-and-forget" — it returns the minimal
 * tooltip control surface the popover needs and nothing else.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { drainPendingAuditQueue } from '../services/report/acrClipboardService';
import {
  trackCopyTooltipDismissed,
  trackCopyTooltipSeen,
  trackReadoutViewed,
} from '../services/report/acrTelemetry';
import type { ReadoutSnapshot } from '../services/report/acrAnatomicalMapping';

const TOOLTIP_KEY_PREFIX = 'liverra.acr.copy-tooltip.seen:';

export interface UseAcrPanelLifecycleArgs {
  analysisId: string;
  /** Auth user id (when available) — keys the per-user tooltip. */
  userId: string | undefined;
  /** Built readout snapshot — gates "ready to show tooltip" + telemetry. */
  snapshot: ReadoutSnapshot | undefined;
  /** Raw report-summary payload — provides `status` + lesion count for telemetry. */
  reportData: { status?: string; lesions?: unknown[] } | undefined;
  /** Resolved active locale — falls back to snapshot.locale or 'en'. */
  locale: string | undefined;
}

export interface UseAcrPanelLifecycleResult {
  /** Whether the first-time tooltip is currently open. */
  tooltipOpen: boolean;
  /** Controlled open setter (the Popover needs `onChange`). */
  setTooltipOpen: (open: boolean) => void;
  /** Persist "user has seen tooltip" + emit telemetry + close. */
  dismissTooltip: () => void;
}

/**
 * Compose the three panel-open side effects. Safe to call once per
 * `<ACRStructuredReadout>` instance.
 */
export function useAcrPanelLifecycle({
  analysisId,
  userId,
  snapshot,
  reportData,
  locale,
}: UseAcrPanelLifecycleArgs): UseAcrPanelLifecycleResult {
  // 1. Best-effort drain of audit events queued in a previous session.
  useEffect(() => {
    void drainPendingAuditQueue();
  }, []);

  // 2. Fire `acr_readout_viewed` exactly once per (analysisId × successful-load).
  const viewedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!reportData || viewedRef.current === analysisId) return;
    viewedRef.current = analysisId;
    trackReadoutViewed({
      analysisId,
      locale: (snapshot?.locale ?? locale ?? 'en') as 'en' | 'ru' | 'ka' | 'de',
      status: reportData.status ?? 'unknown',
      lesionCount: reportData.lesions?.length ?? 0,
    });
  }, [reportData, analysisId, snapshot, locale]);

  // 3. First-time tooltip — keyed by user id so each clinician sees it once.
  const tooltipStorageKey = userId ? `${TOOLTIP_KEY_PREFIX}${userId}` : null;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  useEffect(() => {
    if (!snapshot || !tooltipStorageKey) return;
    try {
      if (localStorage.getItem(tooltipStorageKey) !== '1') {
        setTooltipOpen(true);
        trackCopyTooltipSeen(analysisId);
      }
    } catch {
      // localStorage unavailable — never show the tooltip rather than crash.
    }
  }, [snapshot, tooltipStorageKey, analysisId]);

  const dismissTooltip = useCallback((): void => {
    if (tooltipStorageKey) {
      try {
        localStorage.setItem(tooltipStorageKey, '1');
      } catch {
        // ignore
      }
    }
    setTooltipOpen(false);
    trackCopyTooltipDismissed(analysisId);
  }, [tooltipStorageKey, analysisId]);

  return { tooltipOpen, setTooltipOpen, dismissTooltip };
}
