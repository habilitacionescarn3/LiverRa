// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRPageSyncSlot (T250 wiring slot).
 *
 * Plain-English: a one-liner the app shell mounts in its top bar to
 * surface the online/offline/syncing pill (`SyncIndicator`) and the
 * two global modals that offline-aware surfaces rely on —
 * `ConflictResolutionModal` + `TakeoverRequestToast`. Wrapping the
 * three widgets in a single slot keeps `EMRPage.tsx` (owned by a
 * sibling agent) untouched.
 *
 * The slot also starts/stops the background `syncWorker` for the
 * lifetime of the session.
 *
 * Integration instructions (add to EMRPage.tsx when ready):
 *
 *   import { EMRPageSyncSlot } from '../EMRPageSyncSlot';
 *   ...
 *   <SyncProvider>
 *     <ReviewSeatProvider>
 *       <RefinementUndoProvider>
 *         <AppShell header={<Header rightSlot={<EMRPageSyncSlot />} />}>
 *           ...
 *         </AppShell>
 *       </RefinementUndoProvider>
 *     </ReviewSeatProvider>
 *   </SyncProvider>
 *
 * Spec refs: FR-018c (offline durability), FR-017a (takeover toast),
 * plan §Offline reviewer-edit durability.
 */

import { useEffect, type ReactElement } from 'react';

import { ConflictResolutionModal } from './components/offline/ConflictResolutionModal';
import { SyncIndicator } from './components/nav/SyncIndicator';
import { TakeoverRequestToast } from './components/liver/TakeoverRequestToast';
import { startSyncWorker } from './services/offline/syncWorker';

export interface EMRPageSyncSlotProps {
  /** Pass `false` in tests that stub the worker themselves. */
  autoStartWorker?: boolean;
}

export function EMRPageSyncSlot({
  autoStartWorker = true,
}: EMRPageSyncSlotProps = {}): ReactElement {
  useEffect(() => {
    if (!autoStartWorker) return undefined;
    const stop = startSyncWorker();
    return stop;
  }, [autoStartWorker]);

  return (
    <>
      <SyncIndicator />
      <ConflictResolutionModal />
      <TakeoverRequestToast />
    </>
  );
}

export default EMRPageSyncSlot;
