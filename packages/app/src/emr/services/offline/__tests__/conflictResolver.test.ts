// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * conflictResolver unit tests (T255).
 *
 * Plain-English: validate three deterministic properties of the
 * resolver:
 *   1. It dispatches a `ConflictResolution` CustomEvent so the modal
 *      can render.
 *   2. It awaits a decision CustomEvent and resolves with that choice.
 *   3. It defaults to `server_wins` on timeout (no user action).
 *
 * Why in a dedicated test: the sync worker's 409 code path calls
 * `resolve()`; regressions here corrupt the offline outbox semantics.
 *
 * Spec refs: FR-018c.
 */

import { describe, expect, it } from 'vitest';

import {
  CONFLICT_DECISION_EVENT,
  resolve,
  submitDecision,
  type ConflictResolutionDetail,
} from '../conflictResolver';
import { LIVERRA_ERROR_EVENTS } from '../../errorClient';

describe('conflictResolver.resolve', () => {
  it('dispatches a ConflictResolution event and returns the decision', async () => {
    let received: (ConflictResolutionDetail & { conflictId: string }) | null =
      null;
    const handler = (ev: Event): void => {
      received = (
        ev as CustomEvent<ConflictResolutionDetail & { conflictId: string }>
      ).detail;
      // Simulate modal → decision.
      submitDecision({
        conflictId: received.conflictId,
        resolution: 'client_wins',
      });
    };
    window.addEventListener(
      LIVERRA_ERROR_EVENTS.ConflictResolution,
      handler,
    );

    const decision = await resolve({
      analysisId: 'a-1',
      clientVersion: 3,
      serverVersion: 4,
      timeoutMs: 1000,
    });

    expect(received).not.toBeNull();
    expect(received!.analysisId).toBe('a-1');
    expect(decision).toBe('client_wins');
    window.removeEventListener(
      LIVERRA_ERROR_EVENTS.ConflictResolution,
      handler,
    );
  });

  it('defaults to server_wins on timeout', async () => {
    const decision = await resolve({
      analysisId: 'a-2',
      clientVersion: 1,
      serverVersion: 2,
      timeoutMs: 50,
    });
    expect(decision).toBe('server_wins');
  });

  it('ignores decision events with a mismatched conflictId', async () => {
    // Fire a stray decision BEFORE resolve — should not affect anything.
    window.dispatchEvent(
      new CustomEvent(CONFLICT_DECISION_EVENT, {
        detail: { conflictId: 'stale', resolution: 'client_wins' },
      }),
    );

    const decision = await resolve({
      analysisId: 'a-3',
      clientVersion: 1,
      serverVersion: 2,
      timeoutMs: 50,
    });
    expect(decision).toBe('server_wins');
  });
});
