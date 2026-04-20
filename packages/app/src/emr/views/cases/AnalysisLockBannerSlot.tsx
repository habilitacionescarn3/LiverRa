// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AnalysisLockBannerSlot (T251 wiring slot).
 *
 * Plain-English: mount this inside `AnalysisDetailView` just above the
 * 3D viewer. It reads the live seat state and renders the existing
 * `RecordLockBanner` in two distinct modes:
 *
 *   - ``isLocked=true``  → red "another reviewer is editing" banner
 *                          (shown when the current user does NOT hold
 *                          the seat).
 *   - ``isLocked=false`` → blue "X minutes remaining" banner (shown
 *                          when the current user DOES hold the seat).
 *
 * Keeping the wiring in a side file means we never edit
 * `AnalysisDetailView.tsx` directly (owned by a sibling agent).
 *
 * Spec refs: FR-017a, plan §Review seat concurrency.
 */

import { useMemo, type ReactElement } from 'react';

import { RecordLockBanner, type RecordLockStatus } from '../../components/access-control/RecordLockBanner';
import { useReviewSeatContext } from '../../contexts/ReviewSeatContext';

export interface AnalysisLockBannerSlotProps {
  analysisId: string;
  /** Override capability flag — admins can force-release a stale seat. */
  canOverride?: boolean;
  onOverride?: () => void;
}

export function AnalysisLockBannerSlot({
  analysisId,
  canOverride = false,
  onOverride,
}: AnalysisLockBannerSlotProps): ReactElement | null {
  const seat = useReviewSeatContext();

  const status = useMemo<RecordLockStatus>(() => {
    const isLocked = !seat.hasSeat && Boolean(seat.holderDisplayName);
    const remaining = seat.seatHeldUntil
      ? Math.max(0, new Date(seat.seatHeldUntil).getTime() - Date.now())
      : 0;
    return {
      isLocked,
      timeRemainingMs: seat.hasSeat ? remaining : 0,
      canOverride,
    };
  }, [seat.hasSeat, seat.holderDisplayName, seat.seatHeldUntil, canOverride]);

  // Only render when there is signal — avoids an empty blue banner when
  // the reviewer is idle and no one else is holding the seat either.
  if (seat.analysisId && seat.analysisId !== analysisId) {
    return null;
  }
  if (!status.isLocked && status.timeRemainingMs === 0) {
    return null;
  }

  return <RecordLockBanner status={status} onOverride={onOverride} />;
}

export default AnalysisLockBannerSlot;
