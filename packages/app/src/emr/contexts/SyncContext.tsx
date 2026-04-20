// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * SyncContext (T247).
 *
 * Plain-English: exposes two pieces of state every offline-aware piece
 * of the app needs — "are we online?" and "how many edits are still
 * stuck in the IndexedDB outbox?". Mirrors `navigator.onLine` and polls
 * `offlineQueue.count()` at a steady cadence; the `syncWorker` also
 * pokes us via CustomEvent so the badge updates the instant a flush
 * succeeds.
 *
 * Spec refs: FR-018c, plan §Offline reviewer-edit durability.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { offlineQueue } from '../services/offline/offlineQueue';

export type SyncStatus = 'online' | 'offline' | 'syncing';

export const SYNC_WORKER_EVENT = 'liverra:sync-worker-tick';

export interface SyncContextValue {
  status: SyncStatus;
  queueDepth: number;
  lastSyncAt: string | null;
  /** Flip this to force the worker to flush immediately. */
  nudge(): void;
}

const Context = createContext<SyncContextValue | null>(null);

const POLL_INTERVAL_MS = 5_000;

export function SyncProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<SyncStatus>(
    typeof navigator !== 'undefined' && navigator.onLine ? 'online' : 'offline',
  );
  const [queueDepth, setQueueDepth] = useState<number>(0);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const refreshDepth = useCallback(async (): Promise<void> => {
    try {
      const n = await offlineQueue.count();
      setQueueDepth(n);
    } catch {
      /* IndexedDB outage — keep previous value */
    }
  }, []);

  const nudge = useCallback((): void => {
    try {
      window.dispatchEvent(new CustomEvent(`${SYNC_WORKER_EVENT}:nudge`));
    } catch {
      /* ignore */
    }
  }, []);

  // Online / offline listeners.
  useEffect(() => {
    const onOnline = (): void => setStatus('online');
    const onOffline = (): void => setStatus('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Queue-depth polling + worker-tick listener.
  useEffect(() => {
    void refreshDepth();
    const id = setInterval(() => void refreshDepth(), POLL_INTERVAL_MS);
    const onTick = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ status?: SyncStatus; at?: string }>)
        .detail;
      if (detail?.status) setStatus(detail.status);
      if (detail?.at) setLastSyncAt(detail.at);
      void refreshDepth();
    };
    window.addEventListener(SYNC_WORKER_EVENT, onTick as EventListener);
    return () => {
      clearInterval(id);
      window.removeEventListener(SYNC_WORKER_EVENT, onTick as EventListener);
    };
  }, [refreshDepth]);

  const value = useMemo<SyncContextValue>(
    () => ({ status, queueDepth, lastSyncAt, nudge }),
    [status, queueDepth, lastSyncAt, nudge],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error('useSync must be used inside <SyncProvider>');
  }
  return ctx;
}

export default SyncProvider;
