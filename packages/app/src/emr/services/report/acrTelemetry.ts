// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrTelemetry — thin product-analytics helpers for the ACR readout panel.
 *
 * Contract: contracts/readout-api.md §5. Forbidden properties: actor
 * identity, patient identifiers, copied content. `analysisId` is a
 * UUID and is permitted (no PHI on its own).
 *
 * All event names live in `services/telemetry/events.ts` and the
 * capture call is a no-op when PostHog hasn't initialised — fail-safe
 * (no telemetry must never break the workflow).
 */

import { capture } from '../telemetry/postHogClient';

export type LesionCountBucket = '0' | '1' | '2-5' | '6-10' | '11-20' | '21-50' | '50+';

export function bucketLesionCount(n: number): LesionCountBucket {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 10) return '6-10';
  if (n <= 20) return '11-20';
  if (n <= 50) return '21-50';
  return '50+';
}

export interface AcrViewedProps {
  analysisId: string;
  locale: string;
  status: string;
  lesionCount: number;
}

export interface AcrCopySucceededProps {
  analysisId: string;
  locale: string;
  lesionCount: number;
  durationMs: number;
  pendingQueueDepth: number;
}

export interface AcrCopyFailedProps {
  analysisId: string;
  locale: string;
  failureCategory: string;
  durationMs: number;
}

export interface AcrPdfSectionRenderedProps {
  analysisId: string;
  locale: string;
  lesionCount: number;
  durationMs: number;
}

function safeCapture(event: Parameters<typeof capture>[0], props: Record<string, unknown>): void {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as { posthog?: unknown }).posthog === undefined) {
      // PostHog not initialised — defensive no-op. capture() also handles this,
      // but we short-circuit to avoid surfacing dev-time warnings.
      return;
    }
    capture(event, props);
  } catch {
    // Telemetry must never break the workflow (FR-038 fail-safe).
  }
}

export function trackReadoutViewed(props: AcrViewedProps): void {
  safeCapture('acr_readout_viewed', {
    analysisId: props.analysisId,
    locale: props.locale,
    status: props.status,
    lesionCount: bucketLesionCount(props.lesionCount),
  });
}

export function trackCopySucceeded(props: AcrCopySucceededProps): void {
  safeCapture('acr_clipboard_copy_succeeded', {
    analysisId: props.analysisId,
    locale: props.locale,
    lesionCount: bucketLesionCount(props.lesionCount),
    durationMs: Math.round(props.durationMs),
    pendingQueueDepth: props.pendingQueueDepth,
  });
}

export function trackCopyFailed(props: AcrCopyFailedProps): void {
  safeCapture('acr_clipboard_copy_failed', {
    analysisId: props.analysisId,
    locale: props.locale,
    failureCategory: props.failureCategory,
    durationMs: Math.round(props.durationMs),
  });
}

export function trackPdfSectionRendered(props: AcrPdfSectionRenderedProps): void {
  safeCapture('acr_pdf_section_rendered', {
    analysisId: props.analysisId,
    locale: props.locale,
    lesionCount: bucketLesionCount(props.lesionCount),
    durationMs: Math.round(props.durationMs),
  });
}

export function trackCopyTooltipSeen(analysisId: string): void {
  safeCapture('acr_copy_tooltip_seen', { analysisId });
}

export function trackCopyTooltipDismissed(analysisId: string): void {
  safeCapture('acr_copy_tooltip_dismissed', { analysisId });
}
