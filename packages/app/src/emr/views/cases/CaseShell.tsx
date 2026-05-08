// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * CaseShell — layout route for `/cases/:id/*`.
 *
 * Plain-English: every screen inside a single case (detail, lesions,
 * refine, finalize) shares one "review seat" — a checkout-counter ticket
 * that says *this surgeon* is currently editing *this case*. If the seat
 * lived inside each view's own provider, walking from Refine → Finalize
 * would drop the ticket on the floor. Hoisting the provider to this shell
 * keeps the same ticket alive across every sub-route.
 *
 * Spec refs: FR-017a (reviewer seat + heartbeat policy).
 */

import type { ReactElement } from 'react';
import { Outlet } from 'react-router-dom';

import { ReviewSeatProvider } from '../../contexts/ReviewSeatContext';
import { SyncProvider } from '../../contexts/SyncContext';
import { RefinementUndoProvider } from '../../contexts/RefinementUndoContext';

export default function CaseShell(): ReactElement {
  return (
    <SyncProvider>
      <ReviewSeatProvider>
        <RefinementUndoProvider>
          <Outlet />
        </RefinementUndoProvider>
      </ReviewSeatProvider>
    </SyncProvider>
  );
}
