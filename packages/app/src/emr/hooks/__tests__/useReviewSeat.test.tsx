// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useReviewSeat unit tests (T254).
 *
 * Plain-English: these tests exercise the two states the hook MUST
 * represent crisply for the UI layer:
 *   1. Happy acquire → `hasSeat=true`, `reviewId` populated.
 *   2. Concurrent acquire (409 seat-taken) → `hasSeat=false` AND the
 *      holder's display name surfaces for the merge/read-only banner.
 *
 * The hook is thin — most real logic lives in `ReviewSeatContext`.
 * We test them together with an injected HTTP client so the
 * fetch/apiClient layer is out of scope.
 *
 * Spec refs: FR-017a (reviewer seat collision UX).
 */

import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import {
  ReviewSeatProvider,
  type SeatHttpClient,
} from '../../contexts/ReviewSeatContext';
import { useReviewSeat } from '../useReviewSeat';

function wrapWith(client: SeatHttpClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ReviewSeatProvider httpClient={client}>
        {children}
      </ReviewSeatProvider>
    );
  };
}

describe('useReviewSeat', () => {
  it('acquires a seat on the happy path', async () => {
    const post = vi.fn().mockResolvedValue({
      review_id: 'r-1',
      analysis_id: 'a-1',
      seat_held_until: new Date(Date.now() + 60_000).toISOString(),
    });
    const client: SeatHttpClient = { post };
    const { result } = renderHook(() => useReviewSeat(), {
      wrapper: wrapWith(client),
    });

    await act(async () => {
      await result.current.acquire('a-1');
    });

    expect(result.current.hasSeat).toBe(true);
    expect(result.current.reviewId).toBe('r-1');
    expect(post).toHaveBeenCalledWith('/api/v1/reviews', {
      analysis_id: 'a-1',
    });
  });

  it('surfaces the holder on a 409 collision (merge-UI state)', async () => {
    const seatTakenBody = {
      type: 'https://liverra.ai/errors/seat-taken',
      status: 409,
      detail: 'Seat held by Dr. Beyer.',
      holder_display_name: 'Dr. Beyer',
    };
    const seatTakenResp = {
      status: 409,
      ok: false,
      json: () => Promise.resolve(seatTakenBody),
      clone() {
        return this;
      },
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type'
            ? 'application/problem+json'
            : null,
      },
    } as unknown as Response;
    const post = vi.fn().mockRejectedValue(seatTakenResp);
    const client: SeatHttpClient = { post };

    const { result } = renderHook(() => useReviewSeat(), {
      wrapper: wrapWith(client),
    });

    await act(async () => {
      try {
        await result.current.acquire('a-2');
      } catch {
        /* expected */
      }
    });

    expect(result.current.hasSeat).toBe(false);
    expect(result.current.holderDisplayName).toBe('Dr. Beyer');
  });
});
