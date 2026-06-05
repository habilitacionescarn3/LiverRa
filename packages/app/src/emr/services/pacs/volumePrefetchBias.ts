// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
//
// ── Volume prefetch priority-bias utility ────────────────────────────────────
//
// Cornerstone3D's streaming-image-volume loader submits every frame's HTTP
// request to `imageLoadPoolManager` at a flat priority (default 5) in
// imageId-array order. That means the operator's CURRENTLY-VISIBLE slice can
// wait behind hundreds of irrelevant ones on a large cardiac CT — and any
// fast scroll triggers the loader to cancel and re-prioritize the queue,
// flooding DevTools with `volume load cancelled, returning for imageIdIndex: …`
// warnings (which are correct cancellation signals, but pathologically loud
// when the queue order is wrong).
//
// This helper re-submits ONLY the frames in a window around the operator's
// landing slice into the SAME pool at a lower priority number (= higher
// precedence, since the pool sorts ASCENDING — see
// `node_modules/@cornerstonejs/core/dist/esm/requestPool/requestPoolManager.js:144-149`).
// `callLoadImage` early-returns for frames already FULL_RESOLUTION and
// `loadAndCacheImage` dedups in-flight ones, so this never double-fetches —
// it only lets cold priority frames jump the queue.
//
// Extracted verbatim from TAVI's `useStudyVolume.ts:343-407` ("C4 prefetch
// bias") so the simple PACS viewer can reuse the same optimization, and so
// the logic is unit-testable in isolation.
//
// CRITICAL safety: every operation is wrapped in try/catch. A failure here
// is non-fatal — the unbiased flat-priority load still completes in the
// background; the band just doesn't get the head-start.

import { imageLoadPoolManager } from '@cornerstonejs/core';

export interface PrefetchBiasArgs {
  /** The Cornerstone3D streaming volume returned by `volumeLoader.createAndCacheVolume`. */
  volume: unknown;
  /** Frame index the operator is most likely to land on first (0-based). */
  centerIndex: number;
  /** Half-window size in frames (the band is `[center-window, center+window]`). Default 24. */
  windowFrames?: number;
  /** Priority for the promoted frames. Lower = served first (default 0). */
  priority?: number;
}

export interface PrefetchBiasResult {
  /** Total number of pending frame requests reported by the volume. */
  total: number;
  /** How many were re-submitted at the higher priority. */
  promoted: number;
  /** Clamped `[lo, hi]` frame-index range that was actually promoted. */
  range: [number, number];
}

// Narrowed duck-type of the Cornerstone streaming-volume request API. We only
// touch `getImageLoadRequests(priority)` — the rest of the volume is opaque.
interface RequestVolume {
  getImageLoadRequests?: (priority: number) => {
    callLoadImage: (imageId: string, imageIdIndex: number, options: unknown) => Promise<void>;
    imageId: string;
    imageIdIndex: number;
    options: unknown;
    requestType: unknown;
    additionalDetails: { volumeId: string };
  }[];
}

/**
 * Re-submit the frames in a window around `centerIndex` to the cornerstone
 * `imageLoadPoolManager` at a higher priority, so the operator's visible
 * slice + nearby scrub range loads ahead of the rest of the volume.
 *
 * Best-effort, never throws. Returns counts for logging / tests.
 *
 * @param args - The volume, the landing-slice index, optional window + priority.
 * @returns The total request count, the promoted count, and the clamped band.
 */
export function applyVolumePrefetchBias(args: PrefetchBiasArgs): PrefetchBiasResult {
  const empty: PrefetchBiasResult = { total: 0, promoted: 0, range: [0, 0] };
  try {
    const reqVolume = args.volume as RequestVolume;
    if (!reqVolume || typeof reqVolume.getImageLoadRequests !== 'function') {
      return empty;
    }
    const allRequests = reqVolume.getImageLoadRequests(5) ?? [];
    const total = allRequests.length;
    if (total === 0) {
      return empty;
    }

    const windowFrames = Math.max(0, Math.floor(args.windowFrames ?? 24));
    const priority = args.priority ?? 0;
    const center = Math.max(0, Math.min(total - 1, Math.floor(args.centerIndex)));
    const lo = Math.max(0, center - windowFrames);
    const hi = Math.min(total - 1, center + windowFrames);

    let promoted = 0;
    for (const req of allRequests) {
      if (req.imageIdIndex < lo || req.imageIdIndex > hi) {
        continue;
      }
      imageLoadPoolManager.addRequest(
        () => req.callLoadImage(req.imageId, req.imageIdIndex, req.options),
        req.requestType as Parameters<typeof imageLoadPoolManager.addRequest>[1],
        req.additionalDetails,
        priority,
      );
      promoted += 1;
    }
    return { total, promoted, range: [lo, hi] };
  } catch (err) {
    // Best-effort optimization only — a failure here must never block the
    // volume from loading. The flat-priority stream still services every
    // frame; the band just won't get the head-start.

    console.warn('[volumePrefetchBias] skipped (non-fatal)', err);
    return empty;
  }
}
