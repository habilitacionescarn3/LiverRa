// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useViewportSync — BroadcastChannel-based viewport state sync (PACS P4.5)
// ============================================================================
// Think of this hook as a walkie-talkie that two browser windows showing the
// same study can use to whisper "I just scrolled to slice 42, window/level is
// 400/40" to each other. Each window owns its own Cornerstone rendering engine
// — we only pipe the user's *intent* across the wire, never pixel data.
//
// Implementation notes:
//   - Channel name is namespaced by StudyInstanceUID so two unrelated studies
//     opened in two separate pop-outs don't talk to each other.
//   - Same-origin only (browser-enforced). Perfect — no cross-origin headaches.
//   - Heartbeat: a 1 Hz `HEARTBEAT` ping. peerConnected flips false after 3 s
//     of silence (other tab closed, navigated away, or crashed).
//   - Broadcasts are throttled to ≤30 Hz (33 ms min interval) so a fast
//     scroll wheel doesn't flood the channel.
//   - requestAnimationFrame drives the heartbeat — it naturally pauses when
//     the tab is hidden, which is the desired behaviour for an idle pop-out.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================================
// Public types
// ============================================================================

export interface ViewportSyncState {
  /** Index into the active stack viewport's imageIds array. */
  imageIdIndex: number;
  /** Window center (a.k.a. W/L "level"). */
  windowCenter: number;
  /** Window width (a.k.a. W/L "window"). */
  windowWidth: number;
  /** Cornerstone parallelScale or analogue. */
  zoom: number;
  /** Rotation in degrees. */
  rotation: number;
}

export interface UseViewportSyncReturn {
  /** Channel ID derived from studyInstanceUid. */
  channelId: string;
  /** Broadcast a partial state update to the other window. */
  broadcast: (state: Partial<ViewportSyncState>) => void;
  /** Latest state received from the other window (null if no peer yet). */
  remoteState: ViewportSyncState | null;
  /** Whether a peer window is currently connected (heartbeat ≤ 3s). */
  peerConnected: boolean;
}

// ============================================================================
// Internal wire-format
// ============================================================================

type SyncMessage =
  | { type: 'HEARTBEAT'; senderId: string; ts: number }
  | { type: 'STATE'; senderId: string; ts: number; state: Partial<ViewportSyncState> };

const HEARTBEAT_INTERVAL_MS = 1000;
const PEER_STALE_MS = 3000;
const MIN_BROADCAST_INTERVAL_MS = 33; // ≤30 Hz

/** Tiny random id so we can ignore our own broadcasts. */
function makeSenderId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Hook
// ============================================================================

export function useViewportSync(
  studyInstanceUid: string,
  enabled: boolean
): UseViewportSyncReturn {
  const channelId = `pacs-sync:${studyInstanceUid}`;
  const [remoteStateEntry, setRemoteStateEntry] = useState<{
    channelId: string;
    state: ViewportSyncState;
  } | null>(null);
  const [peerStatus, setPeerStatus] = useState<{ channelId: string; connected: boolean } | null>(null);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const senderIdRef = useRef<string>(makeSenderId());
  const lastBroadcastAtRef = useRef<number>(0);
  const lastPeerHeartbeatAtRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);

  // --------------------------------------------------------------------------
  // Open the channel + register listener + start heartbeat tick
  //
  // TAVI audit 2026-05-22 TEST1-1: merged the previous two-effect setup
  // (one for channel, one for heartbeat) so there is no race between effect
  // ordering. Refs alone don't trigger re-renders, so the previous
  // heartbeat effect could miss the moment `channelRef.current` flipped
  // from null → set when `studyInstanceUid` transitioned from empty → set
  // mid-session. Now the channel and the heartbeat live in the same
  // closure and start atomically.
  // --------------------------------------------------------------------------
  useEffect(() => {
    lastPeerHeartbeatAtRef.current = 0;
    lastBroadcastAtRef.current = 0;

    if (!enabled || !studyInstanceUid) {
      return;
    }
    // Guard against environments without BroadcastChannel (e.g. older jsdom).
    if (typeof BroadcastChannel === 'undefined') {
      return;
    }

    const channel = new BroadcastChannel(channelId);
    channelRef.current = channel;

    const handleMessage = (event: MessageEvent<SyncMessage>): void => {
      const msg = event.data;
      if (!msg || msg.senderId === senderIdRef.current) {
        return; // ignore our own echoes
      }
      lastPeerHeartbeatAtRef.current = Date.now();
      setPeerStatus((prev) =>
        prev?.channelId === channelId && prev.connected ? prev : { channelId, connected: true }
      );
      if (msg.type === 'STATE') {
        setRemoteStateEntry((prev) => {
          const previousState = prev?.channelId === channelId ? prev.state : undefined;
          return {
            channelId,
            state: {
              imageIdIndex: previousState?.imageIdIndex ?? 0,
              windowCenter: previousState?.windowCenter ?? 0,
              windowWidth: previousState?.windowWidth ?? 0,
              zoom: previousState?.zoom ?? 1,
              rotation: previousState?.rotation ?? 0,
              ...msg.state,
            },
          };
        });
      }
    };

    channel.addEventListener('message', handleMessage);

    // Start the 1 Hz heartbeat in the SAME effect — we know the channel is
    // live here and the closure-captured `channel` won't be reset by a
    // separate effect's cleanup ordering.
    let lastHeartbeatSentAt = 0;
    const tick = (): void => {
      const now = Date.now();
      // Send our heartbeat at ~1 Hz. First tick always fires
      // (lastHeartbeatSentAt = 0 → elapsed >> threshold).
      if (now - lastHeartbeatSentAt >= HEARTBEAT_INTERVAL_MS) {
        const msg: SyncMessage = { type: 'HEARTBEAT', senderId: senderIdRef.current, ts: now };
        try {
          channel.postMessage(msg);
        } catch (err) {
          console.warn('[useViewportSync] best-effort PACS operation failed:', err);
        }
        lastHeartbeatSentAt = now;
      }

      // Check peer staleness.
      const lastPeer = lastPeerHeartbeatAtRef.current;
      const isStale = lastPeer === 0 || now - lastPeer > PEER_STALE_MS;
      const connected = !isStale;
      setPeerStatus((prev) =>
        prev?.channelId === channelId && prev.connected === connected ? prev : { channelId, connected }
      );

      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      channel.removeEventListener('message', handleMessage);
      channel.close();
      channelRef.current = null;
    };
  }, [channelId, enabled, studyInstanceUid]);

  // --------------------------------------------------------------------------
  // Broadcast a partial state update (throttled).
  // --------------------------------------------------------------------------
  const broadcast = useCallback((state: Partial<ViewportSyncState>) => {
    const channel = channelRef.current;
    if (!channel) return;
    const now = Date.now();
    if (now - lastBroadcastAtRef.current < MIN_BROADCAST_INTERVAL_MS) {
      return;
    }
    lastBroadcastAtRef.current = now;
    const msg: SyncMessage = { type: 'STATE', senderId: senderIdRef.current, ts: now, state };
    try {
      channel.postMessage(msg);
    } catch (err) {
      console.warn('[useViewportSync] best-effort PACS operation failed:', err);
    }
  }, []);

  const hasActiveChannel = enabled && !!studyInstanceUid;
  const remoteState =
    hasActiveChannel && remoteStateEntry?.channelId === channelId ? remoteStateEntry.state : null;
  const peerConnected =
    hasActiveChannel && peerStatus?.channelId === channelId ? peerStatus.connected : false;

  return { channelId, broadcast, remoteState, peerConnected };
}
