// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useReviewSeat (T241 + T423).
 *
 * Plain-English: the hook every refinement UI calls. It forwards the
 * `ReviewSeatContext` state + actions AND plugs into the SSE takeover
 * channel so when another reviewer requests the seat, we raise a
 * DOM event that `TakeoverRequestToast` listens for.
 *
 * Spec refs: FR-017a, plan §Review seat concurrency.
 */

import { useCallback, useEffect } from 'react';

import {
  useReviewSeatContext,
  type ReviewSeatContextValue,
} from '../contexts/ReviewSeatContext';

export const TAKEOVER_REQUESTED_EVENT = 'liverra:takeover-requested';

export interface TakeoverRequestedDetail {
  analysisId: string;
  requesterUserId: string;
  requestedAt: string;
}

function apiBaseUrl(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export interface UseReviewSeatResult extends ReviewSeatContextValue {
  /** Imperatively ask the backend to transfer the seat to this user. */
  requestTransfer(analysisId: string): Promise<void>;
}

export function useReviewSeat(analysisId?: string): UseReviewSeatResult {
  const ctx = useReviewSeatContext();

  const requestTransfer = useCallback(
    async (id: string): Promise<void> => {
      await ctx.requestTakeover(id);
    },
    [ctx],
  );

  // Subscribe to the takeover SSE channel for `analysisId`. When the
  // backend publishes a `takeover-requested` event, we translate it
  // into a DOM CustomEvent the toast component listens for.
  //
  // H-REFINE-2:
  //   - Exponential backoff on reconnect (1s → 30s ceiling).
  //   - Heartbeat-loss detection: if no event observed for >45s
  //     (server emits a ``: ping`` every 25s), the connection is
  //     treated as broken and we close + reconnect under backoff.
  useEffect(() => {
    if (!analysisId) return undefined;
    if (typeof EventSource === 'undefined') return undefined;

    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1_000;
    const MAX_BACKOFF_MS = 30_000;
    const HEARTBEAT_LOSS_MS = 45_000;
    let cancelled = false;

    const forward = (ev: MessageEvent): void => {
      // Any message — even an unparseable one — counts as proof that
      // the connection is still alive; reset the heartbeat-loss timer.
      resetHeartbeatLossTimer();
      try {
        const payload = JSON.parse(ev.data) as {
          requester_user_id?: string;
          requested_at?: string;
        };
        const detail: TakeoverRequestedDetail = {
          analysisId,
          requesterUserId: payload.requester_user_id ?? 'unknown',
          requestedAt: payload.requested_at ?? new Date().toISOString(),
        };
        window.dispatchEvent(
          new CustomEvent<TakeoverRequestedDetail>(
            TAKEOVER_REQUESTED_EVENT,
            { detail },
          ),
        );
      } catch {
        /* malformed event — ignore */
      }
    };

    const resetHeartbeatLossTimer = (): void => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        // Heartbeat lost — server should have pinged by now.
        // Close + reconnect under the backoff curve.
        if (source) {
          source.close();
          source = null;
        }
        scheduleReconnect();
      }, HEARTBEAT_LOSS_MS);
    };

    const scheduleReconnect = (): void => {
      if (cancelled) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        connect();
      }, backoffMs);
    };

    const connect = (): void => {
      if (cancelled) return;
      const url = `${apiBaseUrl()}/reviews/${encodeURIComponent(
        analysisId,
      )}/takeover-events`;
      source = new EventSource(url, { withCredentials: true });
      // On a successful open the connection is healthy — reset the
      // backoff so the NEXT failure starts at 1s again.
      source.addEventListener('open', () => {
        backoffMs = 1_000;
        resetHeartbeatLossTimer();
      });
      source.addEventListener('takeover-requested', forward as EventListener);
      source.addEventListener('message', forward as EventListener);
      source.addEventListener('error', () => {
        // EventSource auto-reconnects on its own, but only with a fixed
        // 3s delay regardless of network state. We explicitly close
        // here so we can drive backoff ourselves.
        if (source) {
          source.close();
          source = null;
        }
        scheduleReconnect();
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (source) {
        source.removeEventListener(
          'takeover-requested',
          forward as EventListener,
        );
        source.removeEventListener('message', forward as EventListener);
        source.close();
        source = null;
      }
    };
  }, [analysisId]);

  return {
    ...ctx,
    requestTransfer,
  };
}

export default useReviewSeat;
