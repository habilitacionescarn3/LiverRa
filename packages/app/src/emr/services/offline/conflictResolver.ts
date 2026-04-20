// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * conflictResolver — merge-decision arbiter for US4 offline sync (T243).
 *
 * Plain-English: two surgeons in two tabs can edit the same mask. The
 * backend tags every write with a monotonic `last_modified_version` number
 * and rejects stale writes with HTTP 409. When the sync worker hits a 409 it
 * calls `resolve()`, which fires a DOM CustomEvent so the UI agent's
 * `ConflictResolutionModal` can render three choices: keep mine, keep
 * theirs, or manual merge. The worker awaits the user's decision event and
 * proceeds accordingly.
 *
 * Analogy: git's merge prompt, minus the terminal. Server-wins is the
 * default (FR-018c + plan.md §Conflict resolution) so that if the modal
 * times out we never silently overwrite peer work.
 *
 * Spec refs: FR-018c, plan.md §Offline reviewer-edit durability §Conflict
 * resolution, research §C.6.
 */

import { LIVERRA_ERROR_EVENTS } from '../errorClient';

/** Choices the user can make in the conflict modal. */
export type ConflictResolution = 'server_wins' | 'client_wins' | 'manual';

/** Payload shape the modal receives on `liverra:conflict-resolution`. */
export interface ConflictResolutionDetail {
  /** Sync-worker correlation id so the modal can target the right write. */
  conflictId: string;
  /** Analysis the conflict belongs to. */
  analysisId: string;
  /** What the user just tried to submit. */
  clientVersion: number;
  /** What the server has. */
  serverVersion: number;
  /** Optional payload snippets so the modal can show a diff hint. */
  clientPayload?: Record<string, unknown>;
  serverPayload?: Record<string, unknown>;
}

/** Event name the modal dispatches when the user picks an option. */
export const CONFLICT_DECISION_EVENT = 'liverra:conflict-decision';

/** Payload shape of the decision event (modal → worker). */
export interface ConflictDecisionDetail {
  conflictId: string;
  resolution: ConflictResolution;
}

/** How long we wait for the user before defaulting to server_wins. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ResolveInput {
  analysisId: string;
  clientVersion: number;
  serverVersion: number;
  clientPayload?: Record<string, unknown>;
  serverPayload?: Record<string, unknown>;
  /** Override the 30-s timeout (tests use a small value). */
  timeoutMs?: number;
}

/**
 * Open the conflict modal and await the user's decision.
 *
 * Defaults:
 *   - If no UI is mounted (SSR, test without listener) → resolves to
 *     `server_wins` immediately so the worker never blocks the queue.
 *   - If the user does not respond within `timeoutMs` → `server_wins`.
 *   - If the user picks `manual` → caller is responsible for opening the
 *     diff view; worker treats manual as "pause this entry" (keeps row
 *     with `needs-user` status; see syncWorker for retention semantics).
 */
export async function resolve(input: ResolveInput): Promise<ConflictResolution> {
  // Use a cryptographically-strong UUID for event correlation so concurrent
  // conflicts cannot collide on the decision channel.
  const conflictId = `conflict-${
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }`;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // SSR / test without window → default immediately.
  if (typeof window === 'undefined') {
    return 'server_wins';
  }

  return new Promise<ConflictResolution>((resolvePromise) => {
    let settled = false;

    const cleanup = (): void => {
      window.removeEventListener(
        CONFLICT_DECISION_EVENT,
        onDecision as EventListener,
      );
      clearTimeout(timer);
    };

    const settle = (value: ConflictResolution): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };

    const onDecision = (ev: Event): void => {
      const detail = (ev as CustomEvent<ConflictDecisionDetail>).detail;
      if (!detail || detail.conflictId !== conflictId) return;
      settle(detail.resolution);
    };

    window.addEventListener(CONFLICT_DECISION_EVENT, onDecision as EventListener);

    const timer = setTimeout(() => settle('server_wins'), timeoutMs);

    // Dispatch AFTER wiring the decision listener so a synchronous modal can
    // respond without racing.
    const detail: ConflictResolutionDetail & { conflictId: string } = {
      conflictId,
      analysisId: input.analysisId,
      clientVersion: input.clientVersion,
      serverVersion: input.serverVersion,
      clientPayload: input.clientPayload,
      serverPayload: input.serverPayload,
    };

    try {
      window.dispatchEvent(
        new CustomEvent(LIVERRA_ERROR_EVENTS.ConflictResolution, { detail }),
      );
    } catch {
      // If dispatch itself fails (e.g. jsdom without CustomEvent), fall
      // back to server_wins on next tick rather than hanging.
      settle('server_wins');
    }
  });
}

/** Synchronous helper the modal calls to signal a decision. */
export function submitDecision(detail: ConflictDecisionDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CONFLICT_DECISION_EVENT, { detail }));
}

export default { resolve, submitDecision, CONFLICT_DECISION_EVENT };
