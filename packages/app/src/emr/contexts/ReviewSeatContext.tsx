// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ReviewSeatContext (T239 + T424).
 *
 * Plain-English analogy:
 *   Think of an analysis as a single rental room with one key. When a
 *   reviewer enters, this provider picks up the key (`acquire`), rings
 *   a bell every 20 seconds so the landlord knows they're still there
 *   (`heartbeat`), and drops the key at the front desk when they leave
 *   (`release`). If the reviewer closes the tab unexpectedly, a
 *   `sendBeacon` fires a best-effort release so the room isn't stuck.
 *   If the bell rings twice without a reply, we show a "reconnecting"
 *   banner and retry; three in a row escalates to seat-lost.
 *
 * Spec refs: FR-017a (reviewer seat + heartbeat policy), plan §Review
 * seat concurrency, research §C.6.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  handleApiError,
  LiverraApiError,
  LIVERRA_ERROR_EVENTS,
} from '../services/errorClient';

function apiBaseUrl(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

/** Minimal JSON POST wrapper used by the seat lifecycle calls. */
export interface SeatHttpClient {
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

const defaultHttpClient: SeatHttpClient = {
  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${apiBaseUrl()}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      // Delegate problem+json → UX mapping to errorClient.
      throw res;
    }
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  },
};

/** Heartbeat cadence — seat TTL is 60 s, we tick at 20 s (3× margin). */
const HEARTBEAT_INTERVAL_MS = 20_000;
/** Degraded-state threshold per T424 (2 missed heartbeats). */
const DEGRADED_AFTER_MISSES = 2;
/** Hard-fail threshold — seat considered lost. */
const LOST_AFTER_MISSES = 3;

export type SeatStatus = 'idle' | 'acquiring' | 'held' | 'degraded' | 'lost';

export interface ReviewSeatState {
  status: SeatStatus;
  reviewId: string | null;
  analysisId: string | null;
  seatHeldUntil: string | null;
  /** True while acquire/heartbeat requests are in flight. */
  isLoading: boolean;
  /** Set when another user holds the seat. */
  holderDisplayName: string | null;
  /** True once the user is actively editing (status === 'held'). */
  hasSeat: boolean;
}

export interface ReviewSeatActions {
  acquire(analysisId: string): Promise<void>;
  release(): Promise<void>;
  requestTakeover(analysisId: string): Promise<void>;
}

export type ReviewSeatContextValue = ReviewSeatState & ReviewSeatActions;

const INITIAL_STATE: ReviewSeatState = {
  status: 'idle',
  reviewId: null,
  analysisId: null,
  seatHeldUntil: null,
  isLoading: false,
  holderDisplayName: null,
  hasSeat: false,
};

const Context = createContext<ReviewSeatContextValue | null>(null);

export interface ReviewSeatProviderProps {
  children: ReactNode;
  /** Override for tests — bypasses the real fetch-backed HTTP client. */
  httpClient?: SeatHttpClient;
  /** Override for tests — bypasses navigator.sendBeacon. */
  beaconOverride?: (url: string, data?: BodyInit) => boolean;
}

