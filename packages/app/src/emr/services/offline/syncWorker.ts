// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * syncWorker (T244).
 *
 * Plain-English analogy:
 *   The outbox (`offlineQueue`) collects unsent letters. This worker
 *   is the mail truck — it drives by the outbox every 15 seconds while
 *   the network is up, and also runs an immediate route the moment
 *   the browser tells us connectivity is back.
 *
 *   On 409 (someone else changed the same row), we stop that specific
 *   letter and ask the user via `conflictResolver.resolve()` how to
 *   proceed. On 5xx, we bump `attempt_count`, apply exponential backoff
 *   via `client_version`, and leave the letter in the outbox.
 *
 * Spec refs: FR-018c, plan §Offline reviewer-edit durability.
 */

import { offlineQueue, MAX_ATTEMPTS, type OfflineEdit } from './offlineQueue';
import { resolve as resolveConflict } from './conflictResolver';
import { SYNC_WORKER_EVENT } from '../../contexts/SyncContext';

const POLL_INTERVAL_MS = 15_000;

function apiBaseUrl(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

function endpointFor(edit: OfflineEdit): string {
  if (edit.endpoint) return edit.endpoint;
  const review = (edit.payload as { review_id?: string }).review_id ?? '';
  switch (edit.edit_type) {
    case 'mask_refine':
      return `/reviews/${review}/mask-refine`;
    case 'lesion_prompt':
      return `/reviews/${review}/lesion-prompt`;
    case 'classification_override':
      return `/reviews/${review}/classification-override`;
    case 'flr':
      return `/reviews/${review}/flr`;
    case 'marker':
      return `/reviews/${review}/marker`;
    default:
      return `/reviews/${review}`;
  }
}

function emitTick(status: 'online' | 'offline' | 'syncing'): void {
  try {
    window.dispatchEvent(
      new CustomEvent(SYNC_WORKER_EVENT, {
        detail: { status, at: new Date().toISOString() },
      }),
    );
  } catch {
    /* SSR / test harness without CustomEvent */
  }
}

/** Post one edit, dequeue on success, record the error on failure. */
async function postOne(edit: OfflineEdit): Promise<'ok' | 'conflict' | 'retry'> {
  const url = `${apiBaseUrl()}${endpointFor(edit)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-LiverRa-Client-Version': String(edit.payload.client_version ?? 1),
      },
      body: JSON.stringify(edit.payload),
    });
  } catch (networkErr) {
    await offlineQueue.incrementAttempt(edit.id, String(networkErr));
    return 'retry';
  }

  if (res.ok) {
    await offlineQueue.dequeue(edit.id);
    return 'ok';
  }

  // 404 means the analysis, review, or segmentation the edit targets has
  // been deleted or doesn't exist in this tenant. Retrying will never
  // succeed, so we mark the edit permanently failed and let the
  // FailedEditsAlert UI prompt the user to discard or retry. Without
  // this short-circuit the edit would 404-loop until MAX_ATTEMPTS, then
  // sit in IndexedDB invisible to the user — exactly the case that
  // triggered Phase H.
  if (res.status === 404) {
    await offlineQueue.markFailed(
      edit.id,
      '404 — referenced resource no longer exists',
    );
    return 'retry';
  }

  if (res.status === 409) {
    // Server-wins default unless the UI says otherwise.
    let server: Record<string, unknown> = {};
    try {
      server = (await res.json()) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const decision = await resolveConflict({
      analysisId: edit.analysis_id,
      clientVersion: Number(edit.payload.client_version ?? 1),
      serverVersion: Number((server as { server_version?: number }).server_version ?? 0),
      clientPayload: edit.payload,
      serverPayload: server,
    });
    if (decision === 'server_wins') {
      // Drop the local edit; server state wins.
      await offlineQueue.dequeue(edit.id);
      return 'conflict';
    }
    if (decision === 'client_wins') {
      // Re-POST with bumped version hint so the server accepts it.
      const bumpedBody = {
        ...(edit.payload as Record<string, unknown>),
        client_version:
          Number(
            (server as { server_version?: number }).server_version ?? 0,
          ) + 1,
        force: true,
      };
      try {
        const res2 = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bumpedBody),
        });
        if (res2.ok) {
          await offlineQueue.dequeue(edit.id);
          return 'ok';
        }
      } catch {
        /* fall through to retry */
      }
    }
    // Manual — keep the row; UI will guide user through diff view.
    await offlineQueue.incrementAttempt(edit.id, '409 manual-merge pending');
    return 'retry';
  }

  await offlineQueue.incrementAttempt(edit.id, `HTTP ${res.status}`);
  return 'retry';
}

/** Flush every pending edit exactly once, oldest-first. */
export async function flush(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    emitTick('offline');
    return;
  }
  const pending = await offlineQueue.listPending();
  if (pending.length === 0) {
    emitTick('online');
    return;
  }
  emitTick('syncing');
  for (const edit of pending) {
    if (edit.attempt_count >= MAX_ATTEMPTS) continue;
    await postOne(edit);
  }
  emitTick(navigator.onLine ? 'online' : 'offline');
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let started = false;

/**
 * Boot the background sync. Idempotent — calling twice is a no-op.
 * Returns a stop function for test teardown.
 */
export function startSyncWorker(): () => void {
  if (started) return stopSyncWorker;
  started = true;

  const onOnline = (): void => {
    void flush();
  };
  const onNudge = (): void => {
    void flush();
  };

  window.addEventListener('online', onOnline);
  window.addEventListener(`${SYNC_WORKER_EVENT}:nudge`, onNudge);

  intervalId = setInterval(() => {
    void flush();
  }, POLL_INTERVAL_MS);

  // Kick once at startup.
  void flush();

  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener(`${SYNC_WORKER_EVENT}:nudge`, onNudge);
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    started = false;
  };
}

export function stopSyncWorker(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  started = false;
}

export default { startSyncWorker, stopSyncWorker, flush };
