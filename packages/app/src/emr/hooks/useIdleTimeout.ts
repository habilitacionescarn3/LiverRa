/**
 * Idle-timeout hook (T407).
 *
 * Plain-English:
 *   NFR-006 says "if the user doesn't touch the app for 15 minutes,
 *   log them out." This hook watches mouse/keyboard/touch/focus
 *   events and starts a timer. If no event fires for the timeout
 *   window, it dispatches `liverra:session-timeout`, wipes the
 *   in-memory tokens, and redirects to `/signin?returnTo=<path>`.
 *
 *   A `BroadcastChannel('liverra-idle')` syncs activity across
 *   tabs — clicking in one tab resets the idle timer in every
 *   other open tab too.
 *
 * Contract:
 *   - Mount ONCE in `EMRPage.tsx` (the authenticated layout shell).
 *   - Do NOT mount on the `/signin` route.
 *
 * References:
 *   - spec.md §NFR-006 (15-min inactivity timeout)
 *   - plan.md §Error Handling — session timeout
 */
import { useCallback, useEffect, useRef } from 'react';

/** Default timeout in ms — NFR-006 hard limit. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Events that count as "user activity". */
const ACTIVITY_EVENTS: ReadonlyArray<keyof WindowEventMap> = [
  'mousemove',
  'mousedown',
  'keydown',
  'touchstart',
  'focus',
  'scroll',
] as const;

const BROADCAST_CHANNEL_NAME = 'liverra-idle';
const SESSION_TIMEOUT_EVENT = 'liverra:session-timeout';

export interface UseIdleTimeoutOptions {
  /** Timeout in ms. Defaults to 15 min (NFR-006). */
  timeoutMs?: number;
  /** Called when idle threshold is hit — receives the returnTo path. */
  onTimeout?: (returnTo: string) => void;
  /** Token-clearing hook. Defaults to no-op; real auth service is wired in T046. */
  clearTokens?: () => void;
  /** Disable for routes that shouldn't trigger (e.g. `/signin`). */
  enabled?: boolean;
}

export interface UseIdleTimeoutResult {
  /** Manually reset the idle timer (call from long-running operations). */
  resetIdle: () => void;
}

/**
 * Subscribe to user activity + auto-logout after `timeoutMs`.
 *
 * The hook is idempotent across renders — listeners are re-attached
 * only when `timeoutMs` or `enabled` changes.
 */
export function useIdleTimeout(options: UseIdleTimeoutOptions = {}): UseIdleTimeoutResult {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, onTimeout, clearTokens, enabled = true } = options;

  const timerRef = useRef<number | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const fireTimeout = useCallback(() => {
    const returnTo = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';

    // 1) Wipe in-memory tokens (no-op until T046 wires AuthService).
    try {
      clearTokens?.();
    } catch {
      /* swallow */
    }

    // 2) Pub/sub — SessionTimeoutModal subscribes (T088).
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent(SESSION_TIMEOUT_EVENT, { detail: { returnTo } }));
      } catch {
        /* swallow */
      }
    }

    // 3) Caller-supplied redirect or default navigation.
    if (onTimeout) {
      try {
        onTimeout(returnTo);
      } catch {
        /* swallow */
      }
    } else if (typeof window !== 'undefined') {
      try {
        window.location.assign(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
      } catch {
        /* swallow */
      }
    }
  }, [clearTokens, onTimeout]);

  const resetTimer = useCallback(() => {
    if (!enabled) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(fireTimeout, timeoutMs);
  }, [enabled, fireTimeout, timeoutMs]);

  const resetIdle = useCallback(() => {
    resetTimer();
    // Broadcast to peer tabs so they reset too.
    try {
      channelRef.current?.postMessage({ type: 'activity', ts: Date.now() });
    } catch {
      /* swallow */
    }
  }, [resetTimer]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    // Cross-tab sync.
    try {
      channelRef.current = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      channelRef.current.addEventListener('message', (event) => {
        const data = event.data as { type?: string } | undefined;
        if (data?.type === 'activity') {
          resetTimer();
        }
      });
    } catch {
      channelRef.current = null; // not all browsers (e.g. jsdom) expose it
    }

    // Local listeners.
    const handler = () => resetIdle();
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, handler, { passive: true });
    }

    // Kick off.
    resetTimer();

    return () => {
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, handler);
      }
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      try {
        channelRef.current?.close();
      } catch {
        /* swallow */
      }
      channelRef.current = null;
    };
  }, [enabled, resetIdle, resetTimer]);

  return { resetIdle };
}

export default useIdleTimeout;