export function ReviewSeatProvider({
  children,
  httpClient,
  beaconOverride,
}: ReviewSeatProviderProps): JSX.Element {
  const client = httpClient ?? defaultHttpClient;
  const [state, setState] = useState<ReviewSeatState>(INITIAL_STATE);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const missedRef = useRef<number>(0);
  // We keep reviewId in a ref so beforeunload handlers can read the
  // latest value without re-registering on every state change.
  const reviewIdRef = useRef<string | null>(null);

  const clearHeartbeat = useCallback((): void => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    missedRef.current = 0;
  }, []);

  const acquire = useCallback(
    async (analysisId: string): Promise<void> => {
      setState((prev) => ({ ...prev, status: 'acquiring', isLoading: true }));
      try {
        const response = await client.post<{
          review_id: string;
          analysis_id: string;
          seat_held_until: string;
        }>('/api/v1/reviews', { analysis_id: analysisId });

        reviewIdRef.current = response.review_id;
        setState({
          status: 'held',
          reviewId: response.review_id,
          analysisId: response.analysis_id,
          seatHeldUntil: response.seat_held_until,
          isLoading: false,
          holderDisplayName: null,
          hasSeat: true,
        });
      } catch (err) {
        let apiErr: unknown = err;
        try {
          // handleApiError always throws; rethrows as LiverraApiError.
          await handleApiError(err as Response);
        } catch (mapped) {
          apiErr = mapped;
        }
        if (
          apiErr instanceof LiverraApiError &&
          apiErr.slug === 'seat-taken'
        ) {
          setState({
            ...INITIAL_STATE,
            status: 'idle',
            analysisId,
            holderDisplayName:
              (apiErr.problem as { holder_display_name?: string })
                .holder_display_name ?? null,
          });
        } else {
          setState({ ...INITIAL_STATE, status: 'idle' });
        }
        throw apiErr;
      }
    },
    [client],
  );

  const release = useCallback(async (): Promise<void> => {
    const rid = reviewIdRef.current;
    clearHeartbeat();
    reviewIdRef.current = null;
    setState(INITIAL_STATE);
    if (rid) {
      try {
        await client.post(`/api/v1/reviews/${rid}/release`, {});
      } catch {
        // Release is best-effort — the seat TTL will reap it anyway.
      }
    }
  }, [client, clearHeartbeat]);

  const requestTakeover = useCallback(
    async (analysisId: string): Promise<void> => {
      await client.post('/api/v1/reviews/takeover-request', {
        analysis_id: analysisId,
      });
    },
    [client],
  );

  // --- Heartbeat loop -----------------------------------------------------

  useEffect(() => {
    if (state.status !== 'held' && state.status !== 'degraded') {
      return;
    }
    intervalRef.current = setInterval(async () => {
      const rid = reviewIdRef.current;
      if (!rid) return;
      try {
        const res = await client.post<{ seat_held_until: string }>(
          `/api/v1/reviews/${rid}/heartbeat`,
          {},
        );
        missedRef.current = 0;
        setState((prev) =>
          prev.status === 'lost'
            ? prev
            : {
                ...prev,
                status: 'held',
                seatHeldUntil: res.seat_held_until,
                hasSeat: true,
              },
        );
      } catch {
        missedRef.current += 1;
        if (missedRef.current >= LOST_AFTER_MISSES) {
          clearHeartbeat();
          setState((prev) => ({
            ...prev,
            status: 'lost',
            hasSeat: false,
          }));
          try {
            window.dispatchEvent(
              new CustomEvent(LIVERRA_ERROR_EVENTS.GenericToast, {
                detail: { slug: 'seat-taken', retryable: false },
              }),
            );
          } catch {
            /* ignore */
          }
        } else if (missedRef.current >= DEGRADED_AFTER_MISSES) {
          setState((prev) => ({
            ...prev,
            status: 'degraded',
            hasSeat: true,
          }));
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      clearHeartbeat();
    };
  }, [client, clearHeartbeat, state.status]);

  // --- Release on unmount / tab-close (T424) ------------------------------

  useEffect(() => {
    const beacon = beaconOverride ?? navigator.sendBeacon?.bind(navigator);

    const fireBeacon = (): void => {
      const rid = reviewIdRef.current;
      if (!rid || !beacon) return;
      try {
        beacon(`/api/v1/reviews/${rid}/release`);
      } catch {
        /* ignore */
      }
    };

    const onBeforeUnload = (): void => fireBeacon();
    const onPageHide = (): void => fireBeacon();

    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      // Final release on provider unmount.
      fireBeacon();
    };
  }, [beaconOverride]);

  const value = useMemo<ReviewSeatContextValue>(
    () => ({
      ...state,
      acquire,
      release,
      requestTakeover,
    }),
    [state, acquire, release, requestTakeover],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useReviewSeatContext(): ReviewSeatContextValue {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error(
      'useReviewSeatContext must be used inside <ReviewSeatProvider>',
    );
  }
  return ctx;
}

export default ReviewSeatProvider;
