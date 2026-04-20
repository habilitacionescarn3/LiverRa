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
  useEffect(() => {
    if (!analysisId) return undefined;
    if (typeof EventSource === 'undefined') return undefined;

    const url = `${apiBaseUrl()}/reviews/${encodeURIComponent(
      analysisId,
    )}/takeover-events`;
    const source = new EventSource(url, { withCredentials: true });

    const forward = (ev: MessageEvent): void => {
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

    source.addEventListener('takeover-requested', forward as EventListener);
    source.addEventListener('message', forward as EventListener);

    return () => {
      source.removeEventListener(
        'takeover-requested',
        forward as EventListener,
      );
      source.removeEventListener('message', forward as EventListener);
      source.close();
    };
  }, [analysisId]);

  return {
    ...ctx,
    requestTransfer,
  };
}

export default useReviewSeat;
