// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
//
// ── Stack background-warm utility ────────────────────────────────────────────
//
// When the operator opens a non-primary series into a 1×N STACK viewport, only
// the landing slice is decoded immediately; every other slice is fetched lazily
// on scroll, so the first pass through the stack is chunky until Cornerstone's
// image cache fills. The primary series gets a background warm on study-open —
// this gives a clicked series the same head-start.
//
// HOW (and why it's safe): every PACS imageId is a per-frame WADO-RS URL
// (`wadors:.../instances/<sop>/frames/<n>`, see DicomWebClient.getInstanceUrl).
// The HTTP-cache progressive warmer deliberately SKIPS `/frames/` URLs (wrong
// Accept header → Orthanc 400), so the effective warm path is Cornerstone's own
// loader. We submit each frame to the shared `imageLoadPoolManager` as a
// RequestType.Prefetch request that calls `imageLoader.loadAndCacheImage`:
//   • The pool is capped at 12 concurrent Prefetch requests (cornerstoneInit.ts)
//     to match the PACS nginx rate-limit budget, so a whole 320-slice series
//     drains gently over a few seconds WITHOUT the request burst that makes the
//     edge return HTTP 503. The cap + grabDelay ARE the "gentleness".
//   • `loadAndCacheImage` dedups in-flight + already-cached imageIds, so the
//     visible slice (already decoded by setStack) is never re-fetched and a
//     re-warm of the same series is a cheap no-op.
//   • It warms the SAME image cache that stack-scroll reads, so scrubbing to a
//     warmed slice renders instantly instead of triggering a cold fetch.
//
// Best-effort: every operation is guarded. A failure here never blocks viewing —
// the slices still load lazily on scroll, just without the head-start.

import { imageLoader, imageLoadPoolManager, Enums as csEnums } from '@cornerstonejs/core';

export interface StackWarmArgs {
  /** Sorted imageIds of the series now displayed in the stack viewport. */
  imageIds: string[];
  /** The slice index already on screen (decoded by setStack) — skipped. Default 0. */
  currentIndex?: number;
}

export interface StackWarmHandle {
  submitted: number;
  cancel: () => void;
}

const STACK_WARM_MAX_IMAGES = 96;
let activeStackWarmCancel: (() => void) | undefined;

function emptyStackWarmHandle(): StackWarmHandle {
  return { submitted: 0, cancel: () => undefined };
}

/**
 * Background-warm a bounded neighborhood of a stack series through Cornerstone's throttled
 * image-load pool, ordered outward from the current slice so the nearest scroll
 * targets warm first. Best-effort, never throws.
 *
 * @param args - The displayed imageIds + the on-screen slice index.
 * @returns A cleanup handle for queued-but-not-started requests.
 */
export function warmStackInBackground(args: StackWarmArgs): StackWarmHandle {
  try {
    const { imageIds } = args;
    const total = imageIds.length;
    if (total <= 1) {
      return emptyStackWarmHandle();
    }
    const prefetchType = csEnums?.RequestType?.Prefetch;
    if (
      !imageLoadPoolManager ||
      typeof imageLoadPoolManager.addRequest !== 'function' ||
      !imageLoader ||
      typeof imageLoader.loadAndCacheImage !== 'function' ||
      prefetchType === undefined
    ) {
      return emptyStackWarmHandle();
    }

    const current = Math.max(0, Math.min(total - 1, Math.floor(args.currentIndex ?? 0)));
    const firstImageId = imageIds[0] ?? '';
    const identityMatch = firstImageId.match(/\/studies\/([^/]+)\/series\/([^/]+)/);
    const studyInstanceUid = identityMatch?.[1] ? decodeURIComponent(identityMatch[1]) : undefined;
    const seriesInstanceUid = identityMatch?.[2] ? decodeURIComponent(identityMatch[2]) : undefined;
    const stackWarmToken = `${studyInstanceUid ?? 'unknown-study'}:${seriesInstanceUid ?? 'unknown-series'}:${Date.now()}:${Math.random()}`;
    let cancelled = false;
    const cancel = (): void => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      if (typeof imageLoadPoolManager.filterRequests === 'function') {
        imageLoadPoolManager.filterRequests((requestDetails) => {
          const details = requestDetails.additionalDetails as Record<string, unknown>;
          return details.stackWarmToken !== stackWarmToken;
        });
      }
      if (activeStackWarmCancel === cancel) {
        activeStackWarmCancel = undefined;
      }
    };
    activeStackWarmCancel?.();
    activeStackWarmCancel = cancel;

    // Outward-from-current order: current+1, current-1, current+2, current-2, …
    // so the slices the operator is most likely to scroll to next warm first.
    const order: number[] = [];
    for (let d = 1; d < total && order.length < STACK_WARM_MAX_IMAGES; d++) {
      const up = current + d;
      const down = current - d;
      if (up < total) {
        order.push(up);
      }
      if (down >= 0 && order.length < STACK_WARM_MAX_IMAGES) {
        order.push(down);
      }
    }

    let submitted = 0;
    for (const idx of order) {
      const imageId = imageIds[idx];
      imageLoadPoolManager.addRequest(
        () => cancelled ? Promise.resolve() : imageLoader.loadAndCacheImage(imageId).then(() => undefined).catch(() => undefined),
        prefetchType as Parameters<typeof imageLoadPoolManager.addRequest>[1],
        { imageId, stackWarmToken, studyInstanceUid, seriesInstanceUid },
        // Higher priority number = lower precedence (the pool serves ascending),
        // so this never preempts the visible slice or an active scroll — it just
        // fills in behind interaction requests.
        10,
      );
      submitted += 1;
    }
    return { submitted, cancel };
  } catch (err) {
    console.warn('[stackPrefetchWarm] skipped (non-fatal)', err);
    return emptyStackWarmHandle();
  }
}
